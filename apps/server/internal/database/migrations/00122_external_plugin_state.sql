-- +goose Up
-- +goose StatementBegin

-- Plugin-owned state for external (WebAssembly) packages. Keys, values,
-- and job rows belong to one package activation; removing the package
-- deletes them. No foreign key to installed_packages: a database restored
-- from a newer release may name a package this release does not know, and
-- those rows must survive untouched rather than block startup.
CREATE TABLE external_plugin_kv (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    package_id text NOT NULL
        CHECK (char_length(package_id) BETWEEN 1 AND 128),
    key text NOT NULL
        CHECK (char_length(key) BETWEEN 1 AND 128),
    value bytea NOT NULL
        CHECK (octet_length(value) BETWEEN 0 AND 65536),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, package_id, key)
);

-- One row per declared background job: its interval and the scheduler's
-- cursor. The scheduler claims due rows with SELECT ... FOR UPDATE SKIP
-- LOCKED so two server processes never run the same job twice.
CREATE TABLE external_plugin_jobs (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    package_id text NOT NULL
        CHECK (char_length(package_id) BETWEEN 1 AND 128),
    job_id text NOT NULL
        CHECK (job_id ~ '^[a-z][a-z0-9_-]{0,79}$'),
    interval_minutes integer NOT NULL
        CHECK (interval_minutes BETWEEN 5 AND 1440),
    next_run_at timestamptz NOT NULL DEFAULT now(),
    last_run_at timestamptz,
    last_status text NOT NULL DEFAULT 'never'
        CHECK (last_status IN ('never', 'ok', 'error')),
    last_error text NOT NULL DEFAULT ''
        CHECK (char_length(last_error) BETWEEN 0 AND 512),
    consecutive_failures integer NOT NULL DEFAULT 0
        CHECK (consecutive_failures >= 0),
    PRIMARY KEY (organization_id, package_id, job_id)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE external_plugin_jobs;
DROP TABLE external_plugin_kv;

-- +goose StatementEnd
