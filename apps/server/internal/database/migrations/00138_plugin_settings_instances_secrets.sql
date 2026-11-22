-- +goose Up
-- +goose StatementBegin

-- Plugin Manifest API 3 host-owned plugin storage (docs/plugin-api-v3.md).
-- Core owns these tables: a plugin declares settings and instance kinds in
-- its manifest and never writes these rows itself.

-- One settings document for each plugin and scope: the organization, or one
-- screen. Values hold only non-secret fields; secrets live in
-- plugin_secrets. personal_written_at records when each personal field was
-- last written, so the host can remove it when its retention ends.
CREATE TABLE plugin_settings (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organization_settings(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    scope TEXT NOT NULL CHECK (scope IN ('organization', 'screen')),
    screen_id UUID REFERENCES screens(id) ON DELETE CASCADE,
    "values" JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof("values") = 'object' AND octet_length("values"::text) <= 65536),
    personal_written_at JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(personal_written_at) = 'object'),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope = 'organization' AND screen_id IS NULL) OR (scope = 'screen' AND screen_id IS NOT NULL))
);
CREATE UNIQUE INDEX plugin_settings_organization_idx ON plugin_settings (plugin_id) WHERE scope = 'organization';
CREATE UNIQUE INDEX plugin_settings_screen_idx ON plugin_settings (plugin_id, screen_id) WHERE scope = 'screen';

-- Host-owned instances. Configuration is the normalized, non-secret
-- document of the kind's fields; the host fields that ownership, targeting,
-- revision checks, scheduling, and cleanup need are columns.
CREATE TABLE plugin_instances (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organization_settings(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,39}$'),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 180),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000000 AND 1000000),
    -- NULL for a kind without screen targeting.
    target_scope TEXT CHECK (target_scope IN ('all', 'screens', 'sync_groups', 'locations')),
    schedule JSONB CHECK (schedule IS NULL OR jsonb_typeof(schedule) = 'object'),
    -- The next instant the host schedule starts or ends a projection, so
    -- the schedule worker can invalidate the affected screens at that time.
    next_schedule_change_at TIMESTAMPTZ,
    configuration JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration) = 'object' AND octet_length(configuration::text) <= 65536),
    personal_written_at JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(personal_written_at) = 'object'),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plugin_instances_plugin_idx ON plugin_instances (plugin_id, kind, enabled, priority DESC);
CREATE INDEX plugin_instances_schedule_idx ON plugin_instances (next_schedule_change_at) WHERE next_schedule_change_at IS NOT NULL;

CREATE TABLE plugin_instance_targets (
    instance_id UUID NOT NULL REFERENCES plugin_instances(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('screens', 'sync_groups', 'locations')),
    target_id UUID NOT NULL,
    PRIMARY KEY (instance_id, target_type, target_id)
);
CREATE INDEX plugin_instance_targets_lookup_idx ON plugin_instance_targets (target_type, target_id, instance_id);

-- Library media a plugin setting or instance names through a media_asset
-- field. The media library refuses to archive or delete an asset that is
-- referenced here, as it does for Layout dependencies. The owner is the
-- instance ID or the settings row ID.
CREATE TABLE plugin_media_references (
    plugin_id TEXT NOT NULL CHECK (char_length(plugin_id) BETWEEN 1 AND 80),
    owner_id UUID NOT NULL,
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plugin_id, owner_id, asset_id)
);
CREATE INDEX plugin_media_references_asset_idx ON plugin_media_references (asset_id);

-- Data encryption keys. Each 256-bit DEK is wrapped with one key
-- encryption key (KEK) from TILECAST_SECRETS_KEY_FILE, which never enters
-- the database or a backup. Exactly one DEK is current; new secrets use it.
-- An active DEK still protects secrets until the DEK rotation worker moves
-- them; a retired DEK protects nothing and is kept only as history.
CREATE TABLE plugin_secret_deks (
    id UUID PRIMARY KEY,
    kek_id TEXT NOT NULL CHECK (char_length(kek_id) BETWEEN 1 AND 64),
    wrapped_key BYTEA NOT NULL CHECK (octet_length(wrapped_key) BETWEEN 32 AND 256),
    state TEXT NOT NULL CHECK (state IN ('current', 'active', 'retired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rewrapped_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX plugin_secret_deks_current_idx ON plugin_secret_deks ((TRUE)) WHERE state = 'current';
CREATE INDEX plugin_secret_deks_kek_idx ON plugin_secret_deks (kek_id);

-- One encrypted secret. The envelope is AES-256-GCM under the DEK with a
-- fresh nonce, authenticated with the plugin, the owner, and the setting
-- key, so a ciphertext copied to another row does not decrypt. owner_id is
-- the organization ID, the instance ID, or the screen ID; the instance and
-- screen columns repeat it so deleting the owner deletes the secret.
CREATE TABLE plugin_secrets (
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('organization', 'instance', 'screen')),
    owner_id UUID NOT NULL,
    setting_key TEXT NOT NULL CHECK (char_length(setting_key) BETWEEN 1 AND 80),
    instance_id UUID REFERENCES plugin_instances(id) ON DELETE CASCADE,
    screen_id UUID REFERENCES screens(id) ON DELETE CASCADE,
    dek_id UUID NOT NULL REFERENCES plugin_secret_deks(id),
    envelope BYTEA NOT NULL CHECK (octet_length(envelope) BETWEEN 29 AND 8192),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plugin_id, owner_type, owner_id, setting_key),
    CHECK (
        (owner_type = 'organization' AND instance_id IS NULL AND screen_id IS NULL)
        OR (owner_type = 'instance' AND instance_id = owner_id AND screen_id IS NULL)
        OR (owner_type = 'screen' AND screen_id = owner_id AND instance_id IS NULL)
    )
);
CREATE INDEX plugin_secrets_dek_idx ON plugin_secrets (dek_id);

-- An Owner's confirmation that the KEKs were exported for offline storage.
-- The confirmation names the exact set of KEK IDs, so it no longer applies
-- after a KEK rotation adds a key, and Studio warns again.
CREATE TABLE plugin_secret_kek_exports (
    kek_ids TEXT PRIMARY KEY CHECK (char_length(kek_ids) BETWEEN 1 AND 2048),
    acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE plugin_secret_kek_exports;
DROP TABLE plugin_secrets;
DROP TABLE plugin_secret_deks;
DROP TABLE plugin_media_references;
DROP TABLE plugin_instance_targets;
DROP TABLE plugin_instances;
DROP TABLE plugin_settings;

-- +goose StatementEnd
