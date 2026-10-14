-- Contactos que ocultan su número (nombre de usuario de WhatsApp): Meta no manda teléfono, solo un
-- identificador propio (BSUID). Se guarda para encontrar de nuevo al contacto y poder responderle.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bsuid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_channel_bsuid
  ON contacts (account_id, channel_id, bsuid) WHERE bsuid IS NOT NULL;
