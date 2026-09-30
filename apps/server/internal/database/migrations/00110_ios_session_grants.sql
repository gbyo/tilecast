-- +goose Up
-- A Studio session issued by the Tilecast for iOS bootstrap belongs to the
-- OAuth grant that produced it. The app's cookie and its native credential
-- are one authorization: revoking the grant ends the session, and signing
-- the session out revokes the grant. Sessions from password, passkey, or
-- Demo Mode sign-in have no grant.
ALTER TABLE sessions ADD COLUMN api_grant_id UUID REFERENCES api_grants(id) ON DELETE CASCADE;
CREATE INDEX sessions_api_grant_idx ON sessions(api_grant_id) WHERE api_grant_id IS NOT NULL;

-- +goose Down
DROP INDEX sessions_api_grant_idx;
ALTER TABLE sessions DROP COLUMN api_grant_id;
