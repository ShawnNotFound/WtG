-- Complete each immutable revision so an as-of view can reconstruct a full
-- page, not only its summary. This migration also repairs timestamps from the
-- first development version of migration 024, which assigned migration time
-- to pre-existing pages.

ALTER TABLE world_state_page_revisions
  ADD COLUMN IF NOT EXISTS page_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS page_type TEXT NOT NULL DEFAULT 'entity',
  ADD COLUMN IF NOT EXISTS page_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS page_aliases JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE world_state_page_revisions revision
SET page_name = node.name,
    page_type = node.type,
    page_attributes = node.attributes,
    page_aliases = node.aliases
FROM world_state_nodes node
WHERE node.id = revision.node_id
  AND revision.page_name = '';

UPDATE world_state_nodes node
SET last_content_update_at = baseline.effective_at
FROM world_state_page_revisions baseline
WHERE baseline.node_id = node.id
  AND baseline.revision_no = 1
  AND node.revision_no = 1
  AND node.last_content_update_at > baseline.effective_at + INTERVAL '1 minute';

COMMENT ON COLUMN world_state_page_revisions.page_name IS
  'Canonical page name at this revision; stored for complete as-of reconstruction.';
COMMENT ON COLUMN world_state_page_revisions.page_attributes IS
  'Full page attributes at this revision, rather than a partial patch.';
