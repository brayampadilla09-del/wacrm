/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  classifyFlowIntent,
  classifyMenuOptionIntent,
  classifyCancelIntent,
} from "./ai-router";
import { assistOffScriptReply, aiAutoReplyWillAnswer } from "./ai-assist";
import { recordHandoffSummary } from "@/lib/ai/summary";
import type { HandoffReason } from "@/lib/ai/handoff";
import type { FlowStepContext } from "@/lib/ai/defaults";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { isDeliverableUrl } from "@/lib/webhooks/ssrf";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowFallbackPolicy,
  type FlowRunRow,
  type HttpFetchNodeConfig,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    if (cfg.dynamic) {
      // Every dynamic row shares one next_node_key (rows aren't known at
      // authoring time) — trust the reply_id Meta just echoed back from
      // the list we sent moments ago.
      return cfg.dynamic.next_node_key;
    }
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Best-effort match of a typed free-text reply against a
 * send_buttons/send_list node's option titles. Customers often type
 * "no gracias" instead of tapping the actual button — without this,
 * that reply matches nothing, so `handleReplyForActiveRun` falls
 * through to the fallback policy (reprompt/handoff/end) instead of
 * advancing like a real tap would.
 *
 * Case/accent-insensitive; matches when the (normalized) reply equals
 * an option's title, or one contains the other ("no" matching
 * "No, gracias"). Dynamic send_list rows aren't known at match time
 * (they come from a prior http_fetch), so text fallback only covers
 * static buttons/rows. Returns null — not a guess — when zero or more
 * than one option matches, so an ambiguous reply still falls through
 * to the fallback policy rather than picking the wrong branch.
 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // acentos
    .replace(/[^\p{L}\p{N}\s]/gu, "") // puntuación ("no gracias" debe calzar con "No, gracias")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchButtonTextReply(
  node: { node_type: string; config: Record<string, unknown> },
  text: string,
): string | null {
  const needle = normalizeText(text);
  if (!needle) return null;

  let options: { reply_id: string; title: string }[] = [];
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    options = (cfg.buttons ?? []).map((b) => ({
      reply_id: b.reply_id,
      title: b.title,
    }));
  } else if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    if (cfg.dynamic) return null;
    for (const section of cfg.sections ?? []) {
      for (const row of section.rows ?? []) {
        options.push({ reply_id: row.reply_id, title: row.title });
      }
    }
  } else {
    return null;
  }

  const hits = options.filter((o) => {
    const title = normalizeText(o.title);
    return title === needle || title.includes(needle) || needle.includes(title);
  });
  return hits.length === 1 ? hits[0].reply_id : null;
}

/**
 * Common Spanish/English phrasings for "stop doing this" — checked
 * before any node-type-specific reply matching in
 * `handleReplyForActiveRun` so an explicit cancel request never gets
 * swallowed as literal `collect_input` data (e.g. captured as the
 * customer's "name") or lost as an unmatched button tap. Same
 * normalization as `matchButtonTextReply` so "Ya no quiero, cancélalo"
 * matches via both "ya no quiero" and "cancelalo".
 *
 * Two lists on purpose. CANCEL_PHRASES are unambiguous anywhere in the
 * message. CANCEL_WHOLE_MESSAGE are short words that also show up in
 * perfectly normal answers ("ya no puedo el martes, mejor el jueves",
 * "mejor no el lunes") — a contains-match on those ended the run in the
 * middle of a reschedule, so they only count when they ARE the message.
 */
const CANCEL_PHRASES = [
  "cancelar",
  "cancela",
  "cancelalo",
  "ya no quiero",
  "olvidalo",
  "no quiero continuar",
  "no quiero seguir",
  "dejalo asi",
  "nevermind",
  "never mind",
];

const CANCEL_WHOLE_MESSAGE = [
  "ya no",
  "detener",
  "detenlo",
  "para ya",
  "mejor no",
  "stop",
  "cancel",
  "salir",
];

export function matchesCancelIntentKeyword(text: string): boolean {
  const needle = normalizeText(text);
  if (!needle) return false;
  if (CANCEL_WHOLE_MESSAGE.includes(needle)) return true;
  return CANCEL_PHRASES.some((k) => needle.includes(k));
}

/**
 * How long after a human agent types in a conversation the bot stays
 * out of it. Without this, a customer answering the agent with
 * "hola, sí, una cita el jueves" matched the flow's entry keywords
 * ("hola", "cita") and the bot barged into the human conversation with
 * its welcome image and menu.
 */
const HUMAN_TAKEOVER_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Serializes a value as the *inside* of a JSON string literal. Used for
 * http_fetch body templates, where `{{contact.full_name}}` sits between
 * quotes: a customer-typed quote, backslash or line break would
 * otherwise produce invalid JSON (the request fails) or let the text
 * inject extra fields into the payload.
 */
function jsonStringEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Stable synthetic reply_id for the "customer wants to cancel" option
 *  appended to the real menu options sent to `classifyMenuOptionIntent`
 *  — never a real button/row id, so it can't collide with one. */
const CANCEL_REPLY_ID = "__flow_cancel__";

/**
 * List a send_buttons/send_list node's options in the shape the AI
 * menu-option classifier needs. Dynamic send_list rows aren't known
 * statically (they come from a prior http_fetch) — same limitation
 * `matchButtonTextReply` has — so those return an empty list, which
 * short-circuits `classifyMenuOptionIntent` to a no-op.
 */
function collectNodeOptions(node: {
  node_type: string;
  config: Record<string, unknown>;
}): { reply_id: string; title: string; description?: string }[] {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    return (cfg.buttons ?? []).map((b) => ({
      reply_id: b.reply_id,
      title: b.title,
    }));
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    if (cfg.dynamic) return [];
    const options: { reply_id: string; title: string; description?: string }[] = [];
    for (const section of cfg.sections ?? []) {
      for (const row of section.rows ?? []) {
        options.push({
          reply_id: row.reply_id,
          title: row.title,
          description: row.description,
        });
      }
    }
    return options;
  }
  return [];
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * True when a message typed while a run waits on a menu is an explicit
 * "start over": a short message (at most 3 words) that IS one of the
 * flow's trigger keywords or starts with one ("hola", "hola bimi",
 * "menú por favor"). The restart check used the entry trigger's
 * contains-match, which restarted runs on ordinary answers that merely
 * mention a keyword: "Sí, confirmo la cita" matched "cita" and threw
 * away a booking at its confirmation step.
 */
