-- ============================================================
-- 042_new_lead_notifications.sql
--
-- Adds the 'new_lead' notification type (migration 027 only allowed
-- 'conversation_assigned'). Fired from application code — not a DB
-- trigger like notify_conversation_assigned — from two call sites:
--   1. POST /api/meta/leadgen/webhook (a Meta Lead Ads form submission
--      creates a contact tagged "Meta Ads").
--   2. The website booking wizard, via POST /api/v1/contacts from
--      pagina-estudio, tagged "Sitio web".
-- Unlike conversation_assigned (one recipient — the assignee), a new
-- lead has no natural single recipient, so the webhook handler inserts
-- one row per active account member instead of relying on a trigger.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'new_lead'));
