-- ============================================================
-- 044: internal SECURITY DEFINER functions are not a public API
--
-- Supabase grants EXECUTE on every new public-schema function directly
-- to `anon` and `authenticated` (not just via PUBLIC), so the
-- `REVOKE ... FROM PUBLIC` some earlier migrations did (e.g. 036) left
-- these callable through /rest/v1/rpc by anyone holding the anon key —
-- which ships in the browser bundle. They run as their owner and do no
-- caller check, so e.g. `merge_duplicate_contacts()` (a global,
-- cross-account maintenance merge) could be triggered by a stranger.
--
-- Every caller in the app goes through the service-role client
-- (flows/automations engines, webhook delivery, AI auto-reply), and
-- service_role keeps its grant. Functions meant to be called by signed-
-- in users (set_member_role, touch_presence, redeem_invitation, …) or
-- used inside RLS policies (is_account_member) check auth.uid()
-- themselves and are intentionally left alone; peek_invitation is the
-- /join page's anonymous lookup and stays public too.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_automation_execution_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_flow_execution_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_automation_execution_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_flow_execution_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_contacts() TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_conversations() TO service_role;
