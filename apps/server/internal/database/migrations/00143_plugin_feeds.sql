-- +goose Up
-- +goose StatementBegin

-- Feeds of Plugin Manifest API 3 plugins (docs/plugin-feeds.md). A dataset
-- is one ordinary Data Source row with the provider "<plugin>.<feed>"; this
-- table shares its ID. A publication replaces the records of one dataset and
-- names the revision it replaces.
CREATE TABLE plugin_feed_datasets (
    id UUID PRIMARY KEY REFERENCES data_sources(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    feed_id TEXT NOT NULL CHECK (feed_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    feed_version INTEGER NOT NULL CHECK (feed_version >= 1),
    -- NULL for an organization dataset. An instance with a dataset is
    -- deleted only after its dataset.
    instance_id UUID REFERENCES plugin_instances(id) ON DELETE RESTRICT,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    -- The feed's declared refresh interval at the last publication. Content
    -- Health calls a dataset stale after twice this time without one.
    expected_refresh_seconds INTEGER NOT NULL CHECK (expected_refresh_seconds BETWEEN 60 AND 604800),
    published_at TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,
    -- Connection records for remote images, by connection declaration.
    image_connections JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(image_connections) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plugin_feed_datasets_organization_idx ON plugin_feed_datasets (plugin_id, feed_id) WHERE instance_id IS NULL;
CREATE UNIQUE INDEX plugin_feed_datasets_instance_idx ON plugin_feed_datasets (plugin_id, feed_id, instance_id) WHERE instance_id IS NOT NULL;

-- The upstream values of each record, as the last publication sent them.
-- Operator overrides are separate rows and never rewrite these.
CREATE TABLE plugin_feed_records (
    dataset_id UUID NOT NULL REFERENCES plugin_feed_datasets(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL CHECK (char_length(record_id) BETWEEN 1 AND 80),
    position INTEGER NOT NULL CHECK (position >= 0),
    upstream JSONB NOT NULL CHECK (jsonb_typeof(upstream) = 'object'),
    -- The last change of the upstream values: personal-data retention
    -- counts from it.
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset_id, record_id)
);

-- Operator overrides, by dataset, record, and field. A removed record
-- removes its overrides.
CREATE TABLE plugin_feed_overrides (
    dataset_id UUID NOT NULL,
    record_id TEXT NOT NULL,
    field_key TEXT NOT NULL CHECK (char_length(field_key) BETWEEN 1 AND 80),
    value JSONB NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset_id, record_id, field_key),
    FOREIGN KEY (dataset_id, record_id) REFERENCES plugin_feed_records(dataset_id, record_id) ON DELETE CASCADE
);

-- Why the host removed an override, so Studio can say so. One row for each
-- field at most.
CREATE TABLE plugin_feed_override_removals (
    dataset_id UUID NOT NULL,
    record_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('upstream_changed', 'feed_version_changed', 'retention')),
    removed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset_id, record_id, field_key),
    FOREIGN KEY (dataset_id, record_id) REFERENCES plugin_feed_records(dataset_id, record_id) ON DELETE CASCADE
);

-- Private plugin assets imported from remote feed images, one for each
-- plugin and SHA-256. Deduplication never crosses plugins. An asset no
-- current record names is orphaned and soft-deleted after 24 hours.
CREATE TABLE plugin_feed_blobs (
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    sha256 BYTEA NOT NULL CHECK (octet_length(sha256) = 32),
    asset_id UUID NOT NULL UNIQUE REFERENCES assets(id) ON DELETE CASCADE,
    byte_size BIGINT NOT NULL CHECK (byte_size > 0),
    orphaned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plugin_id, sha256)
);

-- The image each record field shows now. Players get a grant only for an
-- asset a current row names.
CREATE TABLE plugin_feed_assets (
    dataset_id UUID NOT NULL,
    record_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    asset_id UUID NOT NULL REFERENCES plugin_feed_blobs(asset_id) ON DELETE CASCADE,
    source_url TEXT NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 2048),
    PRIMARY KEY (dataset_id, record_id, field_key),
    FOREIGN KEY (dataset_id, record_id) REFERENCES plugin_feed_records(dataset_id, record_id) ON DELETE CASCADE
);
CREATE INDEX plugin_feed_assets_asset_idx ON plugin_feed_assets (asset_id);

-- Image imports wait here after the publication commits. A newer
-- publication of the same field replaces a waiting import; an import that
-- finishes for an old revision attaches nothing. Claimed through
-- internal/durable.
CREATE TABLE plugin_feed_image_imports (
    id UUID PRIMARY KEY,
    dataset_id UUID NOT NULL REFERENCES plugin_feed_datasets(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    record_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    url TEXT NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
    connection_id UUID NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    claim_token UUID,
    claimed_until TIMESTAMPTZ,
    last_error TEXT CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, record_id, field_key),
    CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);
CREATE INDEX plugin_feed_image_imports_due_idx ON plugin_feed_image_imports (due_at);

-- The current failed import of a record field: the field stays empty and
-- the plugin status shows an attention item. A stable code, never a URL
-- or provider text.
CREATE TABLE plugin_feed_image_failures (
    dataset_id UUID NOT NULL,
    record_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    code TEXT NOT NULL CHECK (code ~ '^[a-z_]{1,64}$'),
    failed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (dataset_id, record_id, field_key),
    FOREIGN KEY (dataset_id, record_id) REFERENCES plugin_feed_records(dataset_id, record_id) ON DELETE CASCADE
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE plugin_feed_image_failures;
DROP TABLE plugin_feed_image_imports;
DROP TABLE plugin_feed_assets;
DROP TABLE plugin_feed_blobs;
DROP TABLE plugin_feed_override_removals;
DROP TABLE plugin_feed_overrides;
DROP TABLE plugin_feed_records;
DROP TABLE plugin_feed_datasets;

-- +goose StatementEnd
