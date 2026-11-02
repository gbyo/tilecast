-- +goose Up
-- +goose StatementBegin
-- Stream-backed videos in the current Edge activation, from the heartbeat:
-- content the player did not fully cache, with reduced offline guarantees.
-- Nullable: older players omit it, and a missing value must stay visibly
-- unknown rather than read as zero.
ALTER TABLE screen_player_status
    ADD COLUMN stream_backed_asset_count integer
        CHECK (stream_backed_asset_count IS NULL OR stream_backed_asset_count BETWEEN 0 AND 1024);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE screen_player_status
    DROP COLUMN stream_backed_asset_count;
-- +goose StatementEnd
