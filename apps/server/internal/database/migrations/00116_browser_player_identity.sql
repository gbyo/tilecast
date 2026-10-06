-- +goose Up
CREATE TABLE browser_player_slots (
    id UUID PRIMARY KEY,
    screen_id UUID NOT NULL UNIQUE REFERENCES screens(id) ON DELETE CASCADE,
    active_binding_epoch BIGINT NOT NULL DEFAULT 0 CHECK (active_binding_epoch >= 0),
    recovery_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE browser_player_recovery_credentials (
    id UUID PRIMARY KEY,
    slot_id UUID NOT NULL REFERENCES browser_player_slots(id) ON DELETE CASCADE,
    secret_digest BYTEA NOT NULL CHECK (octet_length(secret_digest) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX browser_player_one_active_recovery
    ON browser_player_recovery_credentials(slot_id) WHERE revoked_at IS NULL;

CREATE TABLE browser_player_bindings (
    id UUID PRIMARY KEY,
    slot_id UUID NOT NULL REFERENCES browser_player_slots(id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL CHECK (epoch > 0),
    credential_id UUID NOT NULL UNIQUE REFERENCES device_credentials(id) ON DELETE CASCADE,
    installation_id UUID NOT NULL,
    public_key JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    UNIQUE(slot_id, epoch)
);
CREATE UNIQUE INDEX browser_player_one_active_binding
    ON browser_player_bindings(slot_id) WHERE revoked_at IS NULL;

CREATE TABLE browser_player_sessions (
    secret_digest BYTEA PRIMARY KEY CHECK (octet_length(secret_digest) = 32),
    binding_id UUID NOT NULL UNIQUE REFERENCES browser_player_bindings(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each binding has at most one outstanding, single-use challenge.
CREATE TABLE browser_player_challenges (
    binding_id UUID PRIMARY KEY REFERENCES browser_player_bindings(id) ON DELETE CASCADE,
    nonce_digest BYTEA NOT NULL CHECK (octet_length(nonce_digest) = 32),
    expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE screen_player_status DROP CONSTRAINT screen_player_status_player_family_check;
ALTER TABLE screen_player_status ADD CONSTRAINT screen_player_status_player_family_check
    CHECK (player_family IN ('android', 'electron-linux', 'edge', 'windows', 'browser'));

-- +goose Down
UPDATE screen_player_status SET player_family=NULL WHERE player_family='browser';
ALTER TABLE screen_player_status DROP CONSTRAINT screen_player_status_player_family_check;
ALTER TABLE screen_player_status ADD CONSTRAINT screen_player_status_player_family_check
    CHECK (player_family IN ('android', 'electron-linux', 'edge', 'windows'));
DROP TABLE browser_player_challenges;
DROP TABLE browser_player_sessions;
DROP TABLE browser_player_bindings;
DROP TABLE browser_player_recovery_credentials;
DROP TABLE browser_player_slots;
