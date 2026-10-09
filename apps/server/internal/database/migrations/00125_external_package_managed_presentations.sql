-- +goose Up
-- +goose StatementBegin

-- Package-owned managed presentations for external (WebAssembly)
-- packages. One row records the system-managed data source, widget, and
-- playlist a package's managed-presentations operations created, so later
-- calls reuse exactly those rows and can never touch another package's
-- rows or arbitrary content. No foreign key to installed_packages: a
-- database restored from a newer release may name a package this release
-- does not know, and those rows must survive untouched rather than block
-- startup. Removing the package deletes its row; the managed content
-- rows keep their own lifecycle.
CREATE TABLE external_package_managed_presentations (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    package_id text NOT NULL
        CHECK (char_length(package_id) BETWEEN 1 AND 128),
    data_source_id uuid NOT NULL,
    widget_id uuid NOT NULL,
    playlist_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, package_id)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE external_package_managed_presentations;

-- +goose StatementEnd
