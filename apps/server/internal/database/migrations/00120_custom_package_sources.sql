-- +goose Up

-- Custom package sources: GitHub repositories the operator added by hand,
-- each bound to the package its manifest declares. The binding persists so
-- update checks and provenance verification resolve the same repository the
-- operator reviewed, not whatever a package ID claims today.
--
-- Owner and repository names are stored lowercase: GitHub treats them
-- case-insensitively, and one canonical identity keeps the same repository
-- from registering twice under different cases. The repository URL is the
-- canonical public address built from them.
--
-- The manifest is the validated tilecast.package.json from the last
-- resolution, kept so Explore names custom entries without refetching.
-- resolved_at records that resolution; resolved_digest pins the artifact
-- it approved. Update checks refresh all three.
CREATE TABLE custom_package_sources (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    package_id text NOT NULL
        CHECK (package_id ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
    repository_owner text NOT NULL
        CHECK (repository_owner ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$'),
    repository_name text NOT NULL
        CHECK (repository_name ~ '^[a-z0-9._-]{1,100}$'),
    repository_url text NOT NULL
        CHECK (char_length(repository_url) BETWEEN 1 AND 512),
    manifest jsonb NOT NULL,
    resolved_digest text NOT NULL
        CHECK (resolved_digest ~ '^sha256:[0-9a-f]{64}$'),
    resolved_at timestamptz NOT NULL DEFAULT now(),
    added_by uuid
        REFERENCES users(id)
        ON DELETE SET NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, package_id),
    UNIQUE (organization_id, repository_owner, repository_name)
);

-- +goose Down
DROP TABLE custom_package_sources;
