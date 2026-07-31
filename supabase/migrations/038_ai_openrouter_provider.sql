-- ============================================================
-- 038_ai_openrouter_provider
--
-- Adds 'openrouter' as a valid AI provider alongside 'openai' and
-- 'anthropic'. OpenRouter proxies a single OpenAI-compatible endpoint to
-- hundreds of upstream models, so this lets an account pick any
-- OpenRouter-listed model (free-text `model` column, unchanged) with one
-- BYO key instead of being limited to the two hardcoded providers.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));
