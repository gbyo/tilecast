-- +goose Up
-- +goose StatementBegin

-- Inbound plugin webhooks (docs/plugin-webhooks.md). The request itself is
-- queued in plugin_deliveries with kind 'webhook'; these tables hold only
-- what authentication and replay protection need, and the safe status
-- Studio shows.

-- Webhook tokens: Authorization: Bearer tch_<public_id>.<secret>. Only the
-- SHA-256 digest of the secret is stored. A token authenticates one webhook
-- of one plugin. Revocation is permanent; removing the plugin deletes its
-- tokens. These are not integration tokens: they have no scopes, no acting
-- user, and a separate lifecycle.
CREATE TABLE plugin_webhook_tokens (
    id UUID PRIMARY KEY,
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    webhook_id TEXT NOT NULL CHECK (webhook_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    public_id TEXT NOT NULL UNIQUE CHECK (public_id ~ '^[0-9a-f]{24}$'),
    secret_hash BYTEA NOT NULL CHECK (octet_length(secret_hash) = 32),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX plugin_webhook_tokens_webhook_idx ON plugin_webhook_tokens(plugin_id, webhook_id, created_at DESC);

-- Replay receipts: one row for each accepted external delivery ID (the
-- provider's delivery ID, or a fetch-back event ID). The insert of the
-- receipt and the enqueue of the delivery share one transaction, so two
-- copies of one delivery never both enqueue. delivery_id is the queue's ID
-- of the accepted copy. A row whose expires_at passed counts as absent and
-- the sweep deletes it.
CREATE TABLE plugin_webhook_receipts (
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    webhook_id TEXT NOT NULL CHECK (webhook_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    external_id TEXT NOT NULL CHECK (octet_length(external_id) BETWEEN 1 AND 200),
    delivery_id UUID NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (plugin_id, webhook_id, external_id)
);
CREATE INDEX plugin_webhook_receipts_expiry_idx ON plugin_webhook_receipts(expires_at);

-- The safe status of each webhook: times, counts, and the stable code of
-- the latest refusal. Never a body, a header, a token, or an address.
CREATE TABLE plugin_webhook_status (
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    webhook_id TEXT NOT NULL CHECK (webhook_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    accepted_count BIGINT NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    duplicate_count BIGINT NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    last_accepted_at TIMESTAMPTZ,
    last_duplicate_at TIMESTAMPTZ,
    last_refused_at TIMESTAMPTZ,
    last_refusal TEXT CHECK (last_refusal IS NULL OR last_refusal ~ '^[a-z_]{1,64}$'),
    PRIMARY KEY (plugin_id, webhook_id)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE plugin_webhook_status;
DROP TABLE plugin_webhook_receipts;
DROP TABLE plugin_webhook_tokens;
-- +goose StatementEnd
