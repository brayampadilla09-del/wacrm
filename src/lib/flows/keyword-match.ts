import type { KeywordTriggerConfig } from "./types";

// Keyword matching for flow triggers, shared by the engine (which flow
// starts) and the builder (conflict warnings). Pure: no DB, no server
// imports, so the editor can run it in the browser.
//
// Rules:
// - Case- and accent-insensitive ("menu" matches "Menú"); punctuation
//   counts as a space ("hola,bimi" has the word "bimi").
// - "contains" means the keyword appears at the START of a word, so
//   "cita" matches "citas" and "cita mañana" but not "solicitar" or
//   "felicitaciones" (plain substring matching started the menu on those).
// - When several active flows match one message, the winner is the one
//   with the highest `priority`, then the longest matching keyword (the
//   most specific), then the oldest flow.

const MAX_PRIORITY = 100;

export function normalizeKeywordText(value: string, caseSensitive = false): string {
  const cased = caseSensitive ? value : value.toLowerCase();
  return cased
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Length of the longest keyword of `cfg` found in `text` (0 = no match). */
export function keywordMatchLength(text: string, cfg: KeywordTriggerConfig): number {
  if (!text || !cfg.keywords?.length) return 0;
  const caseSensitive = cfg.case_sensitive === true;
  const haystack = normalizeKeywordText(text, caseSensitive);
  if (!haystack) return 0;
  const exact = cfg.match_type === "exact";
  let best = 0;
  for (const raw of cfg.keywords) {
    if (typeof raw !== "string") continue;
    const needle = normalizeKeywordText(raw, caseSensitive);
    if (!needle) continue;
    const hit = exact ? haystack === needle : ` ${haystack}`.includes(` ${needle}`);
    if (hit && needle.length > best) best = needle.length;
  }
  return best;
}

export function matchesKeywordTrigger(text: string, cfg: KeywordTriggerConfig): boolean {
  return keywordMatchLength(text, cfg) > 0;
}

/** `priority` from the trigger config: an integer in [-100, 100], 0 when unset or invalid. */
export function triggerPriority(cfg: Pick<KeywordTriggerConfig, "priority"> | null | undefined): number {
  const value = Number(cfg?.priority ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_PRIORITY, Math.min(MAX_PRIORITY, Math.round(value)));
}

export interface KeywordHit {
  priority: number;
  /** Longest matching keyword; 0 for a hit that is not a keyword (first message). */
  length: number;
  /** ISO date; older wins the final tie. */
  createdAt: string;
}

/** Negative when `a` should win over `b`. */
export function compareKeywordHits(a: KeywordHit, b: KeywordHit): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.length !== b.length) return b.length - a.length;
  return a.createdAt.localeCompare(b.createdAt);
}

export interface TriggerFlowSummary {
  id: string;
  name: string;
  trigger_config: Record<string, unknown> | KeywordTriggerConfig;
  /** Missing for a flow that is not saved yet (it would be the newest). */
  created_at?: string | null;
}

export interface KeywordConflict {
  otherId: string;
  otherName: string;
  /** A message that starts both flows (the longer of the two keywords). */
  sample: string;
  /** Which flow starts for that message. */
  winner: "this" | "other";
  /** Why it wins, to explain it in the builder. */
  reason: "priority" | "longer_keyword" | "older";
}

function asConfig(cfg: TriggerFlowSummary["trigger_config"]): KeywordTriggerConfig {
  const raw = cfg as Partial<KeywordTriggerConfig>;
  return {
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((k): k is string => typeof k === "string") : [],
    match_type: raw.match_type,
    case_sensitive: raw.case_sensitive,
    priority: raw.priority,
  };
}

/**
 * Keyword overlaps between `flow` and the other active keyword flows of the
 * same channel: for each pair of keywords where a message could start both
 * flows, which flow actually starts. One entry per other flow (the first
 * overlapping keyword found), so the builder can warn without flooding.
 */
export function findKeywordConflicts(flow: TriggerFlowSummary, others: TriggerFlowSummary[]): KeywordConflict[] {
  const mine = asConfig(flow.trigger_config);
  if (!mine.keywords.length) return [];
  const myCreated = flow.created_at ?? "9999-12-31T23:59:59.999Z";
  const conflicts: KeywordConflict[] = [];

  for (const other of others) {
    if (other.id === flow.id) continue;
    const theirs = asConfig(other.trigger_config);
    if (!theirs.keywords.length) continue;

    let found: KeywordConflict | null = null;
    for (const a of mine.keywords) {
      for (const b of theirs.keywords) {
        // A message equal to either keyword is the most likely real text that hits both.
        for (const sample of [a, b]) {
          const myLen = keywordMatchLength(sample, mine);
          const theirLen = keywordMatchLength(sample, theirs);
          if (!myLen || !theirLen) continue;
          const me: KeywordHit = { priority: triggerPriority(mine), length: myLen, createdAt: myCreated };
          const them: KeywordHit = { priority: triggerPriority(theirs), length: theirLen, createdAt: other.created_at ?? myCreated };
          const thisWins = compareKeywordHits(me, them) < 0;
          const reason = me.priority !== them.priority ? "priority" : me.length !== them.length ? "longer_keyword" : "older";
          found = { otherId: other.id, otherName: other.name, sample, winner: thisWins ? "this" : "other", reason };
          break;
        }
        if (found) break;
      }
      if (found) break;
    }
    if (found) conflicts.push(found);
  }
  return conflicts;
}
