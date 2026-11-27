-- +goose Up
-- +goose StatementBegin

-- Countdown Bar moves to Plugin Manifest API 3: the host stores its
-- instances in plugin_instances. Every existing bar is copied with its ID,
-- so Player state entry IDs, font references, and audit history keep
-- pointing at the same bar. Each schedule type keeps only its own fields,
-- as the Player projection always did. The legacy tables stay, unread, for
-- one release so a downgrade or an investigation can still see them; a
-- later migration drops them.
INSERT INTO plugin_instances (id, organization_id, plugin_id, kind, name, enabled, priority, target_scope,
                              configuration, created_by, updated_by, created_at, updated_at)
SELECT b.id, b.organization_id, 'countdown_bar', 'instance', b.name, b.enabled, b.priority, b.target_scope,
       jsonb_strip_nulls(jsonb_build_object(
           'message', b.message,
           'completionText', NULLIF(b.completion_text, ''),
           'showConfetti', b.show_confetti,
           'scheduleType', b.schedule_type,
           'targetTime', CASE WHEN b.schedule_type = 'weekly' THEN to_char(b.target_time, 'HH24:MI') END,
           'daysOfWeek', CASE WHEN b.schedule_type = 'weekly'
               THEN (SELECT jsonb_agg(DISTINCT day ORDER BY day) FROM unnest(b.days_of_week) AS day) END,
           'oneTimeAt', CASE WHEN b.schedule_type = 'one_time'
               THEN to_char(b.one_time_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
           'timezone', b.timezone,
           'leadTimeSeconds', b.lead_time_seconds,
           'displayMode', b.display_mode,
           'heightPx', b.height_px,
           'progressFill', b.progress_fill,
           'contentPadding', b.content_padding,
           'textScale', b.text_scale,
           'fontId', b.font_id::text,
           'urgencyEnabled', b.urgency_enabled,
           'startingSoonSeconds', b.starting_soon_seconds,
           'urgentSeconds', b.urgent_seconds,
           'pulseSeconds', b.pulse_seconds)),
       b.created_by, b.created_by, b.created_at, b.updated_at
FROM countdown_bar_instances b
ON CONFLICT (id) DO NOTHING;

INSERT INTO plugin_instance_targets (instance_id, target_type, target_id)
SELECT t.instance_id, t.target_type, t.target_id
FROM countdown_bar_targets t
JOIN plugin_instances i ON i.id = t.instance_id AND i.plugin_id = 'countdown_bar'
ON CONFLICT DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- The legacy rows were never changed, so a downgrade reads them again.
-- Changes made after the upgrade exist only in plugin_instances.
DELETE FROM plugin_instances WHERE plugin_id = 'countdown_bar';

-- +goose StatementEnd
