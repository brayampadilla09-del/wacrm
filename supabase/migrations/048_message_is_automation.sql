-- Messages sent by an automation through the public API with skip_flow_pause
-- (pagina-estudio: booking templates, reschedule buttons, the proposal PDF) are
-- stored as sender_type='agent' but are NOT a person taking over the thread.
-- hasRecentAgentMessage() counted them (everything except templates), so after
-- the proposal PDF the bot (menu flow and AI) stayed mute for 12 h.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_automation boolean NOT NULL DEFAULT false;
