-- +goose Up

-- Playback sessions recorded by Players that read a zero (or one millisecond)
-- duration literally. One stuck item produced tens of thousands of "completed"
-- plays that lasted a millisecond and were never on screen, and a Player that
-- remounted an item recorded a second, zero-length play beside the real one.
-- The server now refuses to derive those (see minimumPlaybackSessionMS); this
-- removes the ones already derived, so reports and exports stop counting them.
--
-- Only plays that ended as expected are removed. A session that failed, was
-- interrupted or was closed for a reason other than an item boundary is
-- evidence of something and is kept however short it was. The raw events stay
-- in player_activity_events until their own retention expires, so the storm
-- remains diagnosable in Screen Events.
DELETE FROM playback_sessions
WHERE session_type <> 'presentation'
  AND result = 'completed'
  AND terminal_reason IN ('expected_item_boundary', 'completed_duration')
  AND actual_duration_ms IS NOT NULL
  AND actual_duration_ms < 1000;

-- Zero was stored as an expected duration for items with no duration. That is
-- "unknown", not a promise to play for zero milliseconds.
UPDATE playback_sessions SET expected_duration_ms = NULL WHERE expected_duration_ms = 0;

-- +goose Down

-- The removed sessions and the zero expectations cannot be reconstructed, and
-- restoring them would only bring the defect back. Nothing to undo.
SELECT 1;
