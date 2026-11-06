-- +goose Up
-- +goose StatementBegin

-- A plugin records the library fonts one of its instances uses, through
-- Host.Fonts. The font library reads this table to refuse the removal of a
-- family that is still in use, the way it reads Layout dependencies. The
-- owner is the plugin's own instance ID and the label is its display name,
-- so the library can name what to change without knowing the plugin.
CREATE TABLE font_references (
    plugin_id TEXT NOT NULL CHECK (char_length(plugin_id) BETWEEN 1 AND 80),
    owner_id UUID NOT NULL,
    font_id UUID NOT NULL REFERENCES font_families(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plugin_id, owner_id, font_id)
);
CREATE INDEX font_references_font_idx ON font_references (font_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE font_references;

-- +goose StatementEnd
