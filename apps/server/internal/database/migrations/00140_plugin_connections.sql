-- +goose Up
-- +goose StatementBegin

-- Host-owned outbound connections of Plugin Manifest API 3 plugins
-- (docs/plugin-connections.md). A plugin declares each connection in its
-- manifest; these rows are the records an Owner or Administrator creates.
-- The security state is columns, never a document, so the host can enforce
-- it: the configured origin, each consent, and the declaration fingerprint
-- the consents were given for. A credential never enters this table.
CREATE TABLE plugin_connections (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organization_settings(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    definition_id TEXT NOT NULL CHECK (definition_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    -- The one origin of an operator connection. NULL for a connection with
    -- fixed origins.
    origin TEXT CHECK (origin IS NULL OR (char_length(origin) BETWEEN 8 AND 300 AND origin ~ '^https?://')),
    -- sha256 of the declaration's security members and the origin when the
    -- consents were last written. A consent applies only while it matches,
    -- so a changed origin or declaration needs the consents again.
    consent_fingerprint TEXT CHECK (consent_fingerprint IS NULL OR consent_fingerprint ~ '^[0-9a-f]{64}$'),
    private_network_consent_at TIMESTAMPTZ,
    private_network_consent_by UUID REFERENCES users(id) ON DELETE SET NULL,
    plain_http_consent_at TIMESTAMPTZ,
    plain_http_consent_by UUID REFERENCES users(id) ON DELETE SET NULL,
    plaintext_secret_consent_at TIMESTAMPTZ,
    plaintext_secret_consent_by UUID REFERENCES users(id) ON DELETE SET NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Plain HTTP needs private network consent; a plaintext secret needs
    -- plain HTTP consent.
    CHECK (plain_http_consent_at IS NULL OR private_network_consent_at IS NOT NULL),
    CHECK (plaintext_secret_consent_at IS NULL OR plain_http_consent_at IS NOT NULL)
);
CREATE INDEX plugin_connections_plugin_idx ON plugin_connections (plugin_id, definition_id);

-- Settings and instances that name a connection through a connection
-- field. A referenced connection cannot be deleted; the foreign key keeps
-- that true even if a write path forgot the check.
CREATE TABLE plugin_connection_references (
    connection_id UUID NOT NULL REFERENCES plugin_connections(id) ON DELETE RESTRICT,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('settings', 'instance')),
    owner_id UUID NOT NULL,
    settings_id UUID REFERENCES plugin_settings(id) ON DELETE CASCADE,
    instance_id UUID REFERENCES plugin_instances(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL CHECK (char_length(field_key) BETWEEN 1 AND 80),
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    PRIMARY KEY (connection_id, owner_type, owner_id, field_key),
    CHECK (
        (owner_type = 'settings' AND settings_id = owner_id AND instance_id IS NULL)
        OR (owner_type = 'instance' AND instance_id = owner_id AND settings_id IS NULL)
    )
);
CREATE INDEX plugin_connection_references_owner_idx ON plugin_connection_references (owner_type, owner_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE plugin_connection_references;
DROP TABLE plugin_connections;

-- +goose StatementEnd
