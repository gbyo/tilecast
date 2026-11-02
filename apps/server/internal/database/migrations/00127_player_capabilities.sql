-- +goose Up
-- +goose StatementBegin
-- Generic Player Capability status: the bounded `playerCapabilities`
-- report (`{capability: {version, provider}}`) the server validates
-- against the versioned registry. Legacy display-control columns stay
-- untouched; reporters populate both from the same probe.
ALTER TABLE screen_player_status
  ADD COLUMN player_capabilities JSONB;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE screen_player_status
  DROP COLUMN player_capabilities;
-- +goose StatementEnd
