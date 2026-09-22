"use client";

import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";

import { usePushNotifications } from "@/hooks/use-push-notifications";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Settings > Notifications — the same push on/off control that lives
 * on the /notifications page itself, surfaced here too since that's
 * where people look for a device preference like this. Both call the
 * same usePushNotifications hook, so toggling from either place stays
 * in sync (each reads the real subscription state on mount, not local
 * component state).
 */
export function NotificationsPanel() {
  const { supported, permission, subscribed, loading, subscribe, unsubscribe } =
    usePushNotifications();
  const t = useTranslations("Settings.notifications");

  const statusText = !supported
    ? t("unsupported")
    : permission === "denied"
      ? t("blocked")
      : subscribed
        ? t("onDesc")
        : t("offDesc");

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <Bell className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{t("pushTitle")}</p>
            <p className="mt-0.5 max-w-[48ch] text-xs text-muted-foreground">
              {statusText}
            </p>
          </div>
        </div>
        <Switch
          checked={subscribed}
          onCheckedChange={(checked) => (checked ? subscribe() : unsubscribe())}
          disabled={loading || !supported || permission === "denied"}
          aria-label={t("pushTitle")}
        />
      </div>
    </section>
  );
}
