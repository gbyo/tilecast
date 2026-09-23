package httpapi

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
)

// Uptime is derived from the recorded screen state timeline rather than from a
// heartbeat history table, which the schema deliberately does not keep. An open
// up-state interval is clipped to the last heartbeat plus the same grace period
// the gap detector uses, so a player that silently stopped reporting counts as
// down instead of extending its last healthy interval forever.
const (
	uptimeHeartbeatGrace  = 3 * time.Minute
	uptimeScreenListLimit = 100
)

type uptimeWindowSpec struct {
	Key         string
	Bucket      time.Duration
	BucketCount int
	Label       string
}

var uptimeWindowSpecs = map[string]uptimeWindowSpec{
	"24h": {Key: "24h", Bucket: time.Hour, BucketCount: 24, Label: "Last 24 hours"},
	"7d":  {Key: "7d", Bucket: 6 * time.Hour, BucketCount: 28, Label: "Last 7 days"},
	"30d": {Key: "30d", Bucket: 24 * time.Hour, BucketCount: 30, Label: "Last 30 days"},
}

type uptimeRow struct {
	ScreenID    uuid.UUID
	ScreenName  string
	BucketStart time.Time
	BucketEnd   time.Time
	UpSeconds   float64
	ImpairedSec float64
	DownSeconds float64
}

// Bucket boundaries are aligned to the bucket size so repeated requests inside
// one bucket return the same series and the newest bucket is the partial one.
const uptimeRowsSQL = `
WITH bounds AS (
	SELECT $1::timestamptz AS from_ts, $2::timestamptz AS to_ts, $3::float8 AS bucket_seconds
), tracked AS (
	-- The same population the Screens list shows: uptime must not report on
	-- disabled screens or on screens whose pairing was revoked or removed,
	-- because their downtime is administrative rather than a fault.
	SELECT s.id, s.name, s.last_heartbeat_at
	FROM screens s
	WHERE s.enabled = TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL
	  AND EXISTS (SELECT 1 FROM device_credentials c WHERE c.screen_id = s.id AND c.revoked_at IS NULL)
), buckets AS (
	SELECT b.from_ts + make_interval(secs => b.bucket_seconds * (n - 1)) AS bucket_start,
	       LEAST(b.from_ts + make_interval(secs => b.bucket_seconds * n), b.to_ts) AS bucket_end
	FROM bounds b, generate_series(1, $4::int) AS n
), observed AS (
	SELECT t.id AS screen_id, i.state, COALESCE(i.reason_code, '') AS reason_code,
	       i.started_at, i.ended_at IS NULL AS open_ended,
	       CASE
	         WHEN i.ended_at IS NOT NULL THEN i.ended_at
	         WHEN i.state IN ('online', 'healthy') THEN GREATEST(i.started_at, LEAST(b.to_ts, COALESCE(t.last_heartbeat_at, i.started_at) + make_interval(secs => $5::float8)))
	         ELSE b.to_ts
	       END AS ended_at
	FROM tracked t
	CROSS JOIN bounds b
	JOIN screen_state_intervals i
	  ON i.screen_id = t.id AND i.started_at < b.to_ts AND COALESCE(i.ended_at, b.to_ts) > b.from_ts
), segments AS (
	SELECT screen_id,
	       CASE
	         WHEN state IN ('online', 'healthy') THEN 'up'
	         WHEN state = 'safe_mode' OR (state = 'degraded' AND reason_code <> 'heartbeat_gap') THEN 'impaired'
	         ELSE 'down'
	       END AS class,
	       started_at, ended_at
	FROM observed
	UNION ALL
	SELECT o.screen_id, 'down', o.ended_at, b.to_ts
	FROM observed o
	CROSS JOIN bounds b
	WHERE o.open_ended AND o.state IN ('online', 'healthy') AND o.ended_at < b.to_ts
)
SELECT t.id, t.name, k.bucket_start, k.bucket_end,
       COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(g.ended_at, k.bucket_end) - GREATEST(g.started_at, k.bucket_start)))) FILTER (WHERE g.class = 'up'), 0)::float8,
       COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(g.ended_at, k.bucket_end) - GREATEST(g.started_at, k.bucket_start)))) FILTER (WHERE g.class = 'impaired'), 0)::float8,
       COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(g.ended_at, k.bucket_end) - GREATEST(g.started_at, k.bucket_start)))) FILTER (WHERE g.class = 'down'), 0)::float8
FROM tracked t
CROSS JOIN buckets k
LEFT JOIN segments g
  ON g.screen_id = t.id AND g.started_at < k.bucket_end AND g.ended_at > k.bucket_start
GROUP BY t.id, t.name, k.bucket_start, k.bucket_end
ORDER BY t.name, k.bucket_start`

