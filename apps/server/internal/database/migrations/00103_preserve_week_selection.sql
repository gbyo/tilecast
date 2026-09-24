-- +goose Up

-- Before current-week selection consumed organization.first_day_of_week, the
-- player paths used Monday. Preserve that effective boundary for existing
-- installations that never stored an explicit value. New installations keep
-- the registry default (Sunday), and an existing explicit choice is untouched.
CREATE TEMP TABLE regional_week_changed_organizations ON COMMIT DROP AS
SELECT organization_settings.id AS organization_id
FROM organization_settings
LEFT JOIN organization_runtime_settings
  ON organization_runtime_settings.organization_id = organization_settings.id
WHERE organization_runtime_settings.organization_id IS NULL
   OR NOT (organization_runtime_settings.settings ? 'organization.first_day_of_week');

INSERT INTO organization_runtime_settings(organization_id, settings)
SELECT organization_id,
       jsonb_build_object('organization.first_day_of_week', 'monday')
FROM regional_week_changed_organizations
ON CONFLICT (organization_id) DO UPDATE
SET settings = organization_runtime_settings.settings ||
               jsonb_build_object('organization.first_day_of_week', 'monday'),
    revision = organization_runtime_settings.revision + 1,
    updated_at = now()
WHERE NOT (organization_runtime_settings.settings ? 'organization.first_day_of_week');

INSERT INTO screen_config_state(screen_id)
SELECT screens.id
FROM screens
JOIN regional_week_changed_organizations changed
  ON changed.organization_id = screens.organization_id
ON CONFLICT (screen_id) DO NOTHING;

UPDATE screen_config_state
SET config_revision = config_revision + 1,
    changed_at = now(),
    change_reason = 'regional_week_migration'
WHERE screen_id IN (
  SELECT screens.id
  FROM screens
  JOIN regional_week_changed_organizations changed
    ON changed.organization_id = screens.organization_id
);

INSERT INTO screen_manifest_state(screen_id)
SELECT screens.id
FROM screens
JOIN regional_week_changed_organizations changed
  ON changed.organization_id = screens.organization_id
ON CONFLICT (screen_id) DO NOTHING;

UPDATE screen_manifest_state
SET previous_manifest_version = manifest_version,
    manifest_version = manifest_version + 1,
    changed_at = now(),
    change_reason = 'regional_week_migration'
WHERE screen_id IN (
  SELECT screens.id
  FROM screens
  JOIN regional_week_changed_organizations changed
    ON changed.organization_id = screens.organization_id
);

-- +goose Down
-- Keep the now-explicit weekday. Removing it could erase a later administrator
-- choice and would restore the previous player behavior only by code accident.
SELECT 1;
