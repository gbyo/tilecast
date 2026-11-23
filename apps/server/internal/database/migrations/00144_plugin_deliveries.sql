-- +goose Up
-- +goose StatementBegin

-- The plugin delivery queue (docs/plugin-delivery.md). One durable queue
-- for every host callback of a bundled Plugin Manifest API 3 plugin: durable
-- timers, events, and inbound webhook requests. A later kind, such as a
-- Player report, is a new kind value, not a new queue.
--
-- A row is one delivery with a stable ID. The plugin receives the same ID on
-- every attempt. Delivery is at least once.
--
-- Order: one (plugin_id, subject) runs one row at a time, in sequence
-- order. subject always starts with the kind, so a timer key cannot share
-- an order with an event subject of the same text. A parked row leaves the
-- order, so the next row of its subject runs.
--
-- Claims: a worker takes a transaction advisory lock for the plugin, counts
-- the live claims of the plugin against its concurrency bound, and claims
-- the first row of each free subject with a random claim token and a lease.
-- Completion, retry, and parking name the row and the token, so a worker
-- whose lease was taken over changes nothing.
--
-- States: pending (waits or runs), parked (failed 8 times; waits for an
-- Owner to retry or discard it), and cancelled (replaced or cancelled while
-- its callback runs: it still holds its subject until the claim ends, then
-- the host deletes it and never runs it again).
--
-- due_at is when the work became due. The pending retention of 7 days
-- counts from due_at, never from created_at, so a timer far in the future
-- is never expired early. next_attempt_at is due_at, or the time of the
-- next retry.
CREATE TABLE plugin_deliveries (
    id UUID PRIMARY KEY,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
    kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,31}$'),
    source TEXT NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 200),
    subject TEXT NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 256),
    payload BYTEA NOT NULL CHECK (octet_length(payload) <= 65536),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 16384),
    sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    due_at TIMESTAMPTZ NOT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'parked', 'cancelled')),
    claim_token UUID,
    claimed_until TIMESTAMPTZ,
    last_error TEXT CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    parked_at TIMESTAMPTZ,
    CHECK ((claim_token IS NULL) = (claimed_until IS NULL)),
    CHECK ((state = 'parked') = (parked_at IS NOT NULL)),
    CHECK (state <> 'parked' OR claim_token IS NULL)
);
-- The first row of each subject.
CREATE INDEX plugin_deliveries_subject_idx ON plugin_deliveries (plugin_id, subject, sequence)
    WHERE state IN ('pending', 'cancelled');
CREATE INDEX plugin_deliveries_due_idx ON plugin_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX plugin_deliveries_parked_idx ON plugin_deliveries (plugin_id, parked_at) WHERE state = 'parked';
-- One live generation of each timer key. A cancelled generation that still
-- runs does not count.
CREATE UNIQUE INDEX plugin_deliveries_timer_key_idx ON plugin_deliveries (plugin_id, source)
    WHERE kind = 'timer' AND state <> 'cancelled';

-- Aggregate delivery state of each plugin. It outlives the rows it counts:
-- an expired row is deleted with its payload, and the count stays. It holds
-- stable codes and times only, never a payload or an error text. Removal
-- deletes it with the queue.
CREATE TABLE plugin_delivery_status (
    plugin_id TEXT PRIMARY KEY CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    expired_count BIGINT NOT NULL DEFAULT 0 CHECK (expired_count >= 0),
    last_expired_at TIMESTAMPTZ,
    last_failure_code TEXT CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[a-z_]{1,64}$'),
    last_failure_kind TEXT CHECK (last_failure_kind IS NULL OR last_failure_kind ~ '^[a-z][a-z_]{0,31}$'),
    last_failure_at TIMESTAMPTZ
);

-- Durable timers move to the queue. A timer keeps its ID (its generation),
-- key, payload, definition version, due time, and attempts. A timer of a
-- plugin that is not installed is not moved: the queue holds nothing for a
-- plugin that is not installed. Claims are not moved; the Server applies
-- migrations before it runs work.
INSERT INTO plugin_deliveries (id, plugin_id, definition_version, kind, source, subject, payload,
    due_at, next_attempt_at, attempts, last_error, created_at)
SELECT t.id, t.plugin_id, t.definition_version, 'timer', t.timer_key, 'timer:' || t.timer_key, t.payload,
    t.due_at, t.due_at, t.attempts, t.last_error, t.created_at
FROM plugin_timers t
WHERE EXISTS (SELECT 1 FROM plugin_installations i WHERE i.plugin_id = t.plugin_id)
ORDER BY t.due_at, t.id;

DROP TABLE plugin_timers;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

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

INSERT INTO plugin_timers (id, plugin_id, timer_key, payload, definition_version, due_at, attempts, last_error, created_at)
SELECT id, plugin_id, source, payload, definition_version, next_attempt_at, attempts, last_error, created_at
FROM plugin_deliveries
WHERE kind = 'timer' AND state = 'pending' AND octet_length(payload) <= 4096;

DROP TABLE plugin_delivery_status;
DROP TABLE plugin_deliveries;

-- +goose StatementEnd
