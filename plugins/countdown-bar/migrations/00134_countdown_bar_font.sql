-- +goose Up

-- The organization font library family the bar draws with. It is an ID the
-- font library owns, not a foreign key: the plugin records its use through
-- Host.Fonts, and the library refuses to remove a family that is in use.
-- NULL keeps the Player's own face.
ALTER TABLE countdown_bar_instances
    ADD COLUMN font_id UUID;

-- +goose Down

ALTER TABLE countdown_bar_instances
    DROP COLUMN font_id;
