-- M10 Player updates (docs/tilecast-edge.md §15).
--
-- One row per server update deployment that reached this screen through an
-- install_player_update command. The command handler only writes this row;
-- the update coordinator owns every later step, so a daemon restart never
-- loses an update and never activates one twice. The table holds at most 20
-- rows; the repository removes the oldest finished ones beyond that.
--
-- The envelope columns hold the exact signed update envelope (at most 16 KiB)
-- and its signature: public, signed release metadata. There is no column for
-- a credential, a URL or a path.
CREATE TABLE update_jobs (
    deployment_id TEXT PRIMARY KEY CHECK (length(deployment_id) = 36),
    release_id TEXT NOT NULL CHECK (length(release_id) = 36),
    command_id TEXT NOT NULL CHECK (length(command_id) = 36),
    expected_version_code INTEGER NOT NULL CHECK (expected_version_code > 0),
    expected_artifact_sha256 TEXT NOT NULL CHECK (length(expected_artifact_sha256) = 64),
    installation_mode TEXT NOT NULL CHECK (installation_mode IN ('download_only', 'install_now', 'maintenance_window')),
    maintenance_window_start_ms INTEGER,
    state TEXT NOT NULL CHECK (state IN (
        'accepted', 'verified', 'downloaded', 'staged', 'activating', 'provisional',
        'staged_only', 'confirmed', 'rolled_back', 'failed', 'cancelled')),
    version_name TEXT CHECK (version_name IS NULL OR length(version_name) <= 64),
    artifact_size_bytes INTEGER,
    envelope BLOB CHECK (envelope IS NULL OR length(envelope) <= 16384),
    envelope_signature BLOB CHECK (envelope_signature IS NULL OR length(envelope_signature) <= 1024),
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) <= 64),
    -- The report the server last accepted, so a restart resends only what
    -- it has not seen, and a finished job keeps its result until it lands.
    reported_state TEXT,
    report_closed INTEGER NOT NULL DEFAULT 0 CHECK (report_closed IN (0, 1)),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER,
    activation_requested_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX update_jobs_updated ON update_jobs (updated_at_ms);
