-- M9 hardware parity (docs/tilecast-edge.md §18.1).
--
-- Noise Meter history: completed ten-second aggregates waiting for the
-- server (apps/player-linux/src/core/noise-history.ts). A record leaves only
-- after a heartbeat response says how many the server accepted. The table
-- holds at most 60480 rows (a week of continuous monitoring); the repository
-- drops the oldest first beyond that and past the plugin's retention window.
-- Only derived numbers are stored; there is no column that could hold audio.
CREATE TABLE noise_history (
    started_at_ms INTEGER PRIMARY KEY CHECK (started_at_ms % 10000 = 0),
    average_level REAL NOT NULL CHECK (average_level BETWEEN 0 AND 100),
    peak_level REAL NOT NULL CHECK (peak_level BETWEEN 0 AND 100),
    monitored_ms INTEGER NOT NULL CHECK (monitored_ms BETWEEN 1 AND 10000),
    warning_ms INTEGER NOT NULL CHECK (warning_ms BETWEEN 0 AND 10000),
    loud_ms INTEGER NOT NULL CHECK (loud_ms BETWEEN 0 AND 10000),
    trigger_count INTEGER NOT NULL CHECK (trigger_count BETWEEN 0 AND 1000),
    CHECK (warning_ms + loud_ms <= monitored_ms)
);

-- Presentation Network: the one fact that must survive a restart, whether
-- Tilecast turned the Wi-Fi radio on (apps/player-linux/src/main/
-- presentation-network.ts). There is no credential column: the Wi-Fi secret
-- is fetched for one helper install call and never stored.
CREATE TABLE presentation_network_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_network_id TEXT CHECK (active_network_id IS NULL OR length(active_network_id) = 36),
    radio_was_enabled INTEGER NOT NULL CHECK (radio_was_enabled IN (0, 1)),
    updated_at_ms INTEGER NOT NULL
);
