-- +goose Up
-- +goose StatementBegin
-- The bounded Browser section of a Browser Player heartbeat: facts only a
-- browser can measure. It is validated and rebuilt by the server on every
-- heartbeat, so nothing the player sends is stored as it arrived.
ALTER TABLE screen_player_status ADD COLUMN browser_status JSONB;
ALTER TABLE screen_player_status ADD CONSTRAINT screen_player_status_browser_status_object
    CHECK (browser_status IS NULL OR jsonb_typeof(browser_status) = 'object');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE screen_player_status DROP CONSTRAINT screen_player_status_browser_status_object;
ALTER TABLE screen_player_status DROP COLUMN browser_status;
-- +goose StatementEnd
