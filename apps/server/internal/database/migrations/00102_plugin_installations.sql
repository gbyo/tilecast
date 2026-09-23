-- +goose Up

-- Which release-owned plugins this installation has chosen to use.
--
-- The plugin catalog itself is compiled Go data, not a table, so plugin_id has
-- no foreign key: a database restored from a newer release may name a plugin
-- this release does not know, and that row must survive untouched rather than
-- block startup or be silently deleted.
--
-- The row answers one question — is the plugin installed? Each plugin keeps its
-- real configuration in its own tables; there is deliberately no generic
-- configuration column and no separate enabled flag here.
CREATE TABLE plugin_installations (
    organization_id uuid NOT NULL
        REFERENCES organization_settings(id)
        ON DELETE CASCADE,
    plugin_id text NOT NULL
        CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,79}$'),
    installed_by uuid
        REFERENCES users(id)
        ON DELETE SET NULL,
    installed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, plugin_id)
);

-- Existing installations keep every plugin their data proves is in use, and
-- nothing else. A fresh database has no organization yet, so it starts with no
-- plugins installed.
INSERT INTO plugin_installations(organization_id, plugin_id)
SELECT o.id, p.plugin_id
FROM organization_settings o
CROSS JOIN (
    SELECT 'countdown_bar' AS plugin_id WHERE EXISTS (SELECT 1 FROM countdown_bar_instances)
    UNION ALL
    SELECT 'brand_bug' WHERE EXISTS (SELECT 1 FROM brand_bug_instances)
    UNION ALL
    SELECT 'noise_meter' WHERE EXISTS (SELECT 1 FROM noise_meter_instances)
    UNION ALL
    SELECT 'forms' WHERE EXISTS (
        SELECT 1 FROM data_sources WHERE provider = 'form' AND deleted_at IS NULL)
    UNION ALL
    -- The NWS migration creates the monitor row disabled, so its presence alone
    -- is not evidence that anyone set Emergency Alerts up.
    SELECT 'emergency_alerts' WHERE EXISTS (SELECT 1 FROM alert_monitor WHERE enabled)
        OR EXISTS (SELECT 1 FROM alert_rules)
) p
WHERE o.singleton
ON CONFLICT DO NOTHING;

-- +goose Down
DROP TABLE plugin_installations;
