-- +goose Up

-- The marketplace catalog cache: the last valid official catalog
-- document, one row for the installation. The payload stores the exact
-- fetched catalog bytes. A row may exist without a payload when the first
-- refresh fails; later failures keep serving the last valid document with
-- its age rather than blanking the store.
CREATE TABLE marketplace_catalog_cache (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    -- Exact fetched catalog bytes. BYTEA preserves the document;
    -- JSONB would rewrite whitespace/order. NULL means no refresh has
    -- succeeded yet.
    payload bytea,
    etag text NOT NULL DEFAULT ''
        CHECK (char_length(etag) BETWEEN 0 AND 256),
    fetched_at timestamptz,
    last_error text NOT NULL DEFAULT ''
        CHECK (char_length(last_error) BETWEEN 0 AND 512),
    PRIMARY KEY (organization_id)
);

-- +goose Down
DROP TABLE marketplace_catalog_cache;
