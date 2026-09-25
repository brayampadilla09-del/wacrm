-- ============================================================
-- 045: guardar el error real de Meta cuando un mensaje no se entrega.
--
-- Hasta ahora el webhook de estados solo copiaba status='failed' en
-- messages: el código y el motivo que manda Meta (ej. 131026 "número sin
-- WhatsApp", 132001 "plantilla no existe") se perdían, y quien integraba
-- por la API solo veía "falló" sin saber por qué. Quedan en la fila del
-- mensaje (GET /api/v1/conversations/{id}/messages ya devuelve la fila
-- completa) y viajan en el webhook saliente message.status_updated.
-- Aditiva: columnas nuevas, nulas, sin tocar filas existentes.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code INTEGER,
  ADD COLUMN IF NOT EXISTS error_title TEXT,
  ADD COLUMN IF NOT EXISTS error_details TEXT,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_failed_at ON messages(failed_at) WHERE failed_at IS NOT NULL;
