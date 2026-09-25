-- +goose Up

-- A Player release family, beside the operating-system platform. `linux`
-- describes both the Electron Linux Player (an AppImage) and Tilecast Edge
-- (a signed release archive with its own installer), so the platform alone
-- cannot decide which screens a release may reach. Existing rows keep their
-- meaning: Android releases are `android`, Linux releases are `electron-linux`.
--
-- Edge releases are architecture-specific and keep the exact signed envelope
-- bytes, because a screen verifies the signature over those bytes and `jsonb`
-- does not preserve them.

ALTER TABLE player_releases
    ADD COLUMN player_family text NOT NULL DEFAULT 'android',
    ADD COLUMN architecture text NOT NULL DEFAULT '',
    ADD COLUMN manifest_bytes bytea,
    ADD COLUMN state_schema_version integer;

UPDATE player_releases SET player_family = 'electron-linux' WHERE platform = 'linux';

ALTER TABLE player_releases DROP CONSTRAINT player_releases_platform_shape_check;
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

-- Version codes are monotonic within one family and architecture.
ALTER TABLE player_releases DROP CONSTRAINT player_releases_platform_version_code_key;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_family_version_code_key
    UNIQUE (player_family, architecture, version_code);

-- One GitHub release can carry an Edge archive for each architecture.
ALTER TABLE player_releases DROP CONSTRAINT player_releases_github_release_id_key;
ALTER TABLE player_releases DROP CONSTRAINT player_releases_github_tag_key;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_github_release_family_key
    UNIQUE (github_release_id, player_family, architecture);
ALTER TABLE player_releases ADD CONSTRAINT player_releases_github_tag_family_key
    UNIQUE (github_tag, player_family, architecture);

-- What the running player says it is. NULL means the player did not say:
-- older Electron and Android players, whose family follows from the platform.
ALTER TABLE screen_player_status
    ADD COLUMN player_family text CHECK (player_family IN ('android', 'electron-linux', 'edge')),
    ADD COLUMN player_architecture text CHECK (player_architecture IN ('x86_64', 'aarch64'));

-- +goose Down

ALTER TABLE screen_player_status
    DROP COLUMN player_architecture,
    DROP COLUMN player_family;

UPDATE screen_player_status SET current_update_deployment_id = NULL
    WHERE current_update_deployment_id IN (
        SELECT d.id FROM update_deployments d JOIN player_releases r ON r.id = d.release_id WHERE r.player_family = 'edge');
DELETE FROM update_deployments
    WHERE release_id IN (SELECT id FROM player_releases WHERE player_family = 'edge');
DELETE FROM player_releases WHERE player_family = 'edge';

ALTER TABLE player_releases DROP CONSTRAINT player_releases_github_tag_family_key;
ALTER TABLE player_releases DROP CONSTRAINT player_releases_github_release_family_key;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_github_tag_key UNIQUE (github_tag);
ALTER TABLE player_releases ADD CONSTRAINT player_releases_github_release_id_key UNIQUE (github_release_id);

ALTER TABLE player_releases DROP CONSTRAINT player_releases_family_version_code_key;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_platform_version_code_key UNIQUE (platform, version_code);

ALTER TABLE player_releases DROP CONSTRAINT player_releases_family_shape_check;
ALTER TABLE player_releases ADD CONSTRAINT player_releases_platform_shape_check CHECK (
    (platform = 'android'
        AND application_id = 'org.tilecast.player'
        AND minimum_sdk >= 23
        AND apk_name = 'tilecast-player.apk')
    OR
    (platform = 'linux'
        AND application_id IS NULL
        AND minimum_sdk IS NULL
        AND apk_name = 'tilecast-player.AppImage')
);

ALTER TABLE player_releases
    DROP COLUMN state_schema_version,
    DROP COLUMN manifest_bytes,
    DROP COLUMN architecture,
    DROP COLUMN player_family;
