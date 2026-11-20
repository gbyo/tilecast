-- A single-screen AirPlay Present session (docs/tilecast-edge-airplay.md
-- §6). One row. tilecastd stores it when it accepts
-- prepare_airplay_session and deletes it when the session stops, expires,
-- is replaced by a takeover, or fails. The PIN and the device ID live only
-- in this row, so they go with it. After a restart, tilecastd resumes an
-- unexpired session, finishes a session that was stopping, and deletes an
-- expired one. Only tilecastd reads the row. Downgrades keep the row; an
-- older reader ignores the table, and the Server's expiry ends the session.
CREATE TABLE external_presentation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    session_id TEXT NOT NULL CHECK (length(session_id) = 36),
    receiver_name TEXT NOT NULL CHECK (length(receiver_name) BETWEEN 1 AND 256),
    pin TEXT NOT NULL CHECK (length(pin) = 4),
    device_id TEXT NOT NULL CHECK (length(device_id) = 17),
    profile TEXT NOT NULL CHECK (profile IN ('1080p30', '720p30')),
    audio_mode TEXT NOT NULL CHECK (audio_mode IN ('gateway_only', 'none')),
    presentation_network_id TEXT CHECK (presentation_network_id IS NULL OR length(presentation_network_id) = 36),
    expires_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'started', 'stopping')),
    stop_reason TEXT CHECK (stop_reason IS NULL OR length(stop_reason) <= 64),
    updated_at_ms INTEGER NOT NULL
);
