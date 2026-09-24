"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";

// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches instead of hitting
// /api/ai/config every time the agent opens a chat.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
// ------------------------------------------------------------
interface AiAccountStatus {
  /** Configured + master switch on: summaries (and drafts) work. */
  aiOn: boolean;
  /** …and the inbound auto-reply bot is enabled too. */
  autoReplyOn: boolean;
}
const statusCache = new Map<string, AiAccountStatus>();

async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok) return { aiOn: false, autoReplyOn: false }; // don't cache a transient failure
    const j = await res.json();
    const aiOn = !!(j?.configured && j?.is_active);
    const status = {
      aiOn,
      // AI auto-reply is "live" only when configured, the master switch
      // is on, and the inbound bot is enabled.
      autoReplyOn: aiOn && !!j?.auto_reply_enabled,
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { aiOn: false, autoReplyOn: false }; // don't cache
  }
}

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_summary` — summary the bot left on
   *  handoff, or the last one an agent asked for. */
  handoffSummary?: string | null;
  /** Current assignee; when a human owns the thread the bot won't run,
   *  so the "AI active" banner is suppressed. */
  assignedAgentId?: string | null;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  /** Called after a successful toggle so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
  }) => void;
}

/**
 * Inbox banner that surfaces + controls the AI on a conversation:
 *   - the conversation summary (left by the bot on handoff, or asked
 *     for with [Summarize]), collapsed to two lines, expandable
 *   - bot active here → "AI is replying automatically" + [Take over]
 *   - bot paused here → [Resume AI]
 * Renders nothing when there's no summary and the account's AI is off.
 */
export function AiThreadBanner({
  conversationId,
  disabled,
  handoffSummary,
  assignedAgentId,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations("Inbox.aiBanner");
  const { accountId } = useAuth();
  const [status, setStatus] = useState<AiAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Local mirror so a fresh [Summarize] shows instantly; re-seeds from
  // the prop (realtime UPDATE) and collapses when the thread changes.
  const [summary, setSummary] = useState(handoffSummary ?? null);
  useEffect(() => setSummary(handoffSummary ?? null), [conversationId, handoffSummary]);
  useEffect(() => setExpanded(false), [conversationId]);
  // Optimistic local mirror of the pause flag so the banner flips
  // instantly on click; re-seeds whenever the thread (or its server
  // state via realtime) changes.
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const toggle = useCallback(
    async (paused: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "Take over" also assigns the thread to the acting agent.
          body: JSON.stringify({ paused, assign_to_me: paused }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
          return;
        }
        setPaused(paused);
        onChange?.({
          ai_autoreply_disabled: paused,
          // Take over assigns to the acting agent; resume releases only
          // the caller's own assignment. The realtime UPDATE reconciles
          // the exact value either way.
          ...(paused
            ? currentUserId
              ? { assigned_agent_id: currentUserId }
              : {}
            : { assigned_agent_id: null }),
        });
        toast.success(paused ? t("tookOver") : t("resumed"));
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, currentUserId, onChange, t],
  );

  const summarize = useCallback(async () => {
    setSummarizing(true);
    try {
      const res = await fetch("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || typeof j?.summary !== "string") {
        toast.error(j?.error ?? t("summaryError"));
        return;
      }
      setSummary(j.summary);
      setExpanded(true);
    } catch {
      toast.error(t("networkError"));
    } finally {
      setSummarizing(false);
    }
  }, [conversationId, t]);

  const aiOn = status?.aiOn ?? false;
  const autoReplyOn = status?.autoReplyOn ?? false;
  // Nothing to show: no summary, and the account's AI is off (or the
  // status is still loading).
  if (!summary && !aiOn) return null;

  const summarizeButton = aiOn ? (
    <BannerButton onClick={summarize} busy={summarizing} icon={FileText}>
      {t("summarize")}
    </BannerButton>
  ) : null;

  const summaryBlock = summary ? (
    <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs sm:px-4">
      <p className="font-medium text-foreground">{t("summaryTitle")}</p>
      <p
        className={cn(
          "whitespace-pre-line text-muted-foreground",
          !expanded && "line-clamp-2",
        )}
      >
        {summary}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-0.5 font-medium text-primary hover:underline"
      >
        {expanded ? t("showLess") : t("showMore")}
      </button>
    </div>
  ) : null;

  let controls: React.ReactNode;
  if (autoReplyOn && paused) {
    // Paused here (a human took over, or the bot handed off).
    controls = (
      <Banner tone="muted">
        <p className="min-w-0 flex-1 truncate font-medium text-foreground">
          {t("pausedTitle")}
        </p>
        {summarizeButton}
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  } else if (autoReplyOn && !assignedAgentId) {
    // Active on this thread.
    controls = (
      <Banner tone="primary">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          <span className="truncate font-medium text-foreground">
            {t("activeText")}
          </span>
        </div>
        {summarizeButton}
        <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
          {t("takeOver")}
        </BannerButton>
      </Banner>
    );
  } else if (summarizeButton) {
    // No auto-reply controls apply (auto-reply off, or a human owns the
    // thread) — still offer the summary.
    controls = (
      <Banner tone="muted">
        <p className="min-w-0 flex-1 truncate text-muted-foreground">
          {t("summaryHint")}
        </p>
        {summarizeButton}
      </Banner>
    );
  }

  return (
    <>
      {summaryBlock}
      {controls}
    </>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
        tone === "primary"
          ? "border-primary/20 bg-primary/5"
          : "border-border bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
