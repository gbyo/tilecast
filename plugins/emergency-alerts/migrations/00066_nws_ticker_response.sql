-- +goose Up

-- A second way for a matching NWS alert to reach a screen: a bar along the
-- bottom instead of a fullscreen takeover. Migration 00059 deliberately left
-- this out because no player-manifest contract could carry a bar. The Countdown
-- Bar plugin has since established one — a `plugins` array delivered beside the
-- presentation, with `overlay` and `push` display modes and a height — so the
-- ticker response is now expressible without inventing a channel for it.
--
-- The two responses differ in kind, not in degree. A takeover replaces what is
-- playing and is restored when the alert clears; a ticker leaves playback
-- untouched and is delivered through the plugin channel, so it needs no
-- Takeover, no managed playlist, and no restore.

ALTER TABLE alert_rules
    DROP CONSTRAINT alert_rules_response_mode_check,
    ADD CONSTRAINT alert_rules_response_mode_check
        CHECK (response_mode IN ('takeover', 'ticker')),
    -- Bar geometry mirrors the Countdown Bar so one screen renders both the same
    -- way: `push` insets the content, `overlay` covers its bottom edge.
    ADD COLUMN ticker_display_mode text NOT NULL DEFAULT 'push'
        CHECK (ticker_display_mode IN ('overlay', 'push')),
    ADD COLUMN ticker_height_px integer NOT NULL DEFAULT 96
        CHECK (ticker_height_px BETWEEN 40 AND 320),
    -- Alert text is far longer than a countdown message, so the bar scrolls.
    -- Speed is a named choice rather than a pixel rate: the player converts it
    -- using its own display density.
    ADD COLUMN ticker_speed text NOT NULL DEFAULT 'medium'
        CHECK (ticker_speed IN ('slow', 'medium', 'fast'));

ALTER TABLE alert_activations
    DROP CONSTRAINT alert_activations_response_mode_check,
    ADD CONSTRAINT alert_activations_response_mode_check
        CHECK (response_mode IN ('takeover', 'ticker'));

-- +goose Down

ALTER TABLE alert_activations
    DROP CONSTRAINT alert_activations_response_mode_check;
DELETE FROM alert_activations WHERE response_mode <> 'takeover';
ALTER TABLE alert_activations
    ADD CONSTRAINT alert_activations_response_mode_check
        CHECK (response_mode = 'takeover');

ALTER TABLE alert_rules
    DROP COLUMN ticker_speed,
    DROP COLUMN ticker_height_px,
    DROP COLUMN ticker_display_mode,
    DROP CONSTRAINT alert_rules_response_mode_check;
DELETE FROM alert_rules WHERE response_mode <> 'takeover';
ALTER TABLE alert_rules
    ADD CONSTRAINT alert_rules_response_mode_check
        CHECK (response_mode = 'takeover');
