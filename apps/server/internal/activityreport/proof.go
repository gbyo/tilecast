package activityreport

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/keyset"
)

// ErrInvalidFilter wraps every proof filter failure. Its message is safe
// to show a caller.
var ErrInvalidFilter = errors.New("activity filter is invalid")

type filterError struct{ message string }

func (e filterError) Error() string        { return e.message }
func (e filterError) Is(target error) bool { return target == ErrInvalidFilter }

// ProofFilter narrows proof-of-play sessions. Empty members do not filter.
type ProofFilter struct {
	Screen *uuid.UUID
	Group  *uuid.UUID
	Result string
	// SessionType is one of the session types.
	SessionType string
	// TerminalReason is a reason, an alias, or TerminalUnexpected.
	TerminalReason string
	Content        string
	// Playlist and Layout select a presentation of that type; Presentation
	// selects a presentation of any type.
	Playlist     string
	Layout       string
	Presentation string
	Schedule     string
	Takeover     string
	Search       string
}

// ProofSession is one playback session row. Metadata is the raw stored
// document: the Studio route redacts it by viewer, and the service never
// returns it.
type ProofSession struct {
	ID                   uuid.UUID
	StartedAt            time.Time
	EndedAt              *time.Time
	ScreenID             uuid.UUID
	ScreenName           string
	GroupID              *uuid.UUID
	GroupName            string
	PresentationType     string
	PresentationID       string
	PresentationRevision string
	PresentationName     string
	ContentType          string
	ContentID            string
	ContentName          string
	PlaylistItemID       string
	LayoutPlacementID    string
	ActualDurationMS     *int64
	ExpectedDurationMS   *int64
	Result               string
	Trigger              string
	ScheduleID           string
	TakeoverID           string
	ManifestVersion      *int64
	FailureCode          string
	SourceID             string
	SelectedRecordID     string
	SelectionDate        *time.Time
	SourceCachedAt       *time.Time
	SourceRevision       string
	SnapshotHash         string
	SessionType          string
	TerminalReason       string
	Metadata             []byte
}

// ProofSelectSQL reads sessions with the names Activity shows. It ends at
// FROM; callers add WHERE, ORDER BY, and LIMIT.
const ProofSelectSQL = `
	SELECT p.id,p.started_at,p.ended_at,p.screen_id,s.name,p.group_id,COALESCE(g.name,''),
	       COALESCE(p.presentation_type,''),COALESCE(p.presentation_id,''),COALESCE(p.presentation_revision,''),
	       COALESCE(NULLIF(p.presentation_name,''),pl.name,l.name,''),
	       COALESCE(p.content_type,''),COALESCE(p.content_id,''),COALESCE(NULLIF(p.content_name,''),a.name,''),COALESCE(p.playlist_item_id,''),COALESCE(p.layout_placement_id,''),
	       p.actual_duration_ms,p.expected_duration_ms,p.result,COALESCE(p.trigger_context,''),COALESCE(p.schedule_id,''),COALESCE(p.takeover_id,''),
	       p.manifest_version,COALESCE(p.failure_code,''),COALESCE(p.source_id,''),COALESCE(p.selected_record_id,''),p.selection_date,
	       p.source_cached_at,COALESCE(p.source_revision,''),COALESCE(p.snapshot_hash,''),p.session_type,COALESCE(p.terminal_reason,''),p.metadata
	FROM playback_sessions p
	JOIN screens s ON s.id=p.screen_id
	LEFT JOIN screen_groups g ON g.id=p.group_id
	LEFT JOIN playlists pl ON p.presentation_type='playlist' AND p.presentation_id=pl.id::text
	LEFT JOIN layouts l ON p.presentation_type='layout' AND p.presentation_id=l.id::text
	LEFT JOIN assets a ON p.content_id=a.id::text`

