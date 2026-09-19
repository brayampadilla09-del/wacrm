-- ============================================================
-- 041_filter_contacts_by_tags_channel.sql
--
-- filter_contacts_by_tags (025) predates multi-channel (039) and has
-- no way to scope its result to one WhatsApp channel — the Contacts
-- page's tag-filtered path would show contacts from every channel
-- mixed together. Adds a trailing optional `p_channel_id` (NULL =
-- no filter, preserving old behavior for any caller that doesn't pass
-- it) and applies it in the `matched` CTE alongside the search filter.
--
-- Idempotent — safe to run multiple times.
--
-- Note: CREATE OR REPLACE only replaces a function with the exact same
-- signature. Adding a trailing parameter makes Postgres register this
-- as a second, overloaded function instead of replacing the old one —
-- drop the old 4-arg signature explicitly so only one definition exists.
-- ============================================================

DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_channel_id UUID DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (p_channel_id IS NULL OR c.channel_id = p_channel_id)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) TO authenticated;
