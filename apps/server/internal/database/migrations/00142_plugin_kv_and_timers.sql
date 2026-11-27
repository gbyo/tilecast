-- +goose Up
-- +goose StatementBegin

-- storage.kv@1 of bundled Plugin Manifest API 3 plugins
-- (docs/plugin-storage.md). One namespace for each plugin; the host binds the
-- plugin, and a call never names a namespace. The bounds are the package KV
-- bounds: 128-byte keys, 64 KiB values, 1 MiB of live values for each
-- plugin, checked in the write transaction. Rows outlive a removal, like
-- the plugin's settings and instances.
CREATE TABLE plugin_kv (
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    key TEXT NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 128),
    value BYTEA NOT NULL CHECK (octet_length(value) <= 65536),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plugin_id, key)
);

-- Durable timers (timers.schedule@1, timers.cancel@1). A row is one
-- generation: scheduling a key again deletes the old row and inserts a new
-- one with a new ID, so a callback that finishes late completes only its own
-- generation. A worker claims a due row with FOR UPDATE SKIP LOCKED, a
-- random claim token, and a bounded lease, runs the callback outside the
-- transaction, and completes or retries the row only with the same token.
-- definition_version is the manifest definitionVersion at scheduling time:
-- a timer never fires in another definition.
CREATE TABLE plugin_timers (
    id UUID PRIMARY KEY,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    timer_key TEXT NOT NULL CHECK (octet_length(timer_key) BETWEEN 1 AND 128),
    payload BYTEA NOT NULL CHECK (octet_length(payload) <= 4096),
    definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
    due_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claim_token UUID,
    claimed_until TIMESTAMPTZ,
    last_error TEXT CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);
CREATE UNIQUE INDEX plugin_timers_key_idx ON plugin_timers (plugin_id, timer_key);
CREATE INDEX plugin_timers_due_idx ON plugin_timers (plugin_id, due_at);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE plugin_timers;
DROP TABLE plugin_kv;

-- +goose StatementEnd