export function isExplicitRestartRequest(
  text: string,
  keywords: string[] | undefined,
): boolean {
  const needle = normalizeText(text);
  if (!needle || needle.split(" ").length > 3) return false;
  return (keywords ?? []).some((raw) => {
    const keyword = normalizeText(raw ?? "");
    return !!keyword && (needle === keyword || needle.startsWith(`${keyword} `));
  });
}

/**
 * Minimum age (ms) a `flow_runs` row must have before a same-contact
 * keyword message is honored as a restart request (see the restart
 * block in `handleReplyForActiveRun`). Long enough to stop a tight
 * retry loop, short enough that a genuine "let me start over" seconds
 * later still works.
 */
const RESTART_COOLDOWN_MS = 5_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Lenient free-text phone: allow +, spaces, dashes, parens/digits; the
// digit-count check below (not this regex alone) rejects short junk.
const PHONE_RE = /^\+?[\d\s\-().]{7,20}$/;

/**
 * Validate a `collect_input` reply against its configured
 * `validation` rule. Assumes the caller already filtered out empty
 * text. A malformed `regex` (invalid pattern authored in the builder)
 * fails OPEN — treated as valid — so a typo in an admin's regex can't
 * silently strand every customer hitting that node; validate.ts (the
 * flow-save validator) is the right place to catch bad patterns
 * up front.
 */
export function validateCollectInput(
  validation: CollectInputNodeConfig["validation"],
  regex: string | undefined,
  text: string,
): boolean {
  switch (validation) {
    case "email":
      return EMAIL_RE.test(text);
    case "phone":
      return PHONE_RE.test(text) && text.replace(/\D/g, "").length >= 7;
    case "regex": {
      if (!regex) return true;
      try {
        return new RegExp(regex).test(text);
      } catch {
        return true;
      }
    }
    case "any":
    default:
      return true;
  }
}

/**
 * User-facing hint shown when a `collect_input` reply fails
 * validation (or is empty). Replaces the generic "elige una de las
 * opciones de abajo" clarify text — there are no buttons on a
 * collect_input node, so that copy would confuse the customer.
 */
function collectInputValidationHint(
  validation: CollectInputNodeConfig["validation"],
): string {
  switch (validation) {
    case "email":
      return "Ese correo no parece válido 🙏 ¿Puedes escribirlo de nuevo? (ej: nombre@dominio.com)";
    case "phone":
      return "Ese número no parece válido 🙏 ¿Puedes escribirlo de nuevo incluyendo el indicativo?";
    case "regex":
      return "Ese formato no es el que esperamos 🙏 ¿Puedes intentarlo de nuevo?";
    default:
      return "Disculpa, no logré entender tu mensaje 🙏 ¿Puedes intentarlo de nuevo?";
  }
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "http_fetch"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

/**
 * True when a person typed in this conversation within
 * HUMAN_TAKEOVER_WINDOW_MS (templates excluded: pagina-estudio's API
 * sends are always templates). Shared with the AI auto-reply, which
 * must stay out of a thread an agent is working just like a new flow
 * run does.
 */
export async function hasRecentAgentMessage(
  db: AdminClient,
  conversationId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - HUMAN_TAKEOVER_WINDOW_MS).toISOString();
  const { count } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("sender_type", "agent")
    .neq("content_type", "template")
    .gte("created_at", since);
  return (count ?? 0) > 0;
}

/**
 * True when a person owns this conversation right now, so a new flow
 * run must not start (an active run is already paused the moment an
 * agent sends, see send-message.ts — this covers the *next* inbound,
 * which would otherwise re-trigger the bot on words like "hola"/"cita").
 *
 * A person owns it when, within HUMAN_TAKEOVER_WINDOW_MS:
 *   - an agent typed a message in it (sender_type 'agent' and not a
 *     template: pagina-estudio's API sends are always templates), or
 *   - the bot handed it off and it is still waiting in 'pending'.
 * Closing the conversation hands it back to the bot immediately (the
 * caller skips this check when it was closed before this inbound).
 */
