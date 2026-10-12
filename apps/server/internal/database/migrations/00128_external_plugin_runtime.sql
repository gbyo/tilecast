-- +goose Up
-- +goose StatementBegin

-- Execution epochs fence in-flight guests across update, rollback, and a
-- removal followed by a reinstall of the same digest. New epochs are
-- application-generated UUIDs. Existing epochs are non-secret identities.
ALTER TABLE installed_packages ADD COLUMN execution_epoch uuid;
UPDATE installed_packages SET execution_epoch =
    md5(organization_id::text || ':' || package_id || ':' || activated_at::text)::uuid;
ALTER TABLE installed_packages ALTER COLUMN execution_epoch SET NOT NULL;
ALTER TABLE installed_packages ADD COLUMN storage_epoch uuid;
UPDATE installed_packages SET storage_epoch = execution_epoch;
ALTER TABLE installed_packages ALTER COLUMN storage_epoch SET NOT NULL;
ALTER TABLE external_plugin_kv ADD COLUMN storage_epoch uuid;
UPDATE external_plugin_kv kv SET storage_epoch = installed.storage_epoch
    FROM installed_packages installed WHERE kv.package_id = installed.package_id;

ALTER TABLE external_plugin_jobs
    ALTER COLUMN interval_minutes DROP NOT NULL,
    ADD COLUMN job_kind text NOT NULL DEFAULT 'ordinary'
        CHECK (job_kind IN ('ordinary', 'realtime')),
    ADD COLUMN interval_seconds integer,
    ADD COLUMN execution_epoch uuid,
    ADD COLUMN claim_token uuid,
    ADD CONSTRAINT external_plugin_jobs_interval_kind CHECK (
        (job_kind = 'ordinary' AND interval_minutes IS NOT NULL AND interval_seconds IS NULL)
        OR (job_kind = 'realtime' AND interval_minutes IS NULL AND interval_seconds BETWEEN 5 AND 60
            AND interval_seconds IS NOT NULL AND execution_epoch IS NOT NULL)
    );

CREATE UNIQUE INDEX external_plugin_jobs_one_realtime
    ON external_plugin_jobs (organization_id, package_id) WHERE job_kind = 'realtime';

UPDATE external_plugin_jobs job SET execution_epoch=installed.execution_epoch
    FROM installed_packages installed WHERE job.package_id=installed.package_id;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DELETE FROM external_plugin_jobs WHERE job_kind = 'realtime';
DROP INDEX external_plugin_jobs_one_realtime;
ALTER TABLE external_plugin_jobs
    DROP CONSTRAINT external_plugin_jobs_interval_kind,
    DROP COLUMN claim_token,
    DROP COLUMN execution_epoch,
    DROP COLUMN interval_seconds,
    DROP COLUMN job_kind,
    ALTER COLUMN interval_minutes SET NOT NULL;
ALTER TABLE installed_packages DROP COLUMN execution_epoch;
ALTER TABLE external_plugin_kv DROP COLUMN storage_epoch;
ALTER TABLE installed_packages DROP COLUMN storage_epoch;

-- +goose StatementEnd