func (s *server) activityUptime(w http.ResponseWriter, r *http.Request) {
	key := queryValue(r, "window")
	if key == "" {
		key = "24h"
	}
	spec, ok := uptimeWindowSpecs[key]
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "uptime_window_invalid", "Window must be 24h, 7d, or 30d.")
		return
	}
	to := time.Now().UTC()
	from := to.Truncate(spec.Bucket).Add(-spec.Bucket * time.Duration(spec.BucketCount-1))
	rows, err := s.uptimeRows(r.Context(), from, to, spec.Bucket.Seconds(), spec.BucketCount)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	report := buildUptimeReport(rows, spec, from, to)
	span := to.Sub(from)
	previous, err := s.uptimeRows(r.Context(), from.Add(-span), from, span.Seconds(), 1)
	if err == nil {
		report.PreviousUptimePercent = uptimeTotalsPercent(previous)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": report})
}

func (s *server) uptimeRows(ctx context.Context, from, to time.Time, bucketSeconds float64, bucketCount int) ([]uptimeRow, error) {
	rows, err := s.db.Query(ctx, uptimeRowsSQL, from, to, bucketSeconds, bucketCount, uptimeHeartbeatGrace.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]uptimeRow, 0, bucketCount*8)
	for rows.Next() {
		var item uptimeRow
		if err := rows.Scan(&item.ScreenID, &item.ScreenName, &item.BucketStart, &item.BucketEnd, &item.UpSeconds, &item.ImpairedSec, &item.DownSeconds); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// buildUptimeReport folds one row per screen and bucket into fleet totals, a
// fleet series, and the per-screen strips shown beside it.
func buildUptimeReport(rows []uptimeRow, spec uptimeWindowSpec, from, to time.Time) uptimeReport {
	report := uptimeReport{
		Window:        spec.Key,
		WindowLabel:   spec.Label,
		BucketSeconds: int64(spec.Bucket.Seconds()),
		Buckets:       []uptimeBucket{},
		Screens:       []uptimeScreenUptime{},
	}
	report.Range.From, report.Range.To = from, to

	type accumulator struct {
		up, impaired, down, tracked float64
		screensDown                 int
	}
	bucketTotals := map[int64]*accumulator{}
	screenTotals := map[uuid.UUID]*uptimeScreenUptime{}
	screenOrder := []uuid.UUID{}

	for _, row := range rows {
		span := row.BucketEnd.Sub(row.BucketStart).Seconds()
		if span <= 0 {
			continue
		}
		up, impaired, down := clampUptimeSegments(row.UpSeconds, row.ImpairedSec, row.DownSeconds, span)
		key := row.BucketStart.Unix()
		bucket, ok := bucketTotals[key]
		if !ok {
			bucket = &accumulator{}
			bucketTotals[key] = bucket
		}
		bucket.up += up
		bucket.impaired += impaired
		bucket.down += down
		bucket.tracked += span
		if down > 0 {
			bucket.screensDown++
		}

		screen, ok := screenTotals[row.ScreenID]
		if !ok {
			screen = &uptimeScreenUptime{ScreenID: row.ScreenID, ScreenName: row.ScreenName, Buckets: []string{}}
			screenTotals[row.ScreenID] = screen
			screenOrder = append(screenOrder, row.ScreenID)
		}
		screen.UpSeconds += int64(up)
		screen.ImpairedSeconds += int64(impaired)
		screen.DownSeconds += int64(down)
		screen.TrackedSeconds += int64(span)
		screen.Buckets = append(screen.Buckets, uptimeBucketState(up, impaired, down))

		report.UpSeconds += int64(up)
		report.ImpairedSeconds += int64(impaired)
		report.DownSeconds += int64(down)
		report.TrackedSeconds += int64(span)
	}

	report.ScreensTracked = len(screenOrder)
	report.UptimePercent = uptimeRatio(float64(report.UpSeconds), float64(report.UpSeconds+report.ImpairedSeconds+report.DownSeconds))

	starts := make([]int64, 0, len(bucketTotals))
	for start := range bucketTotals {
		starts = append(starts, start)
	}
	sort.Slice(starts, func(left, right int) bool { return starts[left] < starts[right] })
	for _, start := range starts {
		total := bucketTotals[start]
		covered := total.up + total.impaired + total.down
		report.Buckets = append(report.Buckets, uptimeBucket{
			Start:           time.Unix(start, 0).UTC(),
			UpPercent:       uptimeShare(total.up, total.tracked),
			ImpairedPercent: uptimeShare(total.impaired, total.tracked),
			DownPercent:     uptimeShare(total.down, total.tracked),
			UnknownPercent:  uptimeShare(total.tracked-covered, total.tracked),
			UptimePercent:   uptimeRatio(total.up, covered),
			ScreensDown:     total.screensDown,
		})
	}

	for _, id := range screenOrder {
		screen := screenTotals[id]
		screen.UptimePercent = uptimeRatio(float64(screen.UpSeconds), float64(screen.UpSeconds+screen.ImpairedSeconds+screen.DownSeconds))
		if screen.DownSeconds > 0 {
			report.ScreensWithDowntime++
		}
		if screen.UptimePercent == nil {
			report.ScreensUnmeasured++
		}
		report.Screens = append(report.Screens, *screen)
	}
	sort.SliceStable(report.Screens, func(left, right int) bool {
		return lessUptimeScreen(report.Screens[left], report.Screens[right])
	})
	if len(report.Screens) > uptimeScreenListLimit {
		report.Screens = report.Screens[:uptimeScreenListLimit]
	}
	return report
}

// lessUptimeScreen ranks the screens an operator should look at first: measured
// screens ahead of unmeasured ones, then worst uptime, then longest downtime.
func lessUptimeScreen(left, right uptimeScreenUptime) bool {
	if (left.UptimePercent == nil) != (right.UptimePercent == nil) {
		return right.UptimePercent == nil
	}
	if left.UptimePercent != nil && right.UptimePercent != nil && *left.UptimePercent != *right.UptimePercent {
		return *left.UptimePercent < *right.UptimePercent
	}
	if left.DownSeconds != right.DownSeconds {
		return left.DownSeconds > right.DownSeconds
	}
	return left.ScreenName < right.ScreenName
}

func uptimeTotalsPercent(rows []uptimeRow) *float64 {
	var up, covered float64
	for _, row := range rows {
		span := row.BucketEnd.Sub(row.BucketStart).Seconds()
		if span <= 0 {
			continue
		}
		upSeconds, impaired, down := clampUptimeSegments(row.UpSeconds, row.ImpairedSec, row.DownSeconds, span)
		up += upSeconds
		covered += upSeconds + impaired + down
	}
	return uptimeRatio(up, covered)
}

// clampUptimeSegments protects the percentages from overlapping intervals: the
// derivation closes the previous state before opening the next one, but a
// duplicated event must not push a bucket past one hundred percent.
func clampUptimeSegments(up, impaired, down, span float64) (float64, float64, float64) {
	up, impaired, down = max(up, 0), max(impaired, 0), max(down, 0)
	total := up + impaired + down
	if total <= span || total == 0 {
		return up, impaired, down
	}
	scale := span / total
	return up * scale, impaired * scale, down * scale
}

// uptimeBucketState collapses one screen-bucket to the strip colour. Any
// recorded downtime marks the whole bucket down so short outages stay visible.
func uptimeBucketState(up, impaired, down float64) string {
	switch {
	case down > 0:
		return "down"
	case impaired > 0:
		return "impaired"
	case up > 0:
		return "up"
	default:
		return "unknown"
	}
}

func uptimeRatio(part, total float64) *float64 {
	if total <= 0 {
		return nil
	}
	value := roundUptimePercent(part / total * 100)
	return &value
}

func uptimeShare(part, total float64) float64 {
	if total <= 0 {
		return 0
	}
	return roundUptimePercent(max(part, 0) / total * 100)
}

func roundUptimePercent(value float64) float64 {
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	return float64(int64(value*100+0.5)) / 100
}
