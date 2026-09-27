-- +goose Up
ALTER TABLE oauth_grants ADD COLUMN name TEXT;

-- +goose Down
ALTER TABLE oauth_grants DROP COLUMN name;
