-- +goose Up

-- Private plugin assets are owned by exactly one plugin. The stored origin
-- stays the historical 'form_attachment' classification (see migration 00044
-- and the Plugin API ADR): generic Media surfaces exclude that origin from
-- the library, and renaming it would churn every exclusion query for no
-- behavioral gain. Ownership is the new architectural signal: every private
-- asset names the plugin that may claim, serve, or discard it, and Host
-- services enforce the owner on every call. Rows ingested before this
-- release are Form attachments, so they backfill to 'forms'. Library rows
-- keep a NULL owner: they are core-owned and never claimable as private
-- assets.

ALTER TABLE assets ADD COLUMN owning_plugin TEXT;

UPDATE assets SET owning_plugin = 'forms' WHERE origin = 'form_attachment';

-- +goose Down

ALTER TABLE assets DROP COLUMN owning_plugin;
