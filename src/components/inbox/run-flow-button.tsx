"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Play } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

interface RunFlowButtonProps {
  conversationId: string;
  channelId: string;
}

interface FlowOption {
  id: string;
  name: string;
}

/**
 * Botón de emergencia: corre un Flow a mano sobre esta conversación cuando el bot no
 * contestó. Cierra el run activo del contacto y arranca el Flow elegido desde el inicio.
 */
export function RunFlowButton({ conversationId, channelId }: RunFlowButtonProps) {
  const t = useTranslations("Inbox.runFlow");
  const [flows, setFlows] = useState<FlowOption[]>([]);
  const [selected, setSelected] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    createClient()
      .from("flows")
      .select("id, name")
      .eq("status", "active")
      .eq("channel_id", channelId)
      .order("name")
      .then(({ data }) => {
        if (!alive) return;
        const list = (data ?? []) as FlowOption[];
        setFlows(list);
        setSelected((prev) => (list.some((f) => f.id === prev) ? prev : (list[0]?.id ?? "")));
      });
    return () => {
      alive = false;
    };
  }, [channelId]);

  async function run() {
    if (!selected || running) return;
    if (!window.confirm(t("confirm"))) return;
    setRunning(true);
    try {
      const res = await fetch("/api/flows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, flow_id: selected }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j?.error ?? t("error"));
        return;
      }
      toast.success(t("started"));
    } catch {
      toast.error(t("error"));
    } finally {
      setRunning(false);
    }
  }

  if (flows.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Play className="h-3 w-3" />
        {t("title")}
      </div>
      <p className="mt-2 px-1 text-xs text-muted-foreground">{t("hint")}</p>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
      >
        {flows.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        className="mt-2 w-full"
        onClick={run}
        disabled={running || !selected}
      >
        {running ? t("running") : t("run")}
      </Button>
    </div>
  );
}
