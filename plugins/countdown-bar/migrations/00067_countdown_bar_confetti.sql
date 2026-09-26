-- +goose Up

ALTER TABLE countdown_bar_instances
    ADD COLUMN show_confetti BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down

ALTER TABLE countdown_bar_instances
    DROP COLUMN show_confetti;
