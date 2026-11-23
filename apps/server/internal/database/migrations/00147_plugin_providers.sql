-- +goose Up
-- +goose StatementBegin

-- Provider slots of Plugin Manifest API 3 (docs/plugin-providers.md).

-- A plugin notification channel is a third sender of the notification
-- outbox. Its rows use channel 'plugin' and the target
-- '<plugin id>:<channel id>'. The outbox keeps its retries, idempotency, and
-- log; only the allowed channel values change.
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check
    CHECK (channel IN ('email', 'webhook', 'plugin'));

-- The state of one Content Health check for one content item. fingerprint
-- is the SHA-256 of the canonical JSON of the host-built content model the
-- check last completed on. A failed check keeps the earlier fingerprint, so
-- the item is checked again on a later sweep, and its conditions stay. The
-- open conditions themselves are incidents.
CREATE TABLE plugin_content_check_state (
    plugin_id TEXT NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    check_id TEXT NOT NULL CHECK (check_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    item_kind TEXT NOT NULL CHECK (item_kind IN ('playlist', 'layout', 'widget_instance', 'media_item')),
    item_id UUID NOT NULL,
    fingerprint TEXT CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
    checked_at TIMESTAMPTZ NOT NULL,
    succeeded_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    failure TEXT CHECK (failure IS NULL OR failure ~ '^[a-z_]{1,64}$'),
    PRIMARY KEY (plugin_id, check_id, item_kind, item_id)
);
CREATE INDEX plugin_content_check_state_due_idx ON plugin_content_check_state(plugin_id, check_id, item_kind, checked_at);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE plugin_content_check_state;
DELETE FROM notification_deliveries WHERE channel = 'plugin';
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check
    CHECK (channel IN ('email', 'webhook'));
-- +goose StatementEnd
