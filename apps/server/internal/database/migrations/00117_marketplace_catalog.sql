-- +goose Up

-- The marketplace catalog cache: the last verified signed catalog
-- document, one row for the installation. The payload is the exact signed
-- bytes, so serving it never reinterprets what the marketplace key
-- covered. A failed refresh records its error and keeps serving the last
-- verified document with its age, rather than blanking the store or
-- serving unverified bytes.
CREATE TABLE marketplace_catalog_cache (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    document_url text NOT NULL
        CHECK (char_length(document_url) BETWEEN 1 AND 512),
    key_id text NOT NULL
        CHECK (char_length(key_id) BETWEEN 1 AND 128),
    payload jsonb NOT NULL,
    etag text NOT NULL DEFAULT ''
        CHECK (char_length(etag) BETWEEN 0 AND 256),
    fetched_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    last_error text NOT NULL DEFAULT ''
        CHECK (char_length(last_error) BETWEEN 0 AND 512),
    PRIMARY KEY (organization_id)
);

-- +goose Down
DROP TABLE marketplace_catalog_cache;
