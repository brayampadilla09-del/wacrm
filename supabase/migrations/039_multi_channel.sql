-- ============================================================
-- 039_multi_channel.sql — multiple WhatsApp numbers per account
--
-- Until now `whatsapp_config` enforced UNIQUE(account_id) — "one
-- WhatsApp number per account" (see migration 017's comment: "if
-- multi-number-per-account is ever wanted, drop the unique and add a
-- primary boolean"). This migration does exactly that, turning each
-- `whatsapp_config` row into a "channel" (e.g. "Bimi" the bot number,
-- "Asesor" a human advisor's personal number) that domain data can be
-- scoped to via a new `channel_id` column.
--
-- Design:
--   - `whatsapp_config` gains `label`, `kind` ('bot' | 'human'),
--     `is_default`, `notify_user_id`.
--   - `contacts`, `conversations`, `deals`, `broadcasts`,
--     `automations`, `flows` gain `channel_id` (FK -> whatsapp_config).
--   - `pipelines` and `tags` stay account-wide (shared taxonomy, not
--     per-channel customer data) — deliberate, not an oversight.
--   - Contacts' phone-dedup unique index (022) is narrowed from
--     (account_id, phone_normalized) to
--     (account_id, channel_id, phone_normalized) so the same phone
--     number can be an independent contact on each channel.
--
-- Backfill strategy: at migration time every account has at most one
-- whatsapp_config row (the very constraint we're relaxing), so every
-- domain row's channel_id is unambiguous: match on account_id. Accounts
-- with zero whatsapp_config rows (e.g. a personal account created at
-- signup but never configured) have zero domain rows to backfill
-- either — if that assumption is ever wrong, the final SET NOT NULL
-- below fails loudly rather than silently leaving orphaned rows.
--
-- Idempotent — safe to run multiple times, same conventions as prior
-- migrations (IF NOT EXISTS, guarded constraint drops/adds).
-- ============================================================

-- ============================================================
-- 1. whatsapp_config -> channel metadata
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT 'Principal',
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bot' CHECK (kind IN ('bot', 'human')),
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notify_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Existing row (if any) per account becomes the "Bimi" default channel.
UPDATE whatsapp_config
SET label = 'Bimi', kind = 'bot', is_default = TRUE
WHERE is_default = FALSE;

-- At most one default channel per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_default_per_account
  ON whatsapp_config(account_id) WHERE is_default;

-- Drop the one-number-per-account constraint added in 017. Keep
-- UNIQUE(phone_number_id) (013) — a given Meta number still belongs to
-- exactly one config row, just no longer capped at one row per account.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- ============================================================
-- 2. channel_id on domain tables
-- ============================================================
ALTER TABLE contacts      ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE deals         ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE broadcasts    ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE automations   ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE flows         ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE flow_runs     ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;

-- Backfill: each row's account currently has at most one channel.
DO $$
DECLARE
  v_table TEXT;
  v_tables TEXT[] := ARRAY[
    'contacts', 'conversations', 'deals', 'broadcasts', 'automations', 'flows', 'flow_runs'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format($f$
      UPDATE %I t
      SET channel_id = wc.id
      FROM whatsapp_config wc
      WHERE wc.account_id = t.account_id
        AND t.channel_id IS NULL
    $f$, v_table);
  END LOOP;
END $$;

-- NOT NULL — split out from the DO block so DDL happens at the top
-- transactional level, same pattern as migration 017. Fails loudly
-- (rather than silently) if any account has domain rows but zero
-- whatsapp_config rows to backfill from.
ALTER TABLE contacts      ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE deals         ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE broadcasts    ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE automations   ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE flows         ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE flow_runs     ALTER COLUMN channel_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_channel      ON contacts(channel_id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id);
CREATE INDEX IF NOT EXISTS idx_deals_channel         ON deals(channel_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_channel    ON broadcasts(channel_id);
CREATE INDEX IF NOT EXISTS idx_automations_channel   ON automations(channel_id);
CREATE INDEX IF NOT EXISTS idx_flows_channel         ON flows(channel_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_channel     ON flow_runs(channel_id);

-- Active-trigger lookups (flows/automations engines) now need to
-- filter by which channel the inbound message arrived on, in addition
-- to trigger_type — mirrors idx_automations_active_trigger (006) /
-- idx_flows_active_trigger (010).
CREATE INDEX IF NOT EXISTS idx_automations_active_trigger_channel
  ON automations(channel_id, trigger_type) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_flows_active_trigger_channel
  ON flows(channel_id, trigger_type) WHERE status = 'active';

-- ============================================================
-- 3. contacts phone-dedup: narrow to (account_id, channel_id, phone)
--
-- Was (account_id, phone_normalized) (022) — the same phone can now be
-- an independent contact per channel. Strictly more specific than the
-- old key, so no existing row can violate it.
-- ============================================================
DROP INDEX IF EXISTS idx_contacts_account_phone_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_channel_phone_normalized
  ON contacts (account_id, channel_id, phone_normalized) WHERE phone_normalized <> '';

-- ============================================================
-- 4. RLS — no changes needed
--
-- Every policy already checks is_account_member(account_id); channel_id
-- is purely an additional filter column within the same account, not a
-- new tenancy boundary. Bimi's AI layer (service-role, server-side)
-- can already read across channels of the same account — the
-- separation the product wants is a UI-level filter, not an RLS wall.
-- ============================================================
