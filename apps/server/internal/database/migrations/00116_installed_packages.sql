-- +goose Up

-- Which independently distributed extension packages this installation has
-- activated, and what each one contributes.
--
-- A package is a distribution container, not a fourth extension API: these
-- rows record distribution, version, and provenance, while the contributions
-- themselves keep their Widget, Data Source, and plugin contracts. The
-- installer resolves every registry reference to an immutable digest before
-- anything activates; a floating tag is never executed or persisted as the
-- active address.
--
-- package_id has no foreign key: a database restored from a newer release
-- may name a package this release does not know, and that row must survive
-- untouched rather than block startup or be silently deleted.
CREATE TABLE installed_packages (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    package_id text NOT NULL
        CHECK (package_id ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
    package_version text NOT NULL
        CHECK (char_length(package_version) BETWEEN 1 AND 64),
    digest text NOT NULL
        CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    source_kind text NOT NULL
        CHECK (source_kind IN ('marketplace', 'custom', 'local')),
    source_reference text NOT NULL
        CHECK (char_length(source_reference) BETWEEN 1 AND 512),
    registry_reference text NOT NULL
        CHECK (char_length(registry_reference) BETWEEN 1 AND 255),
    signer_identity text NOT NULL DEFAULT ''
        CHECK (char_length(signer_identity) BETWEEN 0 AND 512),
    trust_state text NOT NULL
        CHECK (trust_state IN ('verified', 'unsigned_development')),
    -- The validated manifest document behind this activation. Rollback
    -- snapshots copy it, so a previous activation revalidates like new.
    manifest jsonb NOT NULL,
    installed_at timestamptz NOT NULL DEFAULT now(),
    installed_by uuid
        REFERENCES users(id)
        ON DELETE SET NULL,
    activated_at timestamptz NOT NULL DEFAULT now(),
    -- Snapshot of the activation this one replaced: digest, version, source,
    -- registry reference, signer/trust provenance, manifest document, and
    -- contribution rows. Rollback restores it as a unit, so one previous
    -- activation survives every update. NULL when there is nothing to roll
    -- back to.
    previous_activation jsonb,
    PRIMARY KEY (organization_id, package_id)
);

-- Every contribution an installed package owns: the nested manifest identity
-- and the path inside the package that carries it. The installer replaces
-- these rows atomically with each activation, and removal blockers read them
-- to explain what still uses a package. One identity cannot be supplied by
-- two packages at once.
CREATE TABLE installed_package_contributions (
    organization_id uuid NOT NULL,
    package_id text NOT NULL,
    kind text NOT NULL
        CHECK (kind IN ('plugin', 'widget', 'dataSource')),
    contribution_id text NOT NULL
        CHECK (char_length(contribution_id) BETWEEN 1 AND 128),
    contribution_path text NOT NULL
        CHECK (char_length(contribution_path) BETWEEN 1 AND 256),
    PRIMARY KEY (organization_id, package_id, kind, contribution_id),
    FOREIGN KEY (organization_id, package_id)
        REFERENCES installed_packages(organization_id, package_id)
        ON DELETE CASCADE,
    UNIQUE (organization_id, kind, contribution_id)
);

-- +goose Down
DROP TABLE installed_package_contributions;
DROP TABLE installed_packages;
