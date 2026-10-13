-- +goose Up
-- +goose StatementBegin

-- Configuration is operator-authored. Player state is package-authored and
-- expires independently. Package updates keep configuration; removal clears it.
CREATE TABLE external_plugin_runtime_state (
    organization_id uuid NOT NULL,
    package_id text NOT NULL,
    contribution_id text NOT NULL CHECK (char_length(contribution_id) BETWEEN 1 AND 128),
    enabled boolean NOT NULL,
    configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=32768),
    targets jsonb NOT NULL CHECK (jsonb_typeof(targets)='object' AND octet_length(targets::text)<=65536),
    configuration_revision bigint NOT NULL CHECK (configuration_revision>=1),
    state jsonb CHECK (state IS NULL OR (jsonb_typeof(state)='object' AND octet_length(state::text)<=32768)),
    valid_until timestamptz,
    published_at timestamptz,
    definition_version integer,
    configured_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,package_id,contribution_id),
    FOREIGN KEY (organization_id,package_id) REFERENCES installed_packages(organization_id,package_id) ON DELETE CASCADE,
    CHECK (left(contribution_id,char_length(package_id)+1)=package_id||'.'),
    CHECK ((state IS NULL AND valid_until IS NULL) OR (state IS NOT NULL AND valid_until IS NOT NULL)),
    CHECK (definition_version IS NULL OR definition_version BETWEEN 1 AND 1000000)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE external_plugin_runtime_state;

-- +goose StatementEnd
