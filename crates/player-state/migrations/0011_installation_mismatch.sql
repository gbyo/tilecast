-- Installation mismatch evidence: the server URL, the expected and
-- reported installation IDs, when the mismatch was detected, the last
-- successful contact before it, and where the quarantined caches went.
-- One row per device, replaced in place. A re-pair, an unpair, or a
-- recovered server clears it. Downgrades keep the row; the old reader
-- ignores the table.
CREATE TABLE installation_mismatch (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    server_url TEXT NOT NULL,
    expected_installation_id TEXT NOT NULL,
    actual_installation_id TEXT NOT NULL,
    detected_at_ms INTEGER NOT NULL,
    last_contact_at_ms INTEGER,
    quarantined_cas_dir TEXT,
    quarantined_partial_dir TEXT
);
