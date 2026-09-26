-- +goose Up

-- National Weather Service alert monitoring. Previously the only way to put an
-- NWS alert on a screen was the `weather-alerts-us` Data Source, which could
-- render a list of alerts inside a Widget but could not act on one: an operator
-- still had to notice the alert and raise a Takeover by hand. This models the
-- watching and the response together, so a matching alert reaches screens
-- without a human in the loop.
--
-- A matching alert can raise a Takeover without waiting for an operator. A
-- ticker response is deliberately not modelled here: that would require a new
-- player-manifest contract and must not be presented as working server-side.

CREATE TABLE alert_monitor (
    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enabled boolean NOT NULL DEFAULT FALSE,
    -- NWS `area` codes: two-letter states and territories. Zones are the finer
    -- UGC county/forecast-zone codes; either may be used, and both are passed
    -- to the upstream API as declared filters rather than matched locally.
    areas text[] NOT NULL DEFAULT '{}',
    zones text[] NOT NULL DEFAULT '{}',
    poll_interval_seconds integer NOT NULL DEFAULT 120
        CHECK (poll_interval_seconds BETWEEN 60 AND 3600),
    -- Poller health, surfaced in Studio so a silently failing monitor is
    -- visible rather than looking like "no alerts".
    last_polled_at timestamptz,
    last_success_at timestamptz,
    last_error_code text,
    last_matched_count integer NOT NULL DEFAULT 0,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO alert_monitor(singleton) VALUES (TRUE);

CREATE TABLE alert_rules (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organization_settings(id),
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT TRUE,
    position integer NOT NULL DEFAULT 0,
    -- Empty means "any event the monitor sees". Names are NWS event strings
    -- such as 'Tornado Warning'.
    event_names text[] NOT NULL DEFAULT '{}',
    minimum_severity text NOT NULL DEFAULT 'Severe'
        CHECK (minimum_severity IN ('Minor','Moderate','Severe','Extreme')),
    minimum_urgency text NOT NULL DEFAULT 'Expected'
        CHECK (minimum_urgency IN ('Unknown','Future','Expected','Immediate')),
    response_mode text NOT NULL DEFAULT 'takeover'
        CHECK (response_mode = 'takeover'),
    -- A deleted playlist disables effective activation without dropping the
    -- rule or its audit history.
    playlist_id uuid REFERENCES playlists(id) ON DELETE SET NULL,
    -- A takeover raised from an alert ends when the alert expires; this is the
    -- ceiling applied when the alert carries no expiry or an implausible one.
    maximum_duration_minutes integer NOT NULL DEFAULT 360
        CHECK (maximum_duration_minutes BETWEEN 5 AND 10080),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_rules_enabled_idx ON alert_rules(enabled, position, id);

CREATE TABLE alert_rule_targets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_id uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('screen','group')),
    screen_id uuid REFERENCES screens(id),
    screen_group_id uuid REFERENCES screen_groups(id),
    CHECK ((target_type='screen' AND screen_id IS NOT NULL AND screen_group_id IS NULL) OR
           (target_type='group' AND screen_group_id IS NOT NULL AND screen_id IS NULL))
);
CREATE UNIQUE INDEX alert_rule_screen_target_unique
    ON alert_rule_targets(rule_id, screen_id) WHERE screen_id IS NOT NULL;
CREATE UNIQUE INDEX alert_rule_group_target_unique
    ON alert_rule_targets(rule_id, screen_group_id) WHERE screen_group_id IS NOT NULL;
CREATE TRIGGER alert_rule_targets_reject_archived
    BEFORE INSERT OR UPDATE ON alert_rule_targets
    FOR EACH ROW EXECUTE FUNCTION reject_archived_screen_reference();

-- One row per (alert, rule) pair the monitor is currently acting on. Keyed by
-- the NWS identifier so a poll that sees the same alert again updates rather
-- than re-fires, which is what makes the poller idempotent across restarts.
CREATE TABLE alert_activations (
    alert_id text NOT NULL,
    rule_id uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    event text NOT NULL,
    headline text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    instruction text NOT NULL DEFAULT '',
    severity text NOT NULL,
    urgency text NOT NULL,
    certainty text NOT NULL DEFAULT '',
    area_description text NOT NULL DEFAULT '',
    sender text NOT NULL DEFAULT '',
    effective_at timestamptz,
    expires_at timestamptz,
    response_mode text NOT NULL DEFAULT 'takeover'
        CHECK (response_mode = 'takeover'),
    -- The Takeover this alert raised, so clearing the alert cancels exactly
    -- that takeover and nothing else.
    takeover_id uuid REFERENCES takeovers(id) ON DELETE SET NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    cleared_at timestamptz,
    clear_reason text CHECK (clear_reason IS NULL OR clear_reason IN
        ('expired','no_longer_active','cancelled_upstream','rule_changed','rule_deleted','operator')),
    PRIMARY KEY (alert_id, rule_id)
);
CREATE INDEX alert_activations_live_idx
    ON alert_activations(rule_id, last_seen_at DESC) WHERE cleared_at IS NULL;
CREATE INDEX alert_activations_history_idx
    ON alert_activations(first_seen_at DESC);

-- +goose Down
DROP TABLE alert_activations;
DROP TRIGGER alert_rule_targets_reject_archived ON alert_rule_targets;
DROP TABLE alert_rule_targets;
DROP TABLE alert_rules;
DROP TABLE alert_monitor;
