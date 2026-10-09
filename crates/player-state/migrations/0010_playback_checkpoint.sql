-- Durable playlist resume: the last reliably presented item of the current
-- player relationship, so an ordinary playlist restarts there instead of at
-- item zero after a daemon restart, reboot, or power cut. One row per
-- device, replaced in place; the reader validates the binding, manifest,
-- and freshness before every use. Downgrades keep the row; the old reader
-- ignores the table.
CREATE TABLE playback_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    installation_id TEXT NOT NULL,
    screen_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    manifest_version INTEGER NOT NULL,
    manifest_digest TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    presented_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
