-- ============================================================
-- 043_push_notifications.sql
--
-- Web Push subscriptions (one row per browser/device a user has
-- opted into notifications on) and a new 'new_message' notification
-- type for "a contact wrote in" — previously only conversation
-- assignment and new leads generated a notification row.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;

CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);

-- Widen the notifications type check (027 -> 042) to add 'new_message':
-- fired for every inbound customer message, in addition to the existing
-- conversation_assigned (trigger-based) and new_lead (app-code) types.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'new_lead', 'new_message'));
