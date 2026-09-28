-- +goose Up

-- A screen whose own assignment is a Layout keeps it across a sync group
-- membership, like one whose assignment is a playlist.
ALTER TABLE screen_group_membership_snapshots
    ADD COLUMN layout_id UUID REFERENCES layouts(id) ON DELETE SET NULL;

-- +goose Down

ALTER TABLE screen_group_membership_snapshots DROP COLUMN layout_id;
