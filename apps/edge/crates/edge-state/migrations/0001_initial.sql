-- Tilecast Edge state schema, version 1.
--
-- Conventions:
--   * Timestamps are INTEGER Unix milliseconds in UTC, named *_at_ms.
--   * Identifiers are canonical lowercase UUID or SHA-256 hex TEXT.
--   * Singletons use `id INTEGER PRIMARY KEY CHECK (id = 1)`.
--   * No table is an unbounded history. Every table that can grow names its
--     bound in a comment, and the owning repository module enforces it.
--   * Secrets never live here. The device credential is a file in the
--     identity directory; this schema records only whether it exists.
--   * Media bytes never live here. CAS objects are files; rows are metadata.

-- The daemon's own lifecycle. `running` is set at start and cleared on clean
-- shutdown, so a start that finds it set knows the previous run ended
-- uncleanly and schedules integrity checks.
CREATE TABLE daemon_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    created_at_ms INTEGER NOT NULL,
    boot_count INTEGER NOT NULL DEFAULT 0,
    running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0, 1)),
    unclean_shutdown_count INTEGER NOT NULL DEFAULT 0,
    last_started_at_ms INTEGER,
    last_clean_shutdown_at_ms INTEGER,
    daemon_version TEXT NOT NULL
);

-- The player-generated installation UUID (pairing metadata's
-- playerInstallationId), carried over from the legacy player when imported.
CREATE TABLE player_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    player_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('generated', 'legacy_import')),
    created_at_ms INTEGER NOT NULL
);

-- Which Tilecast Server installation this node belongs to. The device
-- credential file is valid only together with this row.
CREATE TABLE server_binding (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    server_url TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    organization_name TEXT,
    screen_id TEXT,
    screen_name TEXT,
    -- none: no credential; stored: credential file present;
    -- rejected: server confirmed it invalid/revoked (file removed).
    credential_state TEXT NOT NULL CHECK (credential_state IN ('none', 'stored', 'rejected')),
    identity_verified_at_ms INTEGER,
    bound_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

-- Content-addressed objects. The file is cas/sha256/<fanout>/<sha256>.
-- Bounded by the cache limit through eviction.
CREATE TABLE cas_objects (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    domain TEXT NOT NULL CHECK (domain IN ('media', 'update', 'renderer_bundle', 'legacy_state')),
    content_type TEXT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('origin', 'legacy_import', 'local')),
    -- verified: bytes matched digest and size when last hashed;
    -- suspect: must be re-hashed before next use (after an unclean shutdown).
    verify_state TEXT NOT NULL CHECK (verify_state IN ('verified', 'suspect')),
    verified_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    last_accessed_at_ms INTEGER NOT NULL
);
CREATE INDEX cas_objects_lru ON cas_objects (last_accessed_at_ms);

-- Resumable partial downloads: partial/<sha256>.part. Bounded: one row per
-- object being fetched; abandoned rows are removed with their files.
CREATE TABLE cas_partials (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    expected_size INTEGER NOT NULL,
    bytes_present INTEGER NOT NULL,
    last_source TEXT,
    source_validator TEXT,
    updated_at_ms INTEGER NOT NULL
);

-- Durable pins. Eviction never removes a pinned object.
-- Bounded: pins are released by their holder (presentation, update, ...).
CREATE TABLE cas_pins (
    sha256 TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('active_presentation', 'pending_presentation', 'prefetch', 'update', 'renderer_release', 'migration', 'manual')),
    holder TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    PRIMARY KEY (sha256, reason, holder)
);
CREATE INDEX cas_pins_sha256 ON cas_pins (sha256);

-- Current capability snapshot only; never history.
CREATE TABLE capability_state (
    capability_id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    changed_at_ms INTEGER NOT NULL
);

CREATE TABLE capability_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    reported_revision INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);

-- Durable outbound reports (Activity events). Bounded: at most 500 rows; the
-- oldest are dropped first and a drop counter is kept.
CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('activity_event')),
    dedupe_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NOT NULL
);

CREATE TABLE outbox_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dropped_count INTEGER NOT NULL DEFAULT 0
);

-- Command idempotency: a disruptive command is recorded here before it
-- runs, so a restart never runs it twice. Bounded: 30-day replay window.
CREATE TABLE command_idempotency (
    command_id TEXT PRIMARY KEY,
    command_type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('received', 'acknowledged', 'executing', 'completed')),
    result_code TEXT,
    received_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER
);

-- Software update staging (Edge-managed updates, docs/tilecast-edge.md §15). One row per
-- release under consideration; bounded by pruning terminal rows.
CREATE TABLE update_staging (
    release_id TEXT PRIMARY KEY,
    component TEXT NOT NULL,
    version TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    artifact_size INTEGER NOT NULL,
    deployment_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('staged', 'verified', 'installing', 'pending_confirm', 'confirmed', 'rolled_back', 'failed')),
    updated_at_ms INTEGER NOT NULL
);

-- Current renderer supervision state.
CREATE TABLE renderer_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_ready_at_ms INTEGER,
    last_progress_at_ms INTEGER,
    restart_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    safe_mode INTEGER NOT NULL DEFAULT 0 CHECK (safe_mode IN (0, 1)),
    safe_mode_reason TEXT,
    updated_at_ms INTEGER NOT NULL
);

-- Playback facts that must survive restarts: the administrative
-- playback-disabled flag and the last server clock offset (docs/tilecast-edge.md §13).
CREATE TABLE playback_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    playback_disabled INTEGER NOT NULL DEFAULT 0 CHECK (playback_disabled IN (0, 1)),
    server_clock_offset_ms INTEGER,
    server_clock_synchronized_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
);

-- One-time import of the legacy Electron player's state (docs/tilecast-edge.md §14.2).
CREATE TABLE legacy_import (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    importer_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed')),
    source_dir TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    failure_code TEXT,
    summary TEXT NOT NULL DEFAULT '{}'
);
