-- +goose Up

-- Alert Banner is a distinct visual purpose again. Status remains a panel,
-- while shallow horizontal alert bands use the first-class alert-banner
-- component. Keep asset IDs unchanged so playlists and Layout placements do
-- not move; only the Widget provider/configuration changes.
WITH migrated AS (
    UPDATE widgets
    SET
        provider = 'alert-banner',
        config_version = 1,
        configuration = jsonb_build_object(
            'dataSourceId', COALESCE(configuration->>'dataSourceId', ''),
            'messageField', COALESCE(NULLIF(configuration->>'messageField', ''), 'message'),
            'severityField', COALESCE(NULLIF(configuration->>'severityField', ''), 'severity'),
            'labelField', COALESCE(configuration->>'statusField', ''),
            'showSeverity', COALESCE((configuration->>'showSeverity')::boolean, TRUE),
            'speed', COALESCE(NULLIF(configuration->>'speed', ''), 'normal'),
            'emptyState', COALESCE(NULLIF(configuration->>'emptyText', ''), 'No active alerts'),
            'backgroundColor', COALESCE(configuration->>'backgroundColor', ''),
            'foregroundColor', COALESCE(configuration->>'foregroundColor', '')
        ),
        app_configuration = NULL,
        preview_image = NULL,
        preview_content_type = NULL,
        preview_width = NULL,
        preview_height = NULL,
        preview_updated_at = NULL,
        updated_at = now()
    WHERE provider = 'status'
      AND COALESCE(configuration->>'style', 'panel') = 'banner'
    RETURNING asset_id
)
UPDATE assets
SET metadata = COALESCE(metadata, '{}'::jsonb) - 'widgetPreviewCaptureVersion'
WHERE id IN (SELECT asset_id FROM migrated);

-- +goose Down

-- Provider identity is intentionally normalized forward. Reconstructing the
-- old Status/banner configuration would reintroduce the geometry bug.
SELECT 1;
