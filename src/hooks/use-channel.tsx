"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useAuth } from "@/hooks/use-auth";

export interface Channel {
  id: string;
  label: string;
  kind: "bot" | "human";
  is_default: boolean;
  status: "connected" | "disconnected";
}

interface ChannelContextValue {
  /** Every channel (WhatsApp number) on the current account. Empty
   *  array once loaded if none are configured yet. */
  channels: Channel[];
  /** True until the first fetch for this account settles. */
  loading: boolean;
  /** The channel every list/inbox page should filter by. Null only
   *  while loading or if the account has no channels at all. */
  currentChannelId: string | null;
  currentChannel: Channel | null;
  setCurrentChannelId: (id: string) => void;
  /** Re-fetch the channel list (call after adding/renaming one in Settings). */
  refreshChannels: () => Promise<void>;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

function storageKey(accountId: string) {
  return `wacrm:currentChannelId:${accountId}`;
}

/**
 * ChannelProvider — wraps the dashboard (nested inside AuthProvider,
 * since it needs `accountId` to know which account's channels to
 * load). An account can own more than one WhatsApp channel (migration
 * 039 — e.g. "Bimi" the bot number + "Asesor" a human advisor's own
 * number); this is the single source of truth for "which one is the
 * user currently looking at" across the dashboard (inbox, contacts,
 * pipelines, broadcasts, automations, flows all filter by this).
 */
export function ChannelProvider({ children }: { children: ReactNode }) {
  const { accountId, loading: authLoading, profileLoading } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentChannelId, setCurrentChannelIdState] = useState<string | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchChannels = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/whatsapp/config/channels", { cache: "no-store" });
      const data = await res.json();
      const list: Channel[] = data.channels ?? [];
      setChannels(list);

      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(storageKey(acctId));
      } catch {
        // Private browsing / blocked storage — fall back to the default channel.
      }

      setCurrentChannelIdState((prev) => {
        if (prev && list.some((c) => c.id === prev)) return prev;
        if (stored && list.some((c) => c.id === stored)) return stored;
        return list.find((c) => c.is_default)?.id ?? list[0]?.id ?? null;
      });
    } catch (err) {
      console.error("[ChannelProvider] Failed to load channels:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountId) {
      loadedAccountIdRef.current = null;
      setChannels([]);
      setCurrentChannelIdState(null);
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchChannels(accountId);
  }, [authLoading, profileLoading, accountId, fetchChannels]);

  const setCurrentChannelId = useCallback(
    (id: string) => {
      setCurrentChannelIdState(id);
      if (accountId) {
        try {
          window.localStorage.setItem(storageKey(accountId), id);
        } catch {
          // Ignore — worst case the selection doesn't persist across reloads.
        }
      }
    },
    [accountId],
  );

  const refreshChannels = useCallback(async () => {
    if (accountId) await fetchChannels(accountId);
  }, [accountId, fetchChannels]);

  const currentChannel = channels.find((c) => c.id === currentChannelId) ?? null;

  return (
    <ChannelContext.Provider
      value={{
        channels,
        loading,
        currentChannelId,
        currentChannel,
        setCurrentChannelId,
        refreshChannels,
      }}
    >
      {children}
    </ChannelContext.Provider>
  );
}

export function useChannel(): ChannelContextValue {
  const ctx = useContext(ChannelContext);
  if (!ctx) {
    // Fallback for anything rendered outside the provider — collapses to
    // "no channel selected" rather than crashing; callers already handle
    // a null currentChannelId as "don't filter yet / show nothing".
    return {
      channels: [],
      loading: false,
      currentChannelId: null,
      currentChannel: null,
      setCurrentChannelId: () => {},
      refreshChannels: async () => {},
    };
  }
  return ctx;
}
