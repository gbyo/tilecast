-- +goose Up

CREATE TABLE countdown_bar_instances (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organization_settings(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 180),
    message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 280),
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('weekly', 'one_time')),
    target_time TIME,
    days_of_week SMALLINT[] NOT NULL DEFAULT '{}',
    one_time_at TIMESTAMPTZ,
    timezone TEXT NOT NULL,
    lead_time_seconds INTEGER NOT NULL CHECK (lead_time_seconds BETWEEN 60 AND 2592000),
    completion_text TEXT NOT NULL DEFAULT '' CHECK (char_length(completion_text) <= 280),
    display_mode TEXT NOT NULL CHECK (display_mode IN ('overlay', 'push')),
    height_px INTEGER NOT NULL CHECK (height_px BETWEEN 40 AND 320),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
    target_scope TEXT NOT NULL CHECK (target_scope IN ('all', 'screens', 'sync_groups', 'locations')),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (schedule_type = 'weekly' AND target_time IS NOT NULL AND cardinality(days_of_week) > 0 AND one_time_at IS NULL)
        OR
        (schedule_type = 'one_time' AND target_time IS NULL AND cardinality(days_of_week) = 0 AND one_time_at IS NOT NULL)
    )
);

CREATE TABLE countdown_bar_targets (
    instance_id UUID NOT NULL REFERENCES countdown_bar_instances(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('screens', 'sync_groups', 'locations')),
    target_id UUID NOT NULL,
    PRIMARY KEY (instance_id, target_type, target_id)
);

CREATE INDEX countdown_bar_instances_enabled_idx
    ON countdown_bar_instances (enabled, priority DESC, updated_at DESC);
CREATE INDEX countdown_bar_targets_lookup_idx
    ON countdown_bar_targets (target_type, target_id, instance_id);

-- +goose Down

DROP TABLE countdown_bar_targets;
DROP TABLE countdown_bar_instances;
