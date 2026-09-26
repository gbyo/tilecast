-- +goose Up

-- An enum rather than a boolean: the bar may later gain other fill behaviors
-- (growing with elapsed time, for instance) without a second migration.
ALTER TABLE countdown_bar_instances
    ADD COLUMN progress_fill TEXT NOT NULL DEFAULT 'none'
        CHECK (progress_fill IN ('none', 'drain'));

-- +goose Down

ALTER TABLE countdown_bar_instances DROP COLUMN progress_fill;
