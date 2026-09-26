-- +goose Up

ALTER TABLE countdown_bar_instances
    ADD COLUMN urgency_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN starting_soon_seconds INTEGER NOT NULL DEFAULT 300,
    ADD COLUMN urgent_seconds INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN pulse_seconds INTEGER NOT NULL DEFAULT 10,
    ADD CONSTRAINT countdown_bar_urgency_order_check CHECK (
        starting_soon_seconds > urgent_seconds
        AND urgent_seconds > pulse_seconds
        AND pulse_seconds > 0
    );

-- +goose Down

ALTER TABLE countdown_bar_instances
    DROP CONSTRAINT countdown_bar_urgency_order_check,
    DROP COLUMN pulse_seconds,
    DROP COLUMN urgent_seconds,
    DROP COLUMN starting_soon_seconds,
    DROP COLUMN urgency_enabled;
