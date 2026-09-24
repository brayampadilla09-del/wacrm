import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAiConfig } from "@/lib/ai/config";
import { buildConversationContext } from "@/lib/ai/context";
import { retrieveKnowledge } from "@/lib/ai/knowledge";
import { generateReply } from "@/lib/ai/generate";
import { buildSystemPrompt, type FlowStepContext } from "@/lib/ai/defaults";
import { logAiUsage } from "@/lib/ai/usage";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import type { HandoffReason } from "@/lib/ai/handoff";
import { engineSendText } from "./meta-send";

/**
 * What happened when the AI was asked to handle an off-menu message:
 *   - `answered`    — a reply went out; the caller re-sends the step.
 *   - `handoff`     — pass the thread to a person instead of letting
 *                     the bot keep talking: the model bailed
 *                     (`ai_unsure`) or this conversation already used
 *                     its AI reply budget (`ai_limit`).
 *   - `unavailable` — AI replies are off/misconfigured/rate-limited or
 *                     the call failed; the caller applies the flow's
 *                     own fallback policy as if AI didn't exist.
 */
export type AssistOutcome =
  | { type: "answered" }
  | { type: "handoff"; reason: Extract<HandoffReason, "ai_unsure" | "ai_limit"> }
  | { type: "unavailable" };

const UNAVAILABLE: AssistOutcome = { type: "unavailable" };

/**
 * AI reply to a message a customer typed instead of picking an option
 * on a running flow's send_buttons/send_list step ("¿cuánto cuesta el
 * plan Sueño?" while the main menu is open).
 *
 * `handleReplyForActiveRun` calls this only after the tap match, the
 * literal title match and the AI option classifier all came up empty,
 * so it only sees genuine asides. It shares the conversation's auto-
 * reply budget (`auto_reply_max_per_conversation`, counted in
 * `conversations.ai_reply_count`) with the out-of-flow auto-reply: the
 * bot answers a couple of questions and then hands the thread to the
 * team instead of chatting on.
 *
 * Gated on the same switches as auto-reply (`is_active` AND
 * `auto_reply_enabled`) because it writes to the customer; the option
 * classifiers only need `is_active`. Never throws.
 */
export async function assistOffScriptReply(
  db: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    conversationId: string;
    contactId: string;
    text: string;
    step: FlowStepContext;
  },
): Promise<AssistOutcome> {
  const { accountId, userId, conversationId, contactId, text, step } = args;
  if (!text.trim()) return UNAVAILABLE;

  try {
    const config = await loadAiConfig(db, accountId);
    if (!config || !config.autoReplyEnabled) return UNAVAILABLE;

    const { data: conv } = await db
      .from("conversations")
      .select("ai_autoreply_disabled, ai_reply_count")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conv) return UNAVAILABLE;
    // An agent paused the AI on this thread (Take over): keep it out.
    if (conv.ai_autoreply_disabled) return UNAVAILABLE;
    // Budget spent: the bot already answered what it could here.
    if ((conv.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) {
      return { type: "handoff", reason: "ai_limit" };
    }

    const limit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    );
    if (!limit.success) return UNAVAILABLE;

    const [messages, knowledge] = await Promise.all([
      buildConversationContext(db, conversationId),
      retrieveKnowledge(db, accountId, config, text),
    ]);
    if (messages.length === 0) return UNAVAILABLE;

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: "flow_assist",
      knowledge,
      flowStep: step,
    });

    const { text: reply, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    });
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: "auto_reply",
      provider: config.provider,
      model: config.model,
      usage,
    });

    if (handoff || !reply) return { type: "handoff", reason: "ai_unsure" };

    // Same atomic cap claim as auto-reply: never overshoot the budget
    // under concurrent inbounds.
    const { data: claimed, error: claimErr } = await db.rpc(
      "claim_ai_reply_slot",
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    );
    if (claimErr) {
      console.error("[flows] ai assist claim_ai_reply_slot failed:", claimErr);
      return UNAVAILABLE;
    }
    if (claimed !== true) return { type: "handoff", reason: "ai_limit" };

    await engineSendText({
      accountId,
      userId,
      conversationId,
      contactId,
      text: reply,
      aiGenerated: true,
    });
    return { type: "answered" };
  } catch (err) {
    console.error("[flows] ai assist failed:", err);
    return UNAVAILABLE;
  }
}

/**
 * Whether the out-of-flow AI auto-reply would take a message on this
 * conversation (`dispatchInboundToAiReply`'s gates): AI on with
 * auto-reply enabled, not paused here, no agent assigned. The flow
 * engine asks before letting a question skip keyword triggers, so a
 * question is never left unanswered by both. Never throws.
 */
export async function aiAutoReplyWillAnswer(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const config = await loadAiConfig(db, accountId);
    if (!config || !config.autoReplyEnabled) return false;
    const { data: conv } = await db
      .from("conversations")
      .select("ai_autoreply_disabled, assigned_agent_id")
      .eq("id", conversationId)
      .maybeSingle();
    return !!conv && !conv.ai_autoreply_disabled && !conv.assigned_agent_id;
  } catch {
    return false;
  }
}
