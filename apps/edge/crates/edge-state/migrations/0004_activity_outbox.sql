-- Activity events and telemetry samples for the server (docs/tilecast-edge.md
-- §16, M8).
--
-- One outbox holds both. It is bounded to 500 rows: when a report would
-- exceed the bound, the oldest rows are dropped first and counted by kind.
-- Telemetry samples (one a minute) are further bounded to 120 rows, so a
-- long outage keeps the latest two hours of measurements without pushing
-- proof of play out of the outbox.
--
-- `event_id` is the activity event `id` (the server's idempotency key), or a
-- generated identifier for a telemetry sample. A retry sends the same body,
-- so a report the server already took is acknowledged as a duplicate.
--
-- 0001's outbox and outbox_meta tables were never written: nothing reported
-- through them before this migration.
DROP TABLE outbox;
DROP TABLE outbox_meta;

CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('activity_event', 'telemetry_sample')),
    event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) = 36),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 2 AND 65536),
    created_at_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_kind ON outbox (kind, id);

-- The activity `sequence` must be monotonic per device across restarts, so
-- it is allocated here in the same transaction as the row that uses it.
-- `open_sessions` holds the playback sessions open on screen, so a daemon
-- that stopped without closing them can close them when it starts again.
CREATE TABLE outbox_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
    dropped_activity INTEGER NOT NULL DEFAULT 0,
    dropped_telemetry INTEGER NOT NULL DEFAULT 0,
    -- Reports the server refused as invalid; never retried.
    rejected INTEGER NOT NULL DEFAULT 0,
    -- Telemetry older than the server's reporting window; never sent.
    expired INTEGER NOT NULL DEFAULT 0,
    -- How many dropped activity events the server has been told about.
    reported_dropped_activity INTEGER NOT NULL DEFAULT 0,
    open_sessions TEXT CHECK (open_sessions IS NULL OR length(open_sessions) <= 16384),
    updated_at_ms INTEGER NOT NULL
);
INSERT INTO outbox_state (singleton, next_sequence, updated_at_ms) VALUES (1, 1, 0);
