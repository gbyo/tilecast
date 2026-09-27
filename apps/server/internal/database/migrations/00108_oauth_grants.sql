-- +goose Up
CREATE TABLE oauth_clients (
    id UUID PRIMARY KEY,
    client_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    first_party BOOLEAN NOT NULL DEFAULT FALSE,
    redirect_uris TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE oauth_grants (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants(user_id, created_at DESC, id DESC);
CREATE TABLE oauth_authorization_codes (
    code_hash BYTEA PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);
CREATE TABLE oauth_access_tokens (
    token_hash BYTEA PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE oauth_refresh_tokens (
    token_hash BYTEA PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    replaced_by BYTEA,
    reuse_detected_at TIMESTAMPTZ
);
CREATE INDEX oauth_refresh_grant_idx ON oauth_refresh_tokens(grant_id, created_at DESC);
ALTER TABLE audit_logs ADD COLUMN api_grant_id UUID REFERENCES oauth_grants(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE audit_logs DROP COLUMN api_grant_id;
DROP INDEX oauth_refresh_grant_idx;
DROP TABLE oauth_refresh_tokens;
DROP TABLE oauth_access_tokens;
DROP TABLE oauth_authorization_codes;
DROP INDEX oauth_grants_user_idx;
DROP TABLE oauth_grants;
DROP TABLE oauth_clients;
