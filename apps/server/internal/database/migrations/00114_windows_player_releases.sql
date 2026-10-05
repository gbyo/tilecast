-- +goose Up

-- The Windows Player is a fourth release family beside Android, the Electron
-- Linux Player, and Tilecast Edge. Like Edge it is architecture-specific
-- (`x86_64` or `aarch64`); its artifact is a signed MSIX package selected by
-- the same Tilecast-signed envelope, so the shape, uniqueness, and GitHub
-- constraints below already cover it once the family is admitted. The envelope
-- bytes are kept for the same reason as Edge's: a screen verifies the
-- signature over those bytes and `jsonb` does not preserve them. Windows
-- carries no Edge state schema version: the MSIX package carries its own
-- signed publisher identity, and the envelope binds only the package
-- name, size, and SHA-256.

ALTER TABLE player_releases DROP CONSTRAINT player_releases_platform_check;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_platform_check
    CHECK (platform IN ('android', 'linux', 'windows'));

ALTER TABLE player_releases DROP CONSTRAINT player_releases_family_shape_check;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_family_shape_check CHECK (
    (player_family = 'android'
        AND platform = 'android'
        AND architecture = ''
        AND application_id = 'org.tilecast.player'
        AND minimum_sdk >= 23
        AND apk_name = 'tilecast-player.apk')
    OR
    (player_family = 'electron-linux'
        AND platform = 'linux'
        AND architecture = ''
        AND application_id IS NULL
        AND minimum_sdk IS NULL
        AND apk_name = 'tilecast-player.AppImage')
    OR
    (player_family = 'edge'
        AND platform = 'linux'
        AND architecture IN ('x86_64', 'aarch64')
        AND application_id IS NULL
        AND minimum_sdk IS NULL
        AND apk_name = 'tilecast-edge-' || version_name || '-' || architecture || '.tar.zst'
        AND manifest_bytes IS NOT NULL
        AND state_schema_version > 0)
    OR
    (player_family = 'windows'
        AND platform = 'windows'
        AND architecture IN ('x86_64', 'aarch64')
        AND application_id IS NULL
        AND minimum_sdk IS NULL
        AND apk_name = 'tilecast-windows-' || version_name || '-' || architecture || '.msix'
        AND manifest_bytes IS NOT NULL
        AND state_schema_version IS NULL)
);

ALTER TABLE screen_player_status DROP CONSTRAINT screen_player_status_player_family_check;
ALTER TABLE screen_player_status ADD CONSTRAINT screen_player_status_player_family_check
    CHECK (player_family IN ('android', 'electron-linux', 'edge', 'windows'));

-- +goose Down

ALTER TABLE screen_player_status DROP CONSTRAINT screen_player_status_player_family_check;
ALTER TABLE screen_player_status ADD CONSTRAINT screen_player_status_player_family_check
    CHECK (player_family IN ('android', 'electron-linux', 'edge'));

UPDATE screen_player_status SET current_update_deployment_id = NULL
    WHERE current_update_deployment_id IN (
        SELECT d.id FROM update_deployments d JOIN player_releases r ON r.id = d.release_id WHERE r.player_family = 'windows');
DELETE FROM update_deployments
    WHERE release_id IN (SELECT id FROM player_releases WHERE player_family = 'windows');
DELETE FROM player_releases WHERE player_family = 'windows';

ALTER TABLE player_releases DROP CONSTRAINT player_releases_platform_check;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_platform_check
    CHECK (platform IN ('android', 'linux'));

ALTER TABLE player_releases DROP CONSTRAINT player_releases_family_shape_check;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_family_shape_check CHECK (
    (player_family = 'android'
        AND platform = 'android'
        AND architecture = ''
        AND application_id = 'org.tilecast.player'
        AND minimum_sdk >= 23
        AND apk_name = 'tilecast-player.apk')
    OR
    (player_family = 'electron-linux'
        AND platform = 'linux'
        AND architecture = ''
        AND application_id IS NULL
        AND minimum_sdk IS NULL
        AND apk_name = 'tilecast-player.AppImage')
    OR
    (player_family = 'edge'
        AND platform = 'linux'
        AND architecture IN ('x86_64', 'aarch64')
        AND application_id IS NULL
        AND minimum_sdk IS NULL
        AND apk_name = 'tilecast-edge-' || version_name || '-' || architecture || '.tar.zst'
        AND manifest_bytes IS NOT NULL
        AND state_schema_version > 0)
);
