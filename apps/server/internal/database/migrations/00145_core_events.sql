-- +goose Up
-- +goose StatementBegin

-- Core and plugin events (docs/plugin-events.md).

-- The persisted connectivity state of each screen. internal/devices/status.go
-- still computes the display status on every read; this row records the
-- transition between reachable (a heartbeat within the offline threshold)
-- and offline, so one outage is one change each way and one
-- screen.status.changed@1 event each way. internal/connectivity writes it.
CREATE TABLE screen_connectivity (
    screen_id UUID PRIMARY KEY REFERENCES screens(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('reachable', 'offline')),
    changed_at TIMESTAMPTZ NOT NULL
);

-- The payload schema fingerprint of every plugin event version this
-- installation has seen published. A plugin event's payload never changes
-- under a version: when a later release declares the same plugin, name,
-- and version with another schema, the host refuses to publish it and the
-- plugin's status says why. Rows outlive a removal, because a reinstall of
-- the same version must keep the same contract.
CREATE TABLE plugin_event_schemas (
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    event_name TEXT NOT NULL CHECK (event_name ~ '^[a-z][a-z0-9_]{0,39}$'),
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 999),
    fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plugin_id, event_name, version)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE plugin_event_schemas;
DROP TABLE screen_connectivity;

-- +goose StatementEnd
