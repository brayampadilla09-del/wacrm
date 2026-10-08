-- 046_coming_soon_mode.sql: "Modo muy pronto" switch for the AI assistant.
--
-- While ON: the assistant answers with `coming_soon_prompt` instead of
-- `system_prompt`, the knowledge base is not consulted, and flows tagged
-- `coming_soon_mode` are swapped by POST /api/ai/coming-soon:
--   'off_only' flows are active only while the mode is OFF (the full menu),
--   'on_only'  flows are active only while the mode is ON (the handoff).
-- Untagged flows (NULL) are never touched.

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS coming_soon_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coming_soon_prompt text;

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS coming_soon_mode text
  CHECK (coming_soon_mode IN ('off_only', 'on_only'));

-- Reply budget per conversation while the mode is ON (the normal one,
-- auto_reply_max_per_conversation, stays untouched for the full menu).
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS coming_soon_max_replies integer NOT NULL DEFAULT 10
  CHECK (coming_soon_max_replies BETWEEN 1 AND 50);
