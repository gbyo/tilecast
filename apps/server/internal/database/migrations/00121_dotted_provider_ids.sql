-- +goose Up
-- +goose StatementBegin
-- Installed packages contribute Widgets and Data Sources under qualified
-- identities (package ID plus nested identity), so persisted providers
-- admit dots. Catalog validation stays the real gate; these shapes are
-- the storage backstop.
ALTER TABLE widgets DROP CONSTRAINT widgets_provider_check;
ALTER TABLE widgets ADD CONSTRAINT widgets_provider_check
    CHECK (provider ~ '^[a-z][a-z0-9_.-]{0,79}$');

ALTER TABLE data_sources DROP CONSTRAINT data_sources_provider_check;
ALTER TABLE data_sources ADD CONSTRAINT data_sources_provider_check
    CHECK (provider ~ '^[a-z][a-z0-9_.-]{0,79}$');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Restoring the dotless shape fails while qualified providers persist;
-- downgrade only after removing every installed package.
ALTER TABLE data_sources DROP CONSTRAINT data_sources_provider_check;
ALTER TABLE data_sources ADD CONSTRAINT data_sources_provider_check
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,79}$');

ALTER TABLE widgets DROP CONSTRAINT widgets_provider_check;
ALTER TABLE widgets ADD CONSTRAINT widgets_provider_check
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,79}$');
-- +goose StatementEnd
