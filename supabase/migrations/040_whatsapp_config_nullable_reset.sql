-- ============================================================
-- 040_whatsapp_config_nullable_reset.sql
--
-- Follow-up to 039. The "Reset Configuration" button (POST .../config
-- DELETE) used to delete the whole whatsapp_config row so the user
-- could re-save fresh credentials. Post-039 that row is an FK target
-- (ON DELETE RESTRICT) from contacts/conversations/etc., so deleting a
-- channel that has ever received a message now fails loudly instead of
-- silently — which is correct, but means "reset" has to clear
-- credentials in place instead.
--
-- `phone_number_id` and `access_token` were NOT NULL, so an in-place
-- reset needs a placeholder value — but `phone_number_id` also carries
-- a UNIQUE constraint (013), and two reset channels both holding the
-- same placeholder (e.g. '') would collide. Postgres UNIQUE treats
-- NULL as distinct from every other NULL, so making both columns
-- nullable lets any number of channels sit "disconnected" (NULL)
-- at once without a placeholder hack.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;
