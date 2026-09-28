-- +goose Up

-- Percentages, matching the Widget contentPadding/textScale contract rather
-- than absolute units, so one instance reads the same on a 1080p panel and a
-- 4K one. contentPadding is a share of each side; the default 4 preserves the
-- bar's original 4vw gutters. textScale multiplies the height-derived type
-- size, so 100 keeps the original appearance.
ALTER TABLE countdown_bar_instances
    ADD COLUMN content_padding INTEGER NOT NULL DEFAULT 4
        CHECK (content_padding BETWEEN 0 AND 40),
    ADD COLUMN text_scale INTEGER NOT NULL DEFAULT 100
        CHECK (text_scale BETWEEN 25 AND 500);

-- +goose Down

ALTER TABLE countdown_bar_instances
    DROP COLUMN content_padding,
    DROP COLUMN text_scale;
