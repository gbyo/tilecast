-- +goose Up
-- +goose StatementBegin
-- Edge renderer diagnostics from the heartbeat: the last categorized
-- renderer failure, renderer restart count with its last reason and time,
-- and the safe-mode reason. All nullable: older players omit them, and a
-- missing value must stay visibly unknown rather than read as zero.
ALTER TABLE screen_player_status
    ADD COLUMN last_renderer_failure text
        CHECK (last_renderer_failure IS NULL OR char_length(last_renderer_failure) BETWEEN 1 AND 64),
    ADD COLUMN renderer_restart_count integer
        CHECK (renderer_restart_count IS NULL OR renderer_restart_count BETWEEN 0 AND 1000000),
    ADD COLUMN last_renderer_restart_at timestamptz,
    ADD COLUMN last_renderer_restart_reason text
        CHECK (last_renderer_restart_reason IS NULL OR char_length(last_renderer_restart_reason) BETWEEN 1 AND 64),
    ADD COLUMN safe_mode_reason text
        CHECK (safe_mode_reason IS NULL OR char_length(safe_mode_reason) BETWEEN 1 AND 240);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE screen_player_status
    DROP COLUMN last_renderer_failure,
    DROP COLUMN renderer_restart_count,
    DROP COLUMN last_renderer_restart_at,
    DROP COLUMN last_renderer_restart_reason,
    DROP COLUMN safe_mode_reason;
-- +goose StatementEnd
