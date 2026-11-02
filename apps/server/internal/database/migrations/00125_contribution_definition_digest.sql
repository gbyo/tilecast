-- +goose Up
-- +goose StatementBegin
-- SHA-256 of each contribution's nested definition file as it was installed.
-- An update compares it with the incoming digest to see whether a Data
-- Source's definition changed while saved sources still depend on it. Rows
-- from before this column are empty, which means unknown, and are not
-- compared.
ALTER TABLE installed_package_contributions
    ADD COLUMN definition_digest text NOT NULL DEFAULT ''
        CHECK (char_length(definition_digest) <= 64);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE installed_package_contributions
    DROP COLUMN definition_digest;
-- +goose StatementEnd