// ScanProof reads one ProofSelectSQL row.
func ScanProof(scan func(dest ...any) error) (ProofSession, error) {
	var item ProofSession
	err := scan(&item.ID, &item.StartedAt, &item.EndedAt, &item.ScreenID, &item.ScreenName, &item.GroupID, &item.GroupName,
		&item.PresentationType, &item.PresentationID, &item.PresentationRevision, &item.PresentationName,
		&item.ContentType, &item.ContentID, &item.ContentName, &item.PlaylistItemID, &item.LayoutPlacementID,
		&item.ActualDurationMS, &item.ExpectedDurationMS, &item.Result, &item.Trigger, &item.ScheduleID, &item.TakeoverID,
		&item.ManifestVersion, &item.FailureCode, &item.SourceID, &item.SelectedRecordID, &item.SelectionDate,
		&item.SourceCachedAt, &item.SourceRevision, &item.SnapshotHash, &item.SessionType, &item.TerminalReason, &item.Metadata)
	return item, err
}

// ProofClauses returns the WHERE clauses and arguments for sessions that
// started in the window. Summary durations are interval measures, so with
// overlap they include sessions that overlap the range; record and outcome
// counts still use sessions that started in it.
func ProofClauses(filter ProofFilter, window Window, overlap bool) ([]string, []any, error) {
	clauses := []string{"p.started_at >= $1", "p.started_at < $2", "s.enabled = TRUE", "s.deleted_at IS NULL", "s.archived_at IS NULL"}
	if overlap {
		clauses = []string{"p.started_at < $2", "COALESCE(p.ended_at,$2) > $1", "s.enabled = TRUE", "s.deleted_at IS NULL", "s.archived_at IS NULL"}
	}
	args := []any{window.From, window.To}
	add := func(expression string, value any) {
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf(expression, len(args)))
	}
	if filter.Screen != nil {
		add("p.screen_id = $%d", *filter.Screen)
	}
	if filter.Group != nil {
		add("p.group_id = $%d", *filter.Group)
	}
	if filter.Result != "" {
		add("p.result = $%d", filter.Result)
	}
	if filter.SessionType != "" {
		if !IsSessionType(filter.SessionType) {
			return clauses, args, filterError{"sessionType is invalid"}
		}
		add("p.session_type = $%d", filter.SessionType)
	}
	if value := filter.TerminalReason; value != "" {
		// "unexpected" is the set the Interrupted plays metric counts. Without
		// it the drill-down could only pick one reason and would not match.
		switch {
		case value == TerminalUnexpected:
			add("p.terminal_reason = ANY($%d)", InterruptedTerminalReasons())
		case !IsTerminalReason(value):
			return clauses, args, filterError{"terminalReason is invalid"}
		default:
			add("p.terminal_reason = $%d", CanonicalTerminalReason(value))
		}
	}
	if filter.Content != "" {
		add("p.content_id = $%d", filter.Content)
	}
	if filter.Playlist != "" {
		add("p.presentation_id = $%d AND p.presentation_type='playlist'", filter.Playlist)
	}
	if filter.Layout != "" {
		add("p.presentation_id = $%d AND p.presentation_type='layout'", filter.Layout)
	}
	if filter.Presentation != "" {
		add("p.presentation_id = $%d", filter.Presentation)
	}
	if filter.Schedule != "" {
		add("p.schedule_id = $%d", filter.Schedule)
	}
	if filter.Takeover != "" {
		add("p.takeover_id = $%d", filter.Takeover)
	}
	if filter.Search != "" {
		args = append(args, "%"+filter.Search+"%")
		p := len(args)
		clauses = append(clauses, fmt.Sprintf("(s.name ILIKE $%d OR COALESCE(p.presentation_name,'') ILIKE $%d OR COALESCE(p.content_name,'') ILIKE $%d OR COALESCE(p.presentation_id,'') ILIKE $%d OR COALESCE(p.content_id,'') ILIKE $%d)", p, p, p, p, p))
	}
	return clauses, args, nil
}

