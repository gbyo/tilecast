-- +goose Up
ALTER TABLE screen_previews
    ADD COLUMN capture_trigger text NOT NULL DEFAULT 'scheduled'
    CHECK (capture_trigger IN ('scheduled', 'manual'));

-- +goose Down
ALTER TABLE screen_previews DROP COLUMN capture_trigger;
