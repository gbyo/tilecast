-- +goose Up
-- User API grants: one generic grant row per OAuth authorization or
-- personal access token. OAuth codes and tokens reference the grant;
-- PATs reference the same grant model directly, with no synthetic OAuth
-- client row. First-party OAuth client IDs (tilecast-cli, tilecast-mcp)
-- are stable protocol constants validated in code, not database rows:
-- Tilecast v1 is not a general OAuth provider, so there is no client
-- registration table.
CREATE TABLE api_grants (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('oauth','pat')),
    client_id TEXT,
    name TEXT,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT api_grants_kind_fields CHECK (
        (kind = 'oauth' AND client_id IS NOT NULL AND name IS NULL) OR
        (kind = 'pat' AND client_id IS NULL AND name IS NOT NULL)
    )
);
CREATE INDEX api_grants_user_idx ON api_grants(user_id, created_at DESC, id DESC);
CREATE TABLE oauth_authorization_codes (
    code_hash BYTEA PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES api_grants(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);
CREATE TABLE oauth_access_tokens (
    token_hash BYTEA PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES api_grants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE oauth_refresh_tokens (
    token_hash BYTEA PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES api_grants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    replaced_by BYTEA,
    reuse_detected_at TIMESTAMPTZ
);
CREATE INDEX oauth_refresh_grant_idx ON oauth_refresh_tokens(grant_id, created_at DESC);
ALTER TABLE audit_logs ADD COLUMN api_grant_id UUID REFERENCES api_grants(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE audit_logs DROP COLUMN api_grant_id;
DROP INDEX oauth_refresh_grant_idx;
DROP TABLE oauth_refresh_tokens;
DROP TABLE oauth_access_tokens;
DROP TABLE oauth_authorization_codes;
DROP INDEX api_grants_user_idx;
DROP TABLE api_grants;
