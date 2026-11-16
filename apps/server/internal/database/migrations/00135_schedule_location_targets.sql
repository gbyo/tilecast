-- +goose Up

-- A schedule may target a location. It reaches every active screen at the
-- location and, because a Display Group plays one schedule on all of its
-- members, every member of a group that holds one of those screens.
ALTER TABLE schedule_targets
    DROP CONSTRAINT schedule_targets_target_type_check,
    DROP CONSTRAINT schedule_targets_check,
    ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
    ADD CONSTRAINT schedule_targets_target_type_check
        CHECK (target_type IN ('screen', 'group', 'location')),
    ADD CONSTRAINT schedule_targets_check
        CHECK ((target_type = 'screen' AND screen_id IS NOT NULL AND screen_group_id IS NULL AND location_id IS NULL)
            OR (target_type = 'group' AND screen_id IS NULL AND screen_group_id IS NOT NULL AND location_id IS NULL)
            OR (target_type = 'location' AND screen_id IS NULL AND screen_group_id IS NULL AND location_id IS NOT NULL)),
    ADD CONSTRAINT schedule_targets_schedule_id_location_id_key UNIQUE (schedule_id, location_id);

CREATE INDEX schedule_targets_location_idx ON schedule_targets(location_id) WHERE location_id IS NOT NULL;

-- The screens a set of locations reaches: every active screen at one of them,
-- plus the members of the Display Groups that hold those screens. Archived
-- screens never match.
-- +goose StatementBegin
CREATE FUNCTION location_target_screens(locations uuid[]) RETURNS TABLE(screen_id uuid)
LANGUAGE sql STABLE AS $$
    SELECT sc.id
    FROM screens sc
    WHERE sc.location_id = ANY(locations) AND sc.archived_at IS NULL AND sc.deleted_at IS NULL
    UNION
    SELECT peer.screen_id
    FROM screens sc
    JOIN screen_group_memberships own ON own.screen_id = sc.id
    JOIN screen_group_memberships peer ON peer.screen_group_id = own.screen_group_id
    WHERE sc.location_id = ANY(locations) AND sc.archived_at IS NULL AND sc.deleted_at IS NULL
$$;
-- +goose StatementEnd

-- One definition of which screens a schedule reaches. direct is true only for
-- a screen the schedule names itself; a group or location reaches the same
-- screen indirectly, with lower specificity.
CREATE VIEW schedule_target_screens AS
SELECT t.schedule_id, t.screen_id AS screen_id, true AS direct
FROM schedule_targets t
WHERE t.target_type = 'screen'
UNION ALL
SELECT t.schedule_id, m.screen_id, false
FROM schedule_targets t
JOIN screen_group_memberships m ON m.screen_group_id = t.screen_group_id
WHERE t.target_type = 'group'
UNION ALL
SELECT t.schedule_id, reached.screen_id, false
FROM schedule_targets t
CROSS JOIN LATERAL location_target_screens(ARRAY[t.location_id]) reached
WHERE t.target_type = 'location';

-- +goose Down

DROP VIEW schedule_target_screens;
DROP FUNCTION location_target_screens(uuid[]);
DELETE FROM schedule_targets WHERE target_type = 'location';
DROP INDEX schedule_targets_location_idx;
ALTER TABLE schedule_targets
    DROP CONSTRAINT schedule_targets_schedule_id_location_id_key,
    DROP CONSTRAINT schedule_targets_check,
    DROP CONSTRAINT schedule_targets_target_type_check,
    DROP COLUMN location_id,
    ADD CONSTRAINT schedule_targets_target_type_check CHECK (target_type IN ('screen', 'group')),
    ADD CONSTRAINT schedule_targets_check
        CHECK ((target_type = 'screen' AND screen_id IS NOT NULL AND screen_group_id IS NULL)
            OR (target_type = 'group' AND screen_id IS NULL AND screen_group_id IS NOT NULL));
