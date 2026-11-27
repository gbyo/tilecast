-- +goose Up
-- +goose StatementBegin

-- OAuth 2.0 connections of Plugin Manifest API 3 plugins
-- (docs/plugin-connections.md#oauth-20-connections). The connection row holds
-- the OAuth state the host must enforce; the client secret and the tokens are
-- plugin secrets owned by the connection, encrypted like every other plugin
-- secret. Tilecast is the OAuth client here. These rows are unrelated to
-- internal/oauth, where Tilecast is the authorization server.
ALTER TABLE plugin_connections
    ADD COLUMN oauth_client_id TEXT CHECK (oauth_client_id IS NULL OR char_length(oauth_client_id) BETWEEN 1 AND 256),
    ADD COLUMN oauth_status TEXT CHECK (oauth_status IS NULL OR oauth_status IN ('not_connected', 'connected', 'reconnect_required')),
    -- The declaration fingerprint the tokens were granted for. A release that
    -- changes the endpoints or the scopes needs a new connection.
    ADD COLUMN oauth_fingerprint TEXT CHECK (oauth_fingerprint IS NULL OR oauth_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD COLUMN oauth_access_expires_at TIMESTAMPTZ,
    ADD COLUMN oauth_connected_at TIMESTAMPTZ,
    ADD COLUMN oauth_connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN oauth_refreshed_at TIMESTAMPTZ,
    -- A stable failure code of the last refresh, cleared by a success.
    ADD COLUMN oauth_last_error TEXT CHECK (oauth_last_error IS NULL OR oauth_last_error ~ '^[a-z_]{1,64}$'),
    ADD COLUMN oauth_last_error_at TIMESTAMPTZ,
    -- What the last disconnect learned from the provider.
    ADD COLUMN oauth_revocation TEXT CHECK (oauth_revocation IS NULL OR oauth_revocation IN ('confirmed', 'failed', 'not_declared')),
    ADD COLUMN oauth_disconnected_at TIMESTAMPTZ;

-- A connection can own plugin secrets: the OAuth client secret, the tokens,
-- and the PKCE verifier of an attempt in progress. Deleting the connection
-- deletes them.
ALTER TABLE plugin_secrets ADD COLUMN connection_id UUID REFERENCES plugin_connections(id) ON DELETE CASCADE;
ALTER TABLE plugin_secrets DROP CONSTRAINT plugin_secrets_owner_type_check;
ALTER TABLE plugin_secrets ADD CONSTRAINT plugin_secrets_owner_type_check
    CHECK (owner_type IN ('organization', 'instance', 'screen', 'connection'));
ALTER TABLE plugin_secrets DROP CONSTRAINT plugin_secrets_check;
ALTER TABLE plugin_secrets ADD CONSTRAINT plugin_secrets_owner_check CHECK (
    (owner_type = 'organization' AND instance_id IS NULL AND screen_id IS NULL AND connection_id IS NULL)
    OR (owner_type = 'instance' AND instance_id = owner_id AND screen_id IS NULL AND connection_id IS NULL)
    OR (owner_type = 'screen' AND screen_id = owner_id AND instance_id IS NULL AND connection_id IS NULL)
    OR (owner_type = 'connection' AND connection_id = owner_id AND instance_id IS NULL AND screen_id IS NULL)
);

-- One authorization attempt in progress for each connection. The state is
-- stored only as its SHA-256 hash, the attempt expires after ten minutes,
-- and the callback consumes it with one conditional DELETE, so it is single
-- use across every Server process. The PKCE verifier is a connection secret.
CREATE TABLE plugin_oauth_transactions (
    state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    connection_id UUID NOT NULL UNIQUE REFERENCES plugin_connections(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX plugin_oauth_transactions_expiry_idx ON plugin_oauth_transactions (expires_at);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE plugin_oauth_transactions;
DELETE FROM plugin_secrets WHERE owner_type = 'connection';
ALTER TABLE plugin_secrets DROP CONSTRAINT plugin_secrets_owner_check;
ALTER TABLE plugin_secrets ADD CONSTRAINT plugin_secrets_check CHECK (
    (owner_type = 'organization' AND instance_id IS NULL AND screen_id IS NULL)
    OR (owner_type = 'instance' AND instance_id = owner_id AND screen_id IS NULL)
    OR (owner_type = 'screen' AND screen_id = owner_id AND instance_id IS NULL)
);
ALTER TABLE plugin_secrets DROP CONSTRAINT plugin_secrets_owner_type_check;
ALTER TABLE plugin_secrets ADD CONSTRAINT plugin_secrets_owner_type_check
    CHECK (owner_type IN ('organization', 'instance', 'screen'));
ALTER TABLE plugin_secrets DROP COLUMN connection_id;
ALTER TABLE plugin_connections
    DROP COLUMN oauth_disconnected_at,
    DROP COLUMN oauth_revocation,
    DROP COLUMN oauth_last_error_at,
    DROP COLUMN oauth_last_error,
    DROP COLUMN oauth_refreshed_at,
    DROP COLUMN oauth_connected_by,
    DROP COLUMN oauth_connected_at,
    DROP COLUMN oauth_access_expires_at,
    DROP COLUMN oauth_fingerprint,
    DROP COLUMN oauth_status,
    DROP COLUMN oauth_client_id;

-- +goose StatementEnd
