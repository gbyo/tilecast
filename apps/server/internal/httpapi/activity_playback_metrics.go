package httpapi

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// Confirmed screen playback time is wall-clock time: the union of root
// presentation intervals per screen, clipped to the range. Summing every
// session instead would count two layout zones playing at once as two seconds
// of screen time for one second of wall clock.
//
// The union is computed with the standard gaps-and-islands shape: order each
// screen's root intervals, mark the ones that start after every earlier one has
// ended, and total the merged islands.
const confirmedScreenPlaybackSQL = `
WITH bounds AS (
	SELECT $1::timestamptz AS from_ts, $2::timestamptz AS to_ts
), clipped AS (
	SELECT p.screen_id,
	       GREATEST(p.started_at, b.from_ts) AS started_at,
	       LEAST(COALESCE(p.ended_at, b.to_ts), b.to_ts) AS ended_at
	FROM playback_sessions p JOIN screens s ON s.id=p.screen_id CROSS JOIN bounds b
	WHERE p.session_type = 'presentation'
	  AND s.enabled = TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL
	  AND p.result IN ('playing','completed','recovered','partial')
	  AND p.started_at < b.to_ts AND COALESCE(p.ended_at, b.to_ts) > b.from_ts
), ordered AS (
	SELECT screen_id, started_at, ended_at,
	       CASE WHEN started_at > MAX(ended_at) OVER (
	              PARTITION BY screen_id ORDER BY started_at, ended_at
	              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) THEN 1 ELSE 0 END AS island_start
	FROM clipped
), islands AS (
	SELECT screen_id, started_at, ended_at,
	       SUM(island_start) OVER (PARTITION BY screen_id ORDER BY started_at, ended_at) AS island
	FROM ordered
)
SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (merged.ended_at - merged.started_at))) * 1000, 0)::bigint
FROM (
	SELECT screen_id, island, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at
	FROM islands GROUP BY screen_id, island
) merged`

// Content exposure is the sum of child intervals. It legitimately exceeds wall
// clock when several layout zones show content at once, which is why it is
// reported as its own number rather than folded into screen playback time.
const contentExposureSQL = `
SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
           LEAST(COALESCE(p.ended_at, $2::timestamptz), $2::timestamptz)
         - GREATEST(p.started_at, $1::timestamptz)))) * 1000, 0)::bigint
FROM playback_sessions p JOIN screens s ON s.id=p.screen_id
WHERE p.session_type <> 'presentation'
	AND s.enabled = TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL
  AND p.result IN ('playing','completed','recovered','partial')
  AND p.started_at < $2::timestamptz AND COALESCE(p.ended_at, $2::timestamptz) > $1::timestamptz`

type playbackDurations struct {
	ConfirmedScreenMS int64
	ContentExposureMS int64
}

func (s *server) playbackDurations(ctx context.Context, from, to time.Time, scopeUser uuid.UUID, scoped bool) (playbackDurations, error) {
	var durations playbackDurations
	confirmedQuery := confirmedScreenPlaybackSQL
	contentQuery := contentExposureSQL
	args := []any{from, to}
	if scoped {
		// The merged islands carry no screens alias, so the scope joins
		// screens back at the outer level rather than inside the CTEs.
		confirmedQuery += ` JOIN screens s ON s.id = merged.screen_id WHERE ` + devices.InScopeSQL("s", "$3")
		contentQuery += ` AND ` + devices.InScopeSQL("s", "$3")
		args = append(args, scopeUser)
	}
	if err := s.db.QueryRow(ctx, confirmedQuery, args...).Scan(&durations.ConfirmedScreenMS); err != nil {
		return durations, err
	}
	err := s.db.QueryRow(ctx, contentQuery, args...).Scan(&durations.ContentExposureMS)
	return durations, err
}
