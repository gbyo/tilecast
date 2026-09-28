-- +goose Up

-- NWS automation owns its generated presentation resources. They remain valid
-- playback graph records, but are hidden from ordinary authoring libraries so
-- live alert snapshots never look like user-authored content.
ALTER TABLE assets ADD COLUMN system_managed boolean NOT NULL DEFAULT FALSE;
ALTER TABLE playlists ADD COLUMN system_managed boolean NOT NULL DEFAULT FALSE;
ALTER TABLE data_sources ADD COLUMN system_managed boolean NOT NULL DEFAULT FALSE;

ALTER TABLE alert_rules
    ADD COLUMN presentation_mode text NOT NULL DEFAULT 'builtin'
        CHECK (presentation_mode IN ('builtin','playlist')),
    ADD COLUMN managed_data_source_id uuid REFERENCES data_sources(id) ON DELETE SET NULL,
    ADD COLUMN managed_widget_id uuid REFERENCES assets(id) ON DELETE SET NULL,
    ADD COLUMN managed_playlist_id uuid REFERENCES playlists(id) ON DELETE SET NULL;

-- Existing rules intentionally selected a playlist. Preserve that behavior;
-- newly created rules use Tilecast's built-in live NWS presentation by default.
UPDATE alert_rules SET presentation_mode='playlist';

-- +goose Down
ALTER TABLE alert_rules
    DROP COLUMN managed_playlist_id,
    DROP COLUMN managed_widget_id,
    DROP COLUMN managed_data_source_id,
    DROP COLUMN presentation_mode;
ALTER TABLE data_sources DROP COLUMN system_managed;
ALTER TABLE playlists DROP COLUMN system_managed;
ALTER TABLE assets DROP COLUMN system_managed;
