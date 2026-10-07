-- M8 Plugin Store: widget bundles fetched from packages live in the CAS
-- under the widget_bundle domain. SQLite cannot drop a CHECK constraint,
-- so the table is rebuilt with the widened domain list. Data, pins, and the
-- LRU index move across untouched; downgrades keep their rows because the
-- old check only rejects new widget_bundle writes.
ALTER TABLE cas_objects RENAME TO cas_objects_legacy;
CREATE TABLE cas_objects (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    domain TEXT NOT NULL CHECK (domain IN ('media', 'update', 'renderer_bundle', 'legacy_state', 'widget_bundle')),
    content_type TEXT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('origin', 'legacy_import', 'local')),
    -- verified: bytes matched digest and size when last hashed;
    -- suspect: must be re-hashed before next use (after an unclean shutdown).
    verify_state TEXT NOT NULL CHECK (verify_state IN ('verified', 'suspect')),
    verified_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    last_accessed_at_ms INTEGER NOT NULL
);
INSERT INTO cas_objects (sha256, size_bytes, domain, content_type, source_kind, verify_state, verified_at_ms, created_at_ms, last_accessed_at_ms)
    SELECT sha256, size_bytes, domain, content_type, source_kind, verify_state, verified_at_ms, created_at_ms, last_accessed_at_ms
    FROM cas_objects_legacy;
DROP TABLE cas_objects_legacy;
CREATE INDEX cas_objects_lru ON cas_objects (last_accessed_at_ms);
