-- +goose Up
-- +goose StatementBegin

-- A Widget records the library families its font fields choose. The font
-- library reads this table to refuse the removal of a family that a Widget
-- still uses, the way it reads Layout dependencies and plugin references.
-- A Widget save reads the family row FOR SHARE before it replaces its rows.
CREATE TABLE widget_font_references (
    widget_id UUID NOT NULL REFERENCES widgets(asset_id) ON DELETE CASCADE,
    font_id UUID NOT NULL REFERENCES font_families(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (widget_id, font_id)
);
CREATE INDEX widget_font_references_font_idx ON widget_font_references (font_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE widget_font_references;

-- +goose StatementEnd
