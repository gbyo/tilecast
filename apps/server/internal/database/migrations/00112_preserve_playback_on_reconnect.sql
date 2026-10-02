-- +goose Up
-- +goose StatementBegin
-- A network reconnect does not prove playback stopped or the Player process
-- restarted. Keep open sessions across connection.restored; a real reporting
-- gap closes them at the last confirmed heartbeat in activity_connectivity.go.
CREATE OR REPLACE FUNCTION tilecast_close_sessions_after_player_restart() RETURNS trigger AS $$
BEGIN
    IF NEW.event_type IN ('player.connected','playback.session_restarted','boot.recovery') THEN
        UPDATE playback_sessions
        SET ended_at = NEW.occurred_at,
            result = 'unknown',
            actual_duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NEW.occurred_at - started_at)) * 1000)::bigint,
            metadata = metadata || jsonb_build_object('closedReason', NEW.event_type),
            updated_at = now()
        WHERE screen_id = NEW.screen_id
          AND ended_at IS NULL
          AND started_at <= NEW.occurred_at;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION tilecast_close_sessions_after_player_restart() RETURNS trigger AS $$
BEGIN
    IF NEW.event_type IN ('player.connected','connection.restored','playback.session_restarted','boot.recovery') THEN
        UPDATE playback_sessions
        SET ended_at = NEW.occurred_at,
            result = 'unknown',
            actual_duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NEW.occurred_at - started_at)) * 1000)::bigint,
            metadata = metadata || jsonb_build_object('closedReason', NEW.event_type),
            updated_at = now()
        WHERE screen_id = NEW.screen_id
          AND ended_at IS NULL
          AND started_at <= NEW.occurred_at;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
