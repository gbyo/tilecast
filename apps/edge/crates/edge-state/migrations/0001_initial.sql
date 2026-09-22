-- Tilecast Edge state schema, version 1.
--
-- Conventions:
--   * Timestamps are INTEGER Unix milliseconds in UTC, named *_at_ms.
--   * Identifiers are canonical lowercase UUID or SHA-256 hex TEXT.
--   * Singletons use `id INTEGER PRIMARY KEY CHECK (id = 1)`.
--   * No table is an unbounded history. Every table that can grow names its
--     bound in a comment, and the owning repository module enforces it.
--   * Secrets never live here. The device credential and node private keys
--     are files in the identity directory; this schema records only that
--     they exist and public metadata about them.
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

-- The durable node identity: the Linux player's playerInstallationId.
CREATE TABLE node_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    node_id TEXT NOT NULL,
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

-- Public trust material pinned at Edge enrollment.
CREATE TABLE edge_trust (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    installation_id TEXT NOT NULL,
    ca_certificate_der BLOB NOT NULL,
    ca_fingerprint TEXT NOT NULL,
    mesh_protocol_version INTEGER NOT NULL,
    latest_sequence_at_enrollment INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

-- Edge authority signing keys by epoch. Overlapping epochs allow rotation.
-- Bounded: the server publishes a handful of epochs over an installation's life.
CREATE TABLE authority_keys (
    epoch INTEGER PRIMARY KEY,
    key_id TEXT NOT NULL UNIQUE,
    public_key BLOB NOT NULL CHECK (length(public_key) = 32),
    added_at_ms INTEGER NOT NULL
);

-- Node certificates. The private key for a certificate is the file
-- identity/node-key-<key_fingerprint>.pk8; a key file not referenced by a
-- 'pending' or 'active' row is an orphan from an interrupted enrollment and
-- is removed at startup.
-- Bounded: superseded rows beyond the newest two are deleted on rotation.
CREATE TABLE node_certificates (
    fingerprint TEXT PRIMARY KEY,
    serial_number TEXT NOT NULL,
    certificate_der BLOB NOT NULL,
    key_fingerprint TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    screen_id TEXT,
    not_before_ms INTEGER NOT NULL,
    not_after_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'superseded')),
    created_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX node_certificates_one_active ON node_certificates (state) WHERE state = 'active';

-- Revoked peer node IDs. Bounded: entries are forgotten once every
-- certificate of that node has expired (forget_after_ms).
CREATE TABLE revocations (
    node_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    revoked_at_ms INTEGER NOT NULL,
    forget_after_ms INTEGER NOT NULL
);

CREATE TABLE revocation_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);

-- Position in the signed server change feed (RFC Amendment A1.5).
CREATE TABLE change_feed_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_sequence INTEGER NOT NULL,
    highest_seen_sequence INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

-- Verified change envelopes, kept for relay to peers and for conflict
-- detection. Bounded: at most 5,000 rows and 14 days; older applied rows are
-- pruned (see repo::changes::prune).
CREATE TABLE server_changes (
    sequence INTEGER PRIMARY KEY,
    previous_sequence INTEGER NOT NULL,
    change_type TEXT NOT NULL,
    body_digest TEXT NOT NULL,
    document BLOB NOT NULL,
    received_from TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    applied_at_ms INTEGER,
    outcome TEXT CHECK (outcome IN ('applied', 'expired', 'unknown_type', 'not_applicable'))
);

-- Content-addressed objects. The file is cas/sha256/<fanout>/<sha256>.
-- Bounded by the cache limit through eviction.
CREATE TABLE cas_objects (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    domain TEXT NOT NULL CHECK (domain IN ('media', 'edge_object', 'update', 'renderer_bundle', 'legacy_state')),
    content_type TEXT,
    peerable INTEGER NOT NULL CHECK (peerable IN (0, 1)),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('origin', 'peer', 'legacy_import', 'local')),
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
    reason TEXT NOT NULL CHECK (reason IN ('active_presentation', 'pending_presentation', 'prefetch', 'takeover', 'update', 'renderer_release', 'migration', 'manual')),
    holder TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    PRIMARY KEY (sha256, reason, holder)
);
CREATE INDEX cas_pins_sha256 ON cas_pins (sha256);

-- Peers observed on the mesh. Bounded: rows not seen for 30 days are pruned.
CREATE TABLE peers (
    node_id TEXT PRIMARY KEY,
    screen_id TEXT,
    edge_version TEXT,
    blob_endpoint TEXT,
    certificate_fingerprint TEXT,
    first_seen_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL
);

-- Rolling transfer scores, flushed on a cadence. One row per peer.
CREATE TABLE peer_transfer_scores (
    node_id TEXT PRIMARY KEY REFERENCES peers (node_id) ON DELETE CASCADE,
    successes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    integrity_failures INTEGER NOT NULL DEFAULT 0,
    last_rtt_ms INTEGER,
    throughput_bytes_per_second INTEGER,
    cooldown_until_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
);

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

-- Durable outbound reports (Activity events, Edge status). Bounded: at most
-- 500 rows; the oldest are dropped first and a drop counter is kept.
CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('activity_event', 'edge_status')),
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

-- Software update staging (Edge-managed updates, RFC §30). One row per
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
-- playback-disabled flag and the last server clock offset (RFC §20.3).
CREATE TABLE playback_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    playback_disabled INTEGER NOT NULL DEFAULT 0 CHECK (playback_disabled IN (0, 1)),
    server_clock_offset_ms INTEGER,
    server_clock_synchronized_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
);

-- Effective Context Engine values, so playback can restart offline.
-- Bounded: one row per (key, scope) the node uses.
CREATE TABLE context_effective (
    context_key TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    document TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (context_key, scope_kind, scope_id)
);

-- One-time import of the legacy Electron player's state (Amendment A1.3).
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