// ListProof returns at most limit sessions that started in the window,
// newest first with the id as the tie-breaker, after the position.
func (r *Reports) ListProof(ctx context.Context, filter ProofFilter, window Window, after *keyset.After, limit int) ([]ProofSession, error) {
	clauses, args, err := ProofClauses(filter, window, false)
	if err != nil {
		return nil, err
	}
	clauses = append(clauses, keyset.Descending(after, "p.started_at", "p.id", &args))
	args = append(args, limit)
	rows, err := r.db.Query(ctx, ProofSelectSQL+` WHERE `+strings.Join(clauses, " AND ")+` ORDER BY p.started_at DESC,p.id DESC LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	return collectProof(rows, limit)
}

// ScreenProof returns a screen's newest sessions, or only its open ones.
func (r *Reports) ScreenProof(ctx context.Context, screenID uuid.UUID, openOnly bool, limit int) ([]ProofSession, error) {
	open := ""
	if openOnly {
		open = ` AND p.ended_at IS NULL`
	}
	rows, err := r.db.Query(ctx, ProofSelectSQL+` WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND p.screen_id=$1`+open+` ORDER BY p.started_at DESC LIMIT $2`, screenID, limit)
	if err != nil {
		return nil, err
	}
	return collectProof(rows, limit)
}

func collectProof(rows pgx.Rows, capacity int) ([]ProofSession, error) {
	defer rows.Close()
	items := make([]ProofSession, 0, capacity)
	for rows.Next() {
		item, err := ScanProof(rows.Scan)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// Summary dimensions of the proof-of-play summary.
const (
	SummaryByScreen       = "screen"
	SummaryByContent      = "content"
	SummaryByPresentation = "presentation"
	SummaryBySchedule     = "schedule"
)

// IsSummaryDimension reports whether value is a proof summary dimension.
func IsSummaryDimension(value string) bool {
	switch value {
	case SummaryByScreen, SummaryByContent, SummaryByPresentation, SummaryBySchedule:
		return true
	}
	return false
}

// SummaryItem is one proof summary group. The meanings are those of
// docs/activity.md.
type SummaryItem struct {
	Key   string
	Label string
	// ConfirmedScreenPlaybackMS is wall-clock screen time for this group:
	// the union of its root presentation intervals, so overlapping zones are
	// not double-counted.
	ConfirmedScreenPlaybackMS int64
	ContentExposureMS         int64
	Records                   int64
	Completed                 int64
	Failures                  int64
	Partial                   int64
	Unknown                   int64
	Interrupted               int64
	// SessionCompletionPercent is the share of sessions that completed or
	// ran partially. It is a session outcome rate, not scheduled-playback
	// coverage.
	SessionCompletionPercent float64
}

// ProofSummary groups the window's sessions by dimension, largest
// confirmed screen playback first, the key as the final tie-breaker, and
// returns at most limit groups after offset.
func (r *Reports) ProofSummary(ctx context.Context, filter ProofFilter, window Window, dimension string, offset, limit int) ([]SummaryItem, error) {
	clauses, args, err := ProofClauses(filter, window, true)
	if err != nil {
		return nil, err
	}
	var keyExpression, labelExpression string
	switch dimension {
	case SummaryByContent:
		keyExpression, labelExpression = "COALESCE(p.content_id,'presentation:'||COALESCE(p.presentation_id,''))", "COALESCE(NULLIF(p.content_name,''),NULLIF(p.presentation_name,''),'Unknown content')"
	case SummaryByPresentation:
		keyExpression, labelExpression = "COALESCE(p.presentation_id,'')", "COALESCE(NULLIF(p.presentation_name,''),'Unknown presentation')"
	case SummaryBySchedule:
		keyExpression, labelExpression = "COALESCE(p.schedule_id,'direct')", "COALESCE(NULLIF(p.schedule_id,''),'Direct assignment')"
	case SummaryByScreen:
		keyExpression, labelExpression = "p.screen_id::text", "s.name"
	default:
		return nil, filterError{"dimension is invalid"}
	}
	// Root and child durations are totalled separately. Root sessions are the
	// screen's wall clock; child sessions are exposure and can overlap, so the
	// two must never be added together into one "confirmed playback" number.
	interrupted := len(args) + 1
	args = append(args, InterruptedTerminalReasons(), limit, offset)
	rows, err := r.db.Query(ctx, `
		WITH selected AS (
			SELECT p.*,`+keyExpression+` AS dimension_key,`+labelExpression+` AS dimension_label,
			       GREATEST(p.started_at,$1::timestamptz) AS clipped_start,
			       LEAST(COALESCE(p.ended_at,$2::timestamptz),$2::timestamptz) AS clipped_end
			FROM playback_sessions p JOIN screens s ON s.id=p.screen_id
			WHERE `+strings.Join(clauses, " AND ")+`
		), root_ordered AS (
			SELECT dimension_key,dimension_label,screen_id,clipped_start,clipped_end,
			       CASE WHEN clipped_start > MAX(clipped_end) OVER (
			              PARTITION BY dimension_key,dimension_label,screen_id
			              ORDER BY clipped_start,clipped_end
			              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
			            THEN 1 ELSE 0 END AS island_start
			FROM selected
			WHERE session_type='presentation'
			  AND result IN('playing','completed','recovered','partial')
		), root_islands AS (
			SELECT dimension_key,dimension_label,screen_id,clipped_start,clipped_end,
			       SUM(island_start) OVER (
			         PARTITION BY dimension_key,dimension_label,screen_id
			         ORDER BY clipped_start,clipped_end) AS island
			FROM root_ordered
		), root_totals AS (
			SELECT dimension_key,dimension_label,
			       COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at-started_at)))*1000,0)::bigint AS duration_ms
			FROM (
				SELECT dimension_key,dimension_label,screen_id,island,
				       MIN(clipped_start) AS started_at,MAX(clipped_end) AS ended_at
				FROM root_islands
				GROUP BY dimension_key,dimension_label,screen_id,island
			) merged
			GROUP BY dimension_key,dimension_label
		), metrics AS (
			SELECT dimension_key,dimension_label,
			       COALESCE(SUM(EXTRACT(EPOCH FROM (clipped_end-clipped_start)))
			         FILTER(WHERE session_type<>'presentation'
			           AND result IN('playing','completed','recovered','partial'))*1000,0)::bigint AS exposure_ms,
			       count(*) FILTER(WHERE started_at>=$1 AND started_at<$2)::bigint AS records,
			       count(*) FILTER(WHERE started_at>=$1 AND started_at<$2 AND result='completed')::bigint AS completed,
			       count(*) FILTER(WHERE started_at>=$1 AND started_at<$2 AND result='failed')::bigint AS failures,
			       count(*) FILTER(WHERE started_at>=$1 AND started_at<$2 AND result='partial')::bigint AS partial,
			       count(*) FILTER(WHERE started_at>=$1 AND started_at<$2 AND result='unknown')::bigint AS unknown,
			       count(*) FILTER(WHERE started_at>=$1 AND started_at<$2
			         AND terminal_reason = ANY($`+strconv.Itoa(interrupted)+`))::bigint AS interrupted
			FROM selected
			GROUP BY dimension_key,dimension_label
		)
		SELECT m.dimension_key,m.dimension_label,COALESCE(r.duration_ms,0),m.exposure_ms,
		       m.records,m.completed,m.failures,m.partial,m.unknown,m.interrupted
		FROM metrics m
		LEFT JOIN root_totals r USING(dimension_key,dimension_label)
		ORDER BY 3 DESC,4 DESC,2,1 LIMIT $`+strconv.Itoa(interrupted+1)+` OFFSET $`+strconv.Itoa(interrupted+2), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SummaryItem{}
	for rows.Next() {
		var item SummaryItem
		if err := rows.Scan(&item.Key, &item.Label, &item.ConfirmedScreenPlaybackMS, &item.ContentExposureMS, &item.Records, &item.Completed, &item.Failures, &item.Partial, &item.Unknown, &item.Interrupted); err != nil {
			return nil, err
		}
		if item.Records > 0 {
			item.SessionCompletionPercent = float64(item.Completed+item.Partial) / float64(item.Records) * 100
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