async function isHumanHandlingConversation(
  db: AdminClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  const { data: conv } = await db
    .from("conversations")
    .select("status")
    .eq("id", conversationId)
    .maybeSingle();
  const status = (conv as { status?: string } | null)?.status;

  if (await hasRecentAgentMessage(db, conversationId)) return true;

  if (status === "pending") {
    const { data: lastRun } = await db
      .from("flow_runs")
      .select("status, ended_at")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const run = lastRun as { status?: string; ended_at?: string | null } | null;
    if (
      run?.status === "handed_off" &&
      run.ended_at &&
      new Date(run.ended_at).getTime() >= Date.now() - HUMAN_TAKEOVER_WINDOW_MS
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The active keyword-triggered flow on this channel whose keywords the
 * message explicitly restarts with (see isExplicitRestartRequest), or
 * null. Deterministic on purpose: no AI intent classifier here.
 */
async function findExplicitRestartFlow(
  db: AdminClient,
  accountId: string,
  channelId: string,
  text: string,
): Promise<FlowRow | null> {
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("channel_id", channelId)
    .eq("status", "active")
    .eq("trigger_type", "keyword")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;
  for (const flow of flows as FlowRow[]) {
    const cfg = flow.trigger_config as KeywordTriggerConfig;
    if (isExplicitRestartRequest(text, cfg.keywords)) return flow;
  }
  return null;
}

/** Openers that make a message a question even without "?" — customers
 *  on WhatsApp often skip the marks ("que es la cita de descubrimiento"). */
const QUESTION_OPENER =
  /^(que|como|cuanto|cuanta|cuantos|cuantas|cual|cuales|donde|cuando|quien|quienes|por que|para que|de que|en que)\b/;

/**
 * A message asking for information rather than picking an option or
 * giving the data a step asked for: "¿Qué es la cita de descubrimiento?",
 * "cuanto cuesta sueño". Such a message must not be matched literally
 * against option titles (it names the option it asks about), nor read as
 * a cancel request ("¿cómo cancelo?"), nor captured as a name.
 */
export function looksLikeQuestion(text: string): boolean {
  if (/[?¿]/.test(text)) return true;
  return QUESTION_OPENER.test(normalizeText(text));
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  channelId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  /**
   * The message is a question and the AI auto-reply will answer it if no
   * flow takes it. Then only an explicit restart ("hola", "menú") or the
   * AI intent classifier may start a flow: a contains-match on "cita"
   * restarted the menu on "La cita de descubrimiento, ¿qué es?" and the
   * question was never answered.
   */
  questionForAi = false,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Pull all active flows for this account+channel (migration 039 — an
  // account's two numbers run independent flows). Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("channel_id", channelId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  const keywordCandidates: FlowRow[] = [];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      // `also_on_first_message`: a brand-new contact whose first message
      // happens to contain none of the keywords ("Buen día, quisiera
      // cotizar") would otherwise get no reply at all.
      const hit = questionForAi
        ? isExplicitRestartRequest(message.text, cfg.keywords)
        : matchesKeywordTrigger(message.text, cfg) ||
          (isFirstInbound && cfg.also_on_first_message === true);
      if (hit) return flow;
      keywordCandidates.push(flow);
    } else if (
      flow.trigger_type === "first_inbound_message" &&
      isFirstInbound &&
      !questionForAi
    ) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }

  // No literal keyword hit. Ask the account's configured AI model (if
  // any) whether the message's intent matches one of the keyword-trigger
  // flows anyway — e.g. "necesito una cita para el jueves" against a flow
  // whose keywords are just ["agendar", "cita"], or a plain "buenas
  // tardes" against a welcome flow keyed on "hola"/"hi". See ai-router.ts
  // for why this doesn't weaken the "flows win" precedence — it only
  // widens the match; classifyFlowIntent no-ops (returns null) when the
  // account has no AI configured or its master switch is off, so an
  // account without AI set up behaves exactly as before.
  if (keywordCandidates.length > 0) {
    const matchedId = await classifyFlowIntent(
      db,
      accountId,
      message.text,
      keywordCandidates.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description,
      })),
    );
    if (matchedId) {
      const matchedFlow = keywordCandidates.find((f) => f.id === matchedId);
      if (matchedFlow) return matchedFlow;
    }
  }

  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  contact?: { phone?: string; name?: string; email?: string; full_name?: string },
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars, contact),
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  contact?: { phone?: string; name?: string; email?: string; full_name?: string },
): Promise<
  | { outcome: "advanced"; node_key: string }
  | { outcome: "empty_fallback"; next_node_key: string }
> {
  const cfg = node.config as unknown as SendListNodeConfig;

  let sections: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;

  if (cfg.dynamic) {
    // A selection captured by an earlier pass through this list (a
    // previous attempt in the same run) must not survive into this one:
    // when the list comes back empty the flow falls through to a
    // free-text fallback, and the stale slot id from the first attempt
    // was being submitted alongside the new free-text request.
    const cleared = withoutVars(run.vars, [
      cfg.dynamic.capture_id_var,
      cfg.dynamic.capture_title_var,
    ]);
    if (cleared) {
      const { error: clearErr } = await db
        .from("flow_runs")
        .update({ vars: cleared })
        .eq("id", run.id);
      if (!clearErr) run.vars = cleared;
    }

    const rows = resolveVarArray(run.vars, cfg.dynamic.rows_var);
    if (rows.length === 0) {
      // Meta rejects a 0-row interactive list — degrade to a plain
      // message and let the caller route to empty_next_node_key
      // (typically a free-text collect_input fallback) instead of
      // suspending on a list that was never sent.
      const { whatsapp_message_id } = await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: interpolateVars(cfg.text, run.vars, contact),
      });
      await logEvent(db, run.id, "message_sent", node.node_key, {
        node_type: "send_list",
        whatsapp_message_id,
        dynamic_rows: 0,
      });
      return {
        outcome: "empty_fallback",
        next_node_key: cfg.dynamic.empty_next_node_key,
      };
    }
    sections = [{ rows }];
  } else {
    sections = cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    }));
  }

  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections,
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

/**
 * In-memory run var carrying WHY an automatic handoff was routed
 * through the flow's handoff path (see `routeToHandoff`), so the
 * `handoff` node at the end of that path can label the team's summary.
 * Leading underscore: internal, never shown as captured data.
 */
const HANDOFF_REASON_VAR = "_handoff_reason";

const HANDOFF_REASONS: HandoffReason[] = [
  "flow_node",
  "flow_fallback",
  "ai_unsure",
  "ai_limit",
  "manual",
];

function handoffReasonOf(run: FlowRunRow): HandoffReason {
  const raw = run.vars?.[HANDOFF_REASON_VAR];
  return HANDOFF_REASONS.includes(raw as HandoffReason)
    ? (raw as HandoffReason)
    : "flow_node";
}

/**
 * Leave a summary for the team on a conversation that just left the
 * bot (inbox banner + contact note). Best-effort: `recordHandoffSummary`
 * never throws, and a missing conversation/contact just skips it.
 */
