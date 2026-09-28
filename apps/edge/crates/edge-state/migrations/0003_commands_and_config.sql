-- Player commands and player configuration (docs/tilecast-edge.md §8.3, M4).
--
-- Commands
-- --------
-- The server's command contract carries two identifiers. `id` names one
-- delivery and is what acknowledgement and result reports address.
-- `idempotencyKey` is the semantic non-replay key. Local non-replay is keyed
-- by the idempotency key, so a redelivery under a new `id` never runs twice.
--
-- 0001's command_idempotency table had a single `command_id` column that
-- held the legacy player's idempotency keys (executed-commands.json). No
-- command ran under Edge before this migration, so every row there is an
-- imported legacy key; each becomes a completed record here and keeps
-- suppressing its command.
--
-- Lifecycle: received -> acknowledged -> executing -> completed. The handler
-- runs only after `executing` has committed. A row found `executing` when the
-- daemon starts is completed as `command_interrupted` and never run again:
-- at-most-once local execution with durable non-replay. A completed row
-- keeps its full result until the server has taken it (`report_state`), so
-- result delivery is retried across restarts without executing again.
--
-- Bounded: 5,000 rows. Pruning removes only rows that can no longer matter
-- (never an executing row or a result the server has not yet taken): after
-- the 30-day replay window, oldest first.
CREATE TABLE player_commands (
    idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    command_id TEXT CHECK (command_id IS NULL OR length(command_id) = 36),
    command_type TEXT NOT NULL CHECK (length(command_type) BETWEEN 1 AND 64),
    state TEXT NOT NULL CHECK (state IN ('received', 'acknowledged', 'executing', 'completed')),
    success INTEGER CHECK (success IN (0, 1)),
    result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 80),
    result_message TEXT CHECK (result_message IS NULL OR length(result_message) <= 240),
    -- none: no result yet; pending: a result waits for the server;
    -- reported: the server took it; abandoned: the server can no longer take
    -- it (expired or cancelled); not_required: nothing to report (imported).
    report_state TEXT NOT NULL CHECK (report_state IN ('none', 'pending', 'reported', 'abandoned', 'not_required')),
    received_at_ms INTEGER NOT NULL,
    acknowledged_at_ms INTEGER,
    executing_at_ms INTEGER,
    completed_at_ms INTEGER,
    reported_at_ms INTEGER,
    CHECK ((state = 'completed') = (success IS NOT NULL AND result_code IS NOT NULL AND completed_at_ms IS NOT NULL)),
    CHECK ((state = 'completed') = (report_state <> 'none'))
);
CREATE INDEX player_commands_report ON player_commands (report_state) WHERE report_state = 'pending';

INSERT INTO player_commands (idempotency_key, command_id, command_type, state, success, result_code,
                             result_message, report_state, received_at_ms, completed_at_ms)
SELECT command_id, NULL, substr(command_type, 1, 64), 'completed', 1,
       substr(COALESCE(result_code, 'imported'), 1, 80), NULL, 'not_required',
       received_at_ms, COALESCE(completed_at_ms, received_at_ms)
FROM command_idempotency
WHERE length(command_id) BETWEEN 1 AND 128 AND length(command_type) >= 1;

DROP TABLE command_idempotency;

-- Configuration
-- -------------
-- `current` is the last accepted configuration document from the ordinary
-- player configuration endpoint. It is applied at start before any network
-- access. `previous` is the document it replaced, kept for recovery and
-- diagnostics. A document is accepted only after validation, only at a
-- supported schema version and only at a strictly greater configRevision.
-- Rows are bound to the installation, screen and normalized server URL and
-- ignored under any other binding. Bounded: two rows.
CREATE TABLE player_config (
    stage TEXT PRIMARY KEY CHECK (stage IN ('current', 'previous')),
    installation_id TEXT NOT NULL,
    screen_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
    etag TEXT CHECK (etag IS NULL OR length(etag) <= 200),
    document TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL
);

-- The latest configuration reconciliation outcome, replaced in place.
CREATE TABLE player_config_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_fetched_at_ms INTEGER,
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
    last_error_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
);
