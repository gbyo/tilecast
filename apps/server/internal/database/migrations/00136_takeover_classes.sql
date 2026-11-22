-- +goose Up
-- A Takeover class orders Takeovers that share a screen. The strongest class
-- is shown; a weaker one waits on that screen until the stronger one ends.
-- An activation no longer cancels another Takeover. Existing rows were
-- started by operators or packages before classes existed, so they become
-- operator Takeovers. Emergency Alerts reclassifies its own rows in its
-- plugin migration.
-- +goose StatementBegin
ALTER TABLE takeovers
    ADD COLUMN class text NOT NULL DEFAULT 'operator'
    CHECK (class IN ('life_safety', 'emergency', 'operator', 'automation'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE takeovers DROP COLUMN class;
-- +goose StatementEnd
