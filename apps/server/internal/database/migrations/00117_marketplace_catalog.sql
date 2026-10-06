-- +goose Up

-- The marketplace catalog cache: the last verified signed catalog
-- document, one row for the installation. The payload stores the exact
-- verified catalog bytes the marketplace signature covered. A row may exist
-- without a payload when the first refresh fails; later failures keep serving
-- the last verified document with its age rather than blanking the store.
CREATE TABLE marketplace_catalog_cache (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    document_url text NOT NULL
        CHECK (char_length(document_url) BETWEEN 1 AND 512),
    key_id text NOT NULL
        CHECK (char_length(key_id) BETWEEN 1 AND 128),
    -- Exact verified catalog payload bytes. BYTEA preserves the bytes the
    -- marketplace signature covered; JSONB would rewrite whitespace/order.
    -- NULL means no refresh has succeeded yet.
    payload bytea,
    etag text NOT NULL DEFAULT ''
        CHECK (char_length(etag) BETWEEN 0 AND 256),
    fetched_at timestamptz,
    expires_at timestamptz,
    last_error text NOT NULL DEFAULT ''
        CHECK (char_length(last_error) BETWEEN 0 AND 512),
    PRIMARY KEY (organization_id)
);

-- +goose Down
DROP TABLE marketplace_catalog_cache;
