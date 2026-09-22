-- Tilecast Edge foundation (docs/tilecast-edge.md §32, Amendment A1).
--
-- Only public material is stored here. The Edge authority signing key and the
-- installation Edge CA key are files under TILECAST_EDGE_ROOT; node private
-- keys never leave their nodes.

-- +goose Up
CREATE TABLE edge_authority (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    installation_id TEXT NOT NULL,
    authority_epoch INTEGER NOT NULL CHECK (authority_epoch > 0),
    authority_public_key BYTEA NOT NULL CHECK (octet_length(authority_public_key) = 32),
    authority_key_id TEXT NOT NULL,
    ca_certificate_der BYTEA NOT NULL,
    ca_fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per issued node certificate. credential_id binds the certificate to
-- the device credential that requested it, so replacing or revoking that
-- credential revokes the Edge identity in the same transaction.
CREATE TABLE edge_node_certificates (
    id UUID PRIMARY KEY,
    screen_id UUID NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
    credential_id UUID REFERENCES device_credentials(id) ON DELETE SET NULL,
    node_id TEXT NOT NULL,
    serial_number TEXT NOT NULL UNIQUE,
    public_key_fingerprint TEXT NOT NULL,
    certificate_fingerprint TEXT NOT NULL UNIQUE,
    not_before TIMESTAMPTZ NOT NULL,
    not_after TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX edge_node_certificates_screen ON edge_node_certificates (screen_id, created_at);
CREATE INDEX edge_node_certificates_active_node ON edge_node_certificates (node_id) WHERE revoked_at IS NULL;

-- Monotonic revocation generation carried in every signed change.
CREATE TABLE edge_revocation_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    generation BIGINT NOT NULL DEFAULT 0
);

-- Transactional outbox: written in the same transaction as the authoritative
-- change, then signed and published by the single serialized signer.
-- payload holds canonical JSON bytes (BYTEA so nothing reformats them).
CREATE TABLE edge_change_outbox (
    id BIGSERIAL PRIMARY KEY,
    change_type TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('installation', 'screen', 'display_group', 'node')),
    target_id UUID,
    object_sha256 TEXT CHECK (object_sha256 IS NULL OR object_sha256 ~ '^[0-9a-f]{64}$'),
    object_size_bytes BIGINT,
    object_kind TEXT,
    payload BYTEA NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_sequence BIGINT
);
CREATE INDEX edge_change_outbox_pending ON edge_change_outbox (id) WHERE published_sequence IS NULL;

-- The signed feed. signed_document is the exact wrapper nodes verify and
-- relay. Sequences are monotonic and may skip integers; previous_sequence is
-- the signed link to the change published immediately before.
CREATE TABLE edge_changes (
    sequence BIGSERIAL PRIMARY KEY,
    previous_sequence BIGINT NOT NULL,
    change_type TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id UUID,
    body_digest TEXT NOT NULL,
    signed_document BYTEA NOT NULL,
    outbox_id BIGINT UNIQUE REFERENCES edge_change_outbox(id) ON DELETE SET NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ
);

-- Current Edge node status projection (never history; RFC §32.2).
CREATE TABLE edge_node_status (
    screen_id UUID PRIMARY KEY REFERENCES screens(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    edge_version TEXT NOT NULL,
    renderer_kind TEXT,
    renderer_version TEXT,
    renderer_state TEXT,
    mesh_state TEXT,
    peer_count INTEGER NOT NULL DEFAULT 0,
    cache_used_bytes BIGINT,
    cache_limit_bytes BIGINT,
    capability_revision BIGINT NOT NULL DEFAULT 0,
    capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_edge_contact_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE edge_node_status;
DROP TABLE edge_changes;
DROP TABLE edge_change_outbox;
DROP TABLE edge_revocation_state;
DROP TABLE edge_node_certificates;
DROP TABLE edge_authority;