async function summarizeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  reason: HandoffReason,
  note: string | null,
): Promise<void> {
  if (!run.conversation_id || !run.contact_id) return;
  await recordHandoffSummary(db, {
    accountId: run.account_id,
    conversationId: run.conversation_id,
    contactId: run.contact_id,
    authorUserId: run.user_id,
    reason,
    vars: run.vars,
    note,
  });
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const reason = handoffReasonOf(run);
  const convUpdate: Record<string, unknown> = {
    // Without an in-CRM assignee, this handoff's message sends the
    // customer to a *different* WhatsApp chat (see the "asesor_msg"
    // node — a wa.me link to the team's own number); nobody is going to
    // answer inside this conversation, so leaving it "pending" just
    // stranded it forever (isHumanHandlingConversation blocks the bot
    // for 12h, and ai_autoreply_disabled has no time-based reset — see
    // resetConversationAiState). Closing it lets the very next inbound
    // reopen it fresh (webhook route's "reopen a closed conversation"
    // branch), so the bot picks back up instead of staying mute.
    // With an assign_to, a person IS expected to answer here, so the
    // existing "pending" semantics still apply.
    status: cfg.assign_to ? "pending" : "closed",
    // The team owns the thread now: keep the AI auto-reply out of it
    // until someone resumes it, closes the conversation, or a new flow
    // run starts (see resetConversationAiState).
    ai_autoreply_disabled: true,
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
    reason,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
  // The node's note describes the path that leads to it (e.g. "the
  // customer asked for an advisor"); automatic handoffs reuse the same
  // path for its customer message, so the note would mislabel them.
  await summarizeHandoff(db, run, reason, reason === "flow_node" ? (cfg.note ?? null) : null);
}

/**
 * Hand an active run's conversation to the team for an automatic
 * reason (reprompts exhausted, AI unsure, AI budget spent). Routes
 * through the flow's `fallback_policy.handoff_node_key` when set, so
 * the customer is told what happens next; otherwise falls back to the
 * silent flip to `pending`, still leaving the team a summary.
 */
async function routeToHandoff(
  db: AdminClient,
  run: FlowRunRow,
  nodes: Map<string, FlowNodeRow>,
  policy: FlowFallbackPolicy,
  reason: HandoffReason,
): Promise<DispatchInboundResult> {
  run.vars = { ...run.vars, [HANDOFF_REASON_VAR]: reason };
  const key = policy.handoff_node_key;
  if (key && nodes.has(key)) {
    await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
      action: "handoff_path",
      reason,
      handoff_node_key: key,
    });
    const outcome = await advanceFromNodeKey(db, run, key, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome === "advanced" ? "fallback_fired" : outcome.outcome,
    };
  }

  if (run.conversation_id) {
    await db
      .from("conversations")
      .update({
        status: "pending",
        ai_autoreply_disabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", run.current_node_key, { reason });
  await endRun(
    db,
    run.id,
    "handed_off",
    reason === "flow_fallback" ? "fallback_exhausted" : reason,
  );
  await summarizeHandoff(db, run, reason, null);
  return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
}

/**
 * A new flow run means the bot owns the conversation again: give the
 * AI a fresh reply budget and lift a pause left by an earlier handoff
 * (a person handling it blocks new runs in the first place, see
 * isHumanHandlingConversation).
 */
async function resetConversationAiState(
  db: AdminClient,
  conversationId: string,
): Promise<void> {
  const { error } = await db
    .from("conversations")
    .update({
      ai_reply_count: 0,
      ai_autoreply_disabled: false,
      ai_handoff_summary: null,
    })
    .eq("id", conversationId);
  if (error) console.error("[flows] reset AI state failed:", error.message);
}

type RunContact = { phone?: string; name?: string; email?: string; full_name?: string };

/** Contact fields `interpolateVars` reads, for a run's contact. */
async function loadRunContact(
  db: AdminClient,
  run: FlowRunRow,
): Promise<RunContact | undefined> {
  if (!run.contact_id) return undefined;
  const { data } = await db
    .from("contacts")
    .select("phone, name, email, full_name")
    .eq("id", run.contact_id)
    .maybeSingle();
  return data
    ? { phone: data.phone, name: data.name, email: data.email, full_name: data.full_name }
    : undefined;
}

/**
 * Options offered by a send_buttons/send_list step, including the rows
 * of a dynamic list (resolved from the vars the list was built from),
 * so both the option classifier and the AI assist see what the
 * customer actually has on screen.
 */
function stepOptions(
  node: FlowNodeRow,
  vars: Record<string, unknown>,
): { reply_id: string; title: string; description?: string }[] {
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    if (cfg.dynamic) {
      return resolveVarArray(vars, cfg.dynamic.rows_var).map((r) => ({
        reply_id: r.id,
        title: r.title,
        description: r.description,
      }));
    }
  }
  return collectNodeOptions(node);
}

/** What the step asked + what it offered, for `flow_assist` mode. */
function describeStep(
  node: FlowNodeRow,
  vars: Record<string, unknown>,
  contact: RunContact | undefined,
): FlowStepContext {
  if (node.node_type === "collect_input") {
    const cfg = node.config as unknown as CollectInputNodeConfig;
    return {
      prompt: interpolateVars(cfg.prompt_text ?? "", vars, contact),
      expects: "text",
      options: [],
    };
  }
  const cfg = node.config as { text?: string };
  return {
    prompt: interpolateVars(cfg.text ?? "", vars, contact),
    expects: "choice",
    options: stepOptions(node, vars).map((o) => o.title),
  };
}

/**
 * Re-send the step the run is suspended on (after a clarification or an
 * AI answer) without moving `current_node_key`. Send failures are
 * logged, not thrown: the run stays where it was either way.
 */
async function resendStep(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  contact: RunContact | undefined,
): Promise<void> {
  try {
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, node, contact);
    } else if (node.node_type === "send_list") {
      await sendListAndSuspend(db, run, node, contact);
    } else if (node.node_type === "collect_input") {
      const cfg = node.config as unknown as CollectInputNodeConfig;
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: interpolateVars(cfg.prompt_text, run.vars, contact),
      });
    }
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "reprompt_send_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company/full_name on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company", "full_name"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` / `{{contact.phone}}` / `{{contact.name}}`
 * interpolation. Used by send_message + collect_input prompt text
 * (`contact` omitted there) so a captured `name` can show up in the
 * next prompt ("Thanks {{vars.name}}, what's your email?"), and by
 * http_fetch's body_template (`contact` passed) so it can reference the
 * WhatsApp contact's own phone/name without the customer having typed
 * it. Missing vars/fields render as empty string — same behavior as
 * the automations engine's `interpolate()`. `escape` is applied to each
 * substituted value (not the template itself) — http_fetch passes
 * `jsonStringEscape` so customer-typed text can't break the JSON body.
 */
function interpolateVars(
  template: string,
  vars: Record<string, unknown>,
  contact?: { phone?: string; name?: string; email?: string; full_name?: string },
  escape: (value: string) => string = (value) => value,
): string {
  if (!template) return "";
  return template.replace(
    /\{\{(vars|contact)\.([a-zA-Z0-9_]+)\}\}/g,
    (_, ns: string, key: string) => {
      if (ns === "contact") {
        const v = contact?.[key as "phone" | "name" | "email" | "full_name"];
        return escape((v ?? "").trim());
      }
      const v = vars[key];
      return escape(v === undefined || v === null ? "" : String(v));
    },
  );
}

/**
 * Returns a copy of `vars` without `keys`, or null when none of them
 * were set (so callers can skip a no-op DB write).
 */
function withoutVars(
  vars: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  if (!keys.some((k) => k in vars)) return null;
  const next = { ...vars };
  for (const k of keys) delete next[k];
  return next;
}

/**
 * Resolves a dot-path ("avail.options") against flow_runs.vars — used by
 * a dynamic send_list's `rows_var` to reach into a prior http_fetch's
 * captured response (`response_var`). Returns `[]` for any missing/
 * non-array segment rather than throwing — a malformed or not-yet-run
 * fetch just looks like "no options" to the caller.
 */
function resolveVarArray(
  vars: Record<string, unknown>,
  path: string,
): Array<{ id: string; title: string; description?: string }> {
  let cur: unknown = vars;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return [];
    cur = (cur as Record<string, unknown>)[segment];
  }
  return Array.isArray(cur)
    ? (cur as Array<{ id: string; title: string; description?: string }>)
    : [];
}

/**
 * Ends the active run when the customer signals they want to stop —
 * either via `matchesCancelIntentKeyword` or the AI cancel classifier.
 * Sends a short acknowledgement and marks the run `completed` (not
 * `handed_off` — the customer asked to stop, not to talk to a human;
 * see `executeHandoff` for that path), so "finalizar el chat" means the
 * flow session actually ends instead of sitting active waiting for a
 * reply that will never come to satisfy the old node.
 */
async function cancelActiveRun(
  db: AdminClient,
  run: FlowRunRow,
): Promise<DispatchInboundResult> {
  try {
    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      // Spells out that nothing was cancelled on the booking side: the
      // old "Listo, cancelo esto por ahora" read as "your appointment is
      // cancelled" to someone who typed "cancelar" meaning the appointment.
      text: "Listo, lo dejamos aquí por ahora 👍 Ojo: esto no cancela ninguna cita que ya tengas agendada. Si quieres cancelarla, escríbeme *menú* y elige «Cancelar mi cita». Cuando quieras retomar, solo escríbeme.",
    });
  } catch (err) {
    await logEvent(db, run.id, "error", run.current_node_key, {
      reason: "cancel_ack_send_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: "cancelled_by_customer",
  });
  await endRun(db, run.id, "completed", "cancelled_by_customer");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;

  // Fetched once per invocation (not per node) — every interpolateVars
  // call below shares it, so `{{contact.phone}}` / `{{contact.name}}`
  // work the same in send_message/collect_input/send_media/http_fetch.
  let contact: { phone?: string; name?: string; email?: string; full_name?: string } | undefined;
  if (run.contact_id) {
    const { data } = await db
      .from("contacts")
      .select("phone, name, email, full_name")
      .eq("id", run.contact_id)
      .maybeSingle();
    if (data) contact = { phone: data.phone, name: data.name, email: data.email, full_name: data.full_name };
  }

  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars, contact),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars, contact)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars, contact),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "http_fetch") {
      const cfg = node.config as unknown as HttpFetchNodeConfig;
      // What this call returned, when it succeeded with a JSON body.
      // Written to `response_var` after the call either way: set on
      // success, REMOVED on failure. Leaving the previous value in place
      // on failure made a retry look successful — e.g. a second
      // reschedule attempt that got a 409 still found `reschedule_result`
      // from the first one, and the flow told the customer "¡Listo!".
      let captured: unknown = undefined;
      try {
        // https-only, re-enforced here (not just at flow-save time in
        // validate.ts) in case an older flow was authored before this
        // rule existed — headers on this node often carry a bearer
        // secret, which must never travel over plaintext http.
        if (!/^https:\/\//i.test(cfg.url)) {
          throw new Error("destination must use https");
        }
        if (!(await isDeliverableUrl(cfg.url))) {
          throw new Error("destination not allowed");
        }
        const method = cfg.method ?? "POST";
        const body =
          method !== "GET" && cfg.body_template
            ? interpolateVars(cfg.body_template, run.vars, contact, jsonStringEscape)
            : undefined;
        const res = await fetch(cfg.url, {
          method,
          headers: { "content-type": "application/json", ...(cfg.headers ?? {}) },
          body,
          redirect: "manual",
          // 35s, not 10s: nodes like pagina-estudio's booking create/cancel
          // endpoints now deliberately await sending a WhatsApp template
          // before responding (so the Flow's own follow-up messages can't
          // race ahead of it) — that chain can take several seconds, and
          // those endpoints run with a 30s maxDuration. A shorter timeout
          // here would give up before they're done, making the Flow move
          // on to its next node while the "real" confirmation is still in
          // flight — the exact race this was meant to prevent. This
          // webhook route has its own maxDuration = 60, so there's room.
          signal: AbortSignal.timeout(35_000),
        });
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "http_fetch",
          status: res.status,
        });
        if (!res.ok) {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "http_fetch_non_ok",
            status: res.status,
          });
        } else if (cfg.response_var) {
          const contentType = res.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            const parsed = await res.json().catch(() => null);
            if (parsed !== null) captured = parsed;
          }
        }
      } catch (err) {
        // Non-fatal — same reasoning as set_tag above: a failed call
        // shouldn't strand the customer mid-conversation with no
        // reply. Log it and keep going.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "http_fetch_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      if (cfg.response_var) {
        const newVars =
          captured !== undefined
            ? { ...run.vars, [cfg.response_var]: captured }
            : withoutVars(run.vars, [cfg.response_var]);
        if (newVars) {
          const { error: capErr } = await db
            .from("flow_runs")
            .update({ vars: newVars })
            .eq("id", run.id);
          if (!capErr) run.vars = newVars;
        }
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      try {
        await sendButtonsAndSuspend(db, run, node, contact);
      } catch (err) {
        // Same reasoning as send_message/send_media above — without
        // this, a transient Meta API failure here throws uncaught all
        // the way to dispatchInboundToFlows' catch-all, which reports
        // consumed:false without ever ending the run. The run is left
        // "active" at whatever node_key it had *before* this attempt
        // (current_node_key is only written by advanceCurrentNodeKey
        // below, which never runs), so the customer is stuck replying
        // to a stale prompt forever with no visible reaction at all.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      let result: Awaited<ReturnType<typeof sendListAndSuspend>>;
      try {
        result = await sendListAndSuspend(db, run, node, contact);
      } catch (err) {
        // Same reasoning as send_buttons above.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      if (result.outcome === "empty_fallback") {
        currentKey = result.next_node_key;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run. Before starting one, make sure a person isn't
    // already handling this conversation (see isHumanHandlingConversation).
    if (
      input.conversationStatusBeforeInbound !== "closed" &&
      (await isHumanHandlingConversation(db, input.accountId, input.contactId, input.conversationId))
    ) {
      return { consumed: false, outcome: "no_match" };
    }

    // No active run → look for a flow whose entry trigger matches.
    const questionForAi =
      input.message.kind === "text" &&
      looksLikeQuestion(input.message.text) &&
      (await aiAutoReplyWillAnswer(db, input.accountId, input.conversationId));
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.channelId,
      input.message,
      input.isFirstInboundMessage,
      questionForAi,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

/**
 * Hand a conversation with NO active run to the team — the out-of-flow
 * AI auto-reply's exit when the model can't answer or the thread used
 * its AI reply budget (`src/lib/ai/auto-reply.ts`).
 *
 * Reuses the channel flow's handoff path (`fallback_policy.
 * handoff_node_key`, e.g. "te paso con el equipo, escríbenos aquí…" →
 * `handoff` node) through a short run that starts at that node, so the
 * customer gets the same message as any other handoff and the team the
 * same summary. Without such a flow the thread just goes to `pending`
 * with a summary, nothing sent.
 *
 * Idempotent per episode: the atomic flip of `ai_autoreply_disabled`
 * means two concurrent inbounds can't both send the handoff message.
 * Never throws.
 */
export async function handOffConversationToHuman(args: {
  accountId: string;
  channelId: string;
  contactId: string;
  conversationId: string;
  /** Fallback author for the summary note when no flow is involved. */
  configOwnerUserId: string;
  reason: HandoffReason;
}): Promise<void> {
  const db = supabaseAdmin();
  const { accountId, channelId, contactId, conversationId, reason } = args;
  try {
    const { data: claimed, error: claimErr } = await db
      .from("conversations")
      .update({ ai_autoreply_disabled: true })
      .eq("id", conversationId)
      .eq("ai_autoreply_disabled", false)
      .select("id");
    if (claimErr || !claimed || claimed.length === 0) return;

    const { data: flows } = await db
      .from("flows")
      .select("*")
      .eq("account_id", accountId)
      .eq("channel_id", channelId)
      .eq("status", "active")
      .order("created_at", { ascending: true });
    for (const flow of (flows ?? []) as FlowRow[]) {
      const key = resolveFallbackPolicy(flow.fallback_policy).handoff_node_key;
      if (!key) continue;
      const nodes = await loadAllNodes(db, flow.id);
      if (!nodes.has(key)) continue;
      const { data: inserted, error: insErr } = await db
        .from("flow_runs")
        .insert({
          flow_id: flow.id,
          account_id: flow.account_id,
          channel_id: flow.channel_id,
          user_id: flow.user_id,
          contact_id: contactId,
          conversation_id: conversationId,
          status: "active",
          current_node_key: key,
          vars: { [HANDOFF_REASON_VAR]: reason },
        })
        .select("*")
        .maybeSingle();
      // 23505 = a run became active meanwhile; fall through to the
      // plain handoff below rather than fight it.
      if (insErr || !inserted) break;
      const run = inserted as FlowRunRow;
      await logEvent(db, run.id, "started", key, {
        flow_id: flow.id,
        trigger_type: "ai_handoff",
        reason,
      });
      await advanceFromNodeKey(db, run, key, nodes);
      return;
    }

    await db
      .from("conversations")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    await recordHandoffSummary(db, {
      accountId,
      conversationId,
      contactId,
      authorUserId: args.configOwnerUserId,
      reason,
    });
  } catch (err) {
    console.error(
      "[flows] handOffConversationToHuman failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Cancel request — checked BEFORE any node-type-specific matching so it
  // takes priority everywhere, including a `collect_input` node (which
  // otherwise accepts any non-empty text as the answer it asked for — a
  // "ya no quiero, cancélalo" would silently get captured as the
  // customer's name/email without this). The keyword check is free and
  // catches explicit phrasings instantly; the AI check only runs for
  // collect_input (where "accept anything" makes a paraphrase the
  // riskiest to miss) and only when AI is configured/active for the
  // account — see ai-router.ts's classifyCancelIntent.
  const isButtonNode =
    currentNode.node_type === "send_buttons" ||
    currentNode.node_type === "send_list";

  // A question is an aside to answer, not a selection or a cancel: "¿Qué
  // es la cita de descubrimiento?" contains the option title "Cita de
  // descubrimiento" and was taken as a tap, dropping the customer into
  // the booking steps without ever answering them. Free-text prompts
  // (validation "any", e.g. "what day works for you?") are exempt: there
  // "¿el lunes a las 3?" IS the answer.
  const collectValidation =
    currentNode.node_type === "collect_input"
      ? ((currentNode.config as unknown as CollectInputNodeConfig).validation ?? "any")
      : null;
  const isQuestion =
    message.kind === "text" &&
    collectValidation !== "any" &&
    looksLikeQuestion(message.text);

  if (message.kind === "text" && !isQuestion) {
    // A typed reply that names one of the node's own options wins over
    // the cancel keywords: "cancelar mi cita" on the main menu (whose
    // option is literally "Cancelar mi cita") must go to the cancel-
    // appointment branch, not end the whole conversation.
    const namesAnOption =
      isButtonNode && matchButtonTextReply(currentNode, message.text) !== null;
    if (!namesAnOption && matchesCancelIntentKeyword(message.text)) {
      return cancelActiveRun(db, run);
    }
    if (currentNode.node_type === "collect_input") {
      const wantsCancel = await classifyCancelIntent(
        db,
        run.account_id,
        message.text,
      );
      if (wantsCancel) {
        return cancelActiveRun(db, run);
      }
    }
  }

  // Three ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Typed text that matches an option's title on that same kind of
  //      node ("no gracias" for a "No, gracias" button) — see
  //      matchButtonTextReply; customers reply in words as often as
  //      they tap, especially when replying to an older bubble.
  //   3. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  let resolvedReplyId: string | null =
    message.kind === "interactive_reply" && isButtonNode
      ? message.reply_id
      : message.kind === "text" && isButtonNode && !isQuestion
        ? matchButtonTextReply(currentNode, message.text)
        : null;

  // Free text that didn't tap a button and didn't literally match an
  // option title — try the account's configured AI model before falling
  // through to the restart-by-keyword check / fallback policy below.
  // Customers paraphrase ("quiero agendar una cita" for a button titled
  // "Agendar cita de diseño") in ways the literal contains-match above
  // can't catch; without this, that reply would fall through to
  // restart-by-keyword, which — when the flow's own entry keywords
  // overlap with its menu option words, as "agendar" typically does —
  // just restarts the same flow from its welcome message instead of
  // advancing. See ai-router.ts; this no-ops (stays null) when the
  // account has no AI configured/active.
  if (!resolvedReplyId && message.kind === "text" && isButtonNode) {
    // The synthetic "Cancelar" option folds cancel-intent detection into
    // this same AI call (instead of a second one) — if the free text
    // doesn't fit any real option but reads as "stop/cancel this", the
    // model picks it over guessing a real button.
    resolvedReplyId = await classifyMenuOptionIntent(
      db,
      run.account_id,
      message.text,
      [
        ...stepOptions(currentNode, run.vars),
        {
          reply_id: CANCEL_REPLY_ID,
          title: "Cancelar",
          description:
            "El cliente ya no quiere continuar con esto y prefiere terminar la conversación (dice algo como 'ya no quiero', 'cancela', 'déjalo así').",
        },
      ],
    );
  }

  if (resolvedReplyId === CANCEL_REPLY_ID) {
    return cancelActiveRun(db, run);
  }

  if (resolvedReplyId) {
    matched = matchReplyId(currentNode, resolvedReplyId);
    if (matched) {
      // Capture WHICH option was tapped, when the node asked for it —
      // dynamic rows (capture_title_var/capture_id_var, resolved from
      // the fetched array) and static rows/buttons (capture_var, a
      // single literal per row/button) both land in the same
      // flow_runs.vars update.
      const captures: Record<string, unknown> = {};
      if (currentNode.node_type === "send_list") {
        const cfg = currentNode.config as unknown as SendListNodeConfig;
        if (cfg.dynamic) {
          const rows = resolveVarArray(run.vars, cfg.dynamic.rows_var);
          const hit = rows.find((r) => r.id === resolvedReplyId);
          if (hit) {
            captures[cfg.dynamic.capture_title_var] = hit.title;
            captures[cfg.dynamic.capture_id_var] = hit.id;
          } else {
            // A tap on an OLDER copy of this list (an earlier page, or a
            // list from a previous attempt) — its row isn't in the rows
            // we just sent, so nothing would be captured and the flow
            // would move on to "confirm" with no slot picked. Treat it as
            // unmatched so the fallback re-sends the current options.
            await logEvent(db, run.id, "error", currentNode.node_key, {
              reason: "stale_dynamic_list_reply",
            });
            matched = null;
          }
        } else {
          for (const section of cfg.sections ?? []) {
            const row = section.rows?.find((r) => r.reply_id === resolvedReplyId);
            if (row?.capture_var) captures[row.capture_var] = row.title;
          }
        }
      } else {
        const cfg = currentNode.config as unknown as SendButtonsNodeConfig;
        const button = cfg.buttons?.find((b) => b.reply_id === resolvedReplyId);
        if (button?.capture_var) captures[button.capture_var] = button.title;
      }
      if (Object.keys(captures).length > 0) {
        const newVars = { ...run.vars, ...captures };
        const { error: capErr } = await db
          .from("flow_runs")
          .update({ vars: newVars })
          .eq("id", run.id);
        if (!capErr) run.vars = newVars;
      }
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input" &&
    !isQuestion
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    const isValid =
      captured.length > 0 &&
      validateCollectInput(cfg.validation, cfg.regex, captured);
    if (!isValid && captured.length > 0) {
      // Don't persist rejected text — no PAN/raw content in the log,
      // same reasoning as reply_received above; length is enough to
      // debug "why did this keep bouncing".
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "collect_input_validation_failed",
        validation: cfg.validation ?? "any",
        text_length: captured.length,
      });
    }
    if (isValid && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
      // Best-effort — remembering the answer on the contact itself so a
      // LATER run (a new conversation) can skip re-asking via
      // {{contact.x}} + a `contact_field present` condition. A failure
      // here must not affect the flow's own advance, which already
      // succeeded above.
      if (cfg.persist_to_contact_field && run.contact_id) {
        const { error: contactErr } = await db
          .from("contacts")
          .update({ [cfg.persist_to_contact_field]: captured })
          .eq("id", run.contact_id);
        if (contactErr) {
          await logEvent(db, run.id, "error", currentNode.node_key, {
            reason: "persist_to_contact_field_failed",
            detail: contactErr.message,
          });
        }
      }
    }
  }

  if (matched) {
    // Claim the run's current node BEFORE running any side effects. Two
    // taps on the same button (double-tap, or a slow first reply the
    // customer retries) arrive as two separate inbound messages —
    // different meta_message_id, so isDuplicateInbound's retry check
    // above doesn't catch them — and both reach this point having read
    // the SAME `run` row, still parked on `currentNode.node_key`.
    // Without a claim here, both calls would run advanceFromNodeKey
    // concurrently, and anything it does before its own next suspend
    // point (a send_message, a set_tag, and critically an http_fetch —
    // e.g. pagina-estudio's booking-create endpoint) fires twice. This
    // CAS is the same optimistic-lock primitive advanceCurrentNodeKey
    // already uses at suspend points; doing it here first means only
    // one of the two racing replies ever gets to execute the node
    // chain, and the loser is dropped as a duplicate instead of
    // creating a second booking.
    const claimed = await advanceCurrentNodeKey(
      db,
      run.id,
      run.current_node_key,
      matched,
    );
    if (!claimed) {
      await logEvent(db, run.id, "reply_received", currentNode.node_key, {
        reason: "duplicate_reply_lost_claim_race",
      });
      return {
        consumed: true,
        flow_run_id: run.id,
        outcome: "duplicate_inbound_ignored",
      };
    }
    run.current_node_key = matched;

    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // Antes de aplicar la política de fallback: si el contacto quedó "colgado"
  // en un nodo de botones/lista (típicamente anything_else, esperando un tap
  // que nunca llega) y ahora escribe un saludo o "menú", lo tratamos como un
  // pedido explícito de reiniciar la conversación en vez de solo re-mostrar
  // las mismas opciones — sin esto, cualquier active run viejo bloquea el
  // trigger por keyword de dispatchInboundToFlows indefinidamente (hasta el
  // timeout de 24h del cron), porque loadActiveRunForContact siempre gana
  // primero. Solo cuenta un mensaje corto que ES la keyword o empieza por
  // ella (isExplicitRestartRequest): con el contains-match del trigger,
  // "Sí, confirmo la cita" reiniciaba el flujo en plena confirmación. Y es
  // determinístico a propósito (sin el clasificador de IA de findEntryFlow),
  // porque la IA leía cualquier pregunta como "quiere el menú".
  //
  // Cooldown: cada restart termina el run activo y llama startNewRun, que
  // corre el advance loop entero desde cero (incluyendo cualquier
  // http_fetch/send del entry) — sin un piso mínimo, un contacto (o script)
  // que dispare la keyword de restart en bucle rápido reejecutaría esa
  // cadena tan rápido como WhatsApp entregue mensajes. RESTART_COOLDOWN_MS
  // se mide contra `started_at` del run activo — que un restart exitoso
  // siempre refresca — así que no hace falta una columna ni consulta nueva.
  const runAgeMs = Date.now() - new Date(run.started_at).getTime();
  if (message.kind === "text" && isButtonNode && runAgeMs >= RESTART_COOLDOWN_MS) {
    const restartFlow = await findExplicitRestartFlow(
      db,
      run.account_id,
      run.channel_id,
      message.text,
    );
    if (restartFlow?.entry_node_id) {
      await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
        action: "restarted_by_keyword",
        matched_flow_id: restartFlow.id,
      });
      await endRun(db, run.id, "completed", "restarted_by_keyword");
      const restartNodes = await loadAllNodes(db, restartFlow.id);
      return startNewRun(
        db,
        restartFlow,
        {
          accountId: run.account_id,
          channelId: run.channel_id,
          userId: run.user_id,
          contactId: run.contact_id!,
          conversationId: run.conversation_id!,
          message,
        },
        restartNodes,
      );
    }
  }

  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  // Same contact lookup as advanceFromNodeKey's — needed so a re-sent
  // step's {{contact.x}} interpolates the same as the first send did.
  const contact = await loadRunContact(db, run);

  // Off-script text nothing above could place: a question or comment
  // ("¿cuánto cuesta el plan Sueño?" on the main menu, "¿para qué el
  // correo?" when asked for an email). The AI answers it and the same
  // step goes out again, or — when it can't answer, or this thread
  // already used its AI reply budget — the conversation goes to the team
  // instead of the bot looping on "no entendí". No-op (falls through to
  // the policy below) when AI replies are off. See ai-assist.ts.
  const isAside =
    message.kind === "text" &&
    message.text.trim().length > 0 &&
    (isButtonNode || isQuestion);
  if (isAside && run.conversation_id && run.contact_id) {
    const assist = await assistOffScriptReply(db, {
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id,
      contactId: run.contact_id,
      text: (message as { text: string }).text,
      step: describeStep(currentNode, run.vars, contact),
    });
    if (assist.type === "answered") {
      await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
        action: "ai_answered",
      });
      await resendStep(db, run, currentNode, contact);
      return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
    }
    if (assist.type === "handoff") {
      return routeToHandoff(db, run, nodes, policy, assist.reason);
    }
  }

  // No match → fallback. Apply the policy.
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Antes de reenviar las opciones/el prompt, aclaramos que no aceptamos
    // el mensaje libre que mandaron — sin esto, quien le escribe al bot
    // como si fuera una persona solo ve las mismas opciones de nuevo, sin
    // explicación, y asume que el bot lo ignoró o está roto. Un
    // collect_input no tiene "opciones de abajo", así que ese nodo usa un
    // hint específico del tipo de validación en vez del texto genérico.
    const collectCfg =
      currentNode.node_type === "collect_input"
        ? (currentNode.config as unknown as CollectInputNodeConfig)
        : null;
    const clarifyText = collectCfg
      ? collectCfg.invalid_text?.trim() ||
        collectInputValidationHint(collectCfg.validation)
      : "Disculpa, no logré entender tu mensaje 🙏 Por favor elige una de las opciones de abajo.";
    try {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: clarifyText,
      });
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_clarify_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Re-send the same prompt. Same node, no current_node_key change.
    await resendStep(db, run, currentNode, contact);
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    return routeToHandoff(db, run, nodes, policy, "flow_fallback");
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}
async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      channel_id: flow.channel_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  if (input.conversationId) {
    await resetConversationAiState(db, input.conversationId);
  }
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
