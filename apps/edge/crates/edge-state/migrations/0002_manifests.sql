-- Server manifests (docs/tilecast-edge.md §8.3–8.4).
--
-- manifest_target is the server's latest valid answer from the ordinary
-- player manifest endpoint: what the player should converge to. It is the
-- only thing preparation works toward.
--
-- manifests holds prepared presentations. `pending` is written only after
-- every object it needs is verified, and only while it is still the target.
-- `active` changes only after the renderer accepted the pending manifest and
-- reported meaningful evidence; the former active document moves to
-- `previous` in the same transaction. A manifest is identified by the
-- SHA-256 of its stable encoding, so a changed document is never mistaken
-- for the one already prepared. Every read is bound to the installation,
-- screen and normalized server URL.
CREATE TABLE manifest_target (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    installation_id TEXT NOT NULL,
    screen_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    digest TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    etag TEXT NOT NULL,
    document TEXT NOT NULL,
    fetched_at_ms INTEGER NOT NULL
);

CREATE TABLE manifests (
    stage TEXT PRIMARY KEY CHECK (stage IN ('pending', 'active', 'previous')),
    installation_id TEXT NOT NULL,
    screen_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    digest TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    document TEXT NOT NULL,
    stored_at_ms INTEGER NOT NULL
);
