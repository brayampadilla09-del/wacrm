-- ============================================================
-- 037_contact_full_name
--
-- Adds `contacts.full_name`, a distinct slot from `contacts.name`.
-- `name` is the nickname/preferred name captured early in the BSign
-- Estudio flow ("¿cómo te gusta que te digan?"); `full_name` is the
-- legal name captured later, specifically for booking records
-- ("¿cuál es tu nombre completo?" — ask_full_name node). Without its
-- own column, ask_full_name's persist_to_contact_field had nowhere
-- valid to write to, so the captured value never survived past the
-- current flow_run — every new conversation asked again.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS full_name TEXT;
