'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Hourglass } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

/**
 * "Modo muy pronto": one switch that makes Bimi say only what the text
 * below allows. Backed by /api/ai/coming-soon (see that route for what
 * the switch changes).
 */
export function AiComingSoonCard() {
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/coming-soon');
      const data = await res.json();
      setConfigured(!!data.configured);
      setEnabled(!!data.enabled);
      setPrompt(data.prompt ?? '');
      setSavedPrompt(data.prompt ?? '');
    } catch {
      toast.error('No se pudo cargar el modo muy pronto');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(body: { enabled?: boolean; prompt?: string }, okMessage: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/ai/coming-soon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo guardar');
        return;
      }
      toast.success(okMessage);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading || !configured) return null;

  const promptDirty = prompt.trim() !== savedPrompt.trim();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hourglass className="h-4 w-4 text-primary" /> Modo muy pronto
        </CardTitle>
        <CardDescription>
          Encendido: Bimi responde solo con el texto de abajo (qué es BSign y la fecha de lanzamiento), no
          consulta la base de conocimiento y el menú con planes y precios se apaga. Apagado: todo vuelve a
          como estaba.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <Label htmlFor="coming-soon-switch" className="font-medium">
            {enabled ? 'Modo muy pronto encendido' : 'Modo muy pronto apagado'}
          </Label>
          <Switch
            id="coming-soon-switch"
            checked={enabled}
            disabled={!canEdit || busy}
            onCheckedChange={(v) =>
              send(
                { enabled: v },
                v ? 'Modo muy pronto encendido' : 'Modo muy pronto apagado, Bimi volvió a la normalidad',
              )
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="coming-soon-prompt">Qué dice Bimi en este modo</Label>
          <Textarea
            id="coming-soon-prompt"
            rows={14}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!canEdit || busy}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!canEdit || busy || !promptDirty}
              onClick={() => send({ prompt }, 'Texto guardado')}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Guardar texto
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
