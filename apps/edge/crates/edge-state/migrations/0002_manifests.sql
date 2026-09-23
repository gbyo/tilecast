-- A manifest becomes pending only after its required objects are verified.
-- Promotion preserves the former active document for bounded fallback/drain.
-- Every read is bound to the installation, screen and normalized server URL.
CREATE TABLE manifests (
    stage TEXT PRIMARY KEY CHECK (stage IN ('pending', 'active', 'previous')),
    installation_id TEXT NOT NULL,
    screen_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    etag TEXT NOT NULL,
    document TEXT NOT NULL,
    stored_at_ms INTEGER NOT NULL
);
