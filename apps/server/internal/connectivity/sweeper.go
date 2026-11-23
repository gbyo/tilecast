// Package connectivity keeps the one persisted connectivity state of each
// screen and the connectivity incident that goes with it
// (docs/plugin-events.md#screen-connectivity).
//
// internal/devices/status.go computes a screen's display status on every
// read. This package records the transition: a screen is offline when the
// Server has not heard a heartbeat for longer than devices.OfflineThreshold,
// and reachable otherwise. One outage is one change to offline and one
// change back, whatever the number of heartbeats, reconnects, or reads in
// between. Each change emits screen.status.changed@1, and the connectivity
// incident opens and recovers in the same transaction, so a notification
// and an event never disagree about an outage.
package connectivity

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// IncidentType is the incident type of a screen that stopped reporting.
const IncidentType = "connectivity"

// IncidentTitle is the title the sweep and the event-derived path share.
const IncidentTitle = "Screen stopped reporting"

// Sweeper records connectivity transitions. Several Server processes can
// sweep at once: a transaction advisory lock serializes them.
type Sweeper struct {
	db     *pgxpool.Pool
	events coreevents.Sink
	now    func() time.Time
}

// NewSweeper makes a sweeper. events may be nil.
func NewSweeper(db *pgxpool.Pool, events coreevents.Sink) *Sweeper {
	return &Sweeper{db: db, events: events, now: func() time.Time { return time.Now().UTC() }}
}

// WithClock replaces the time source. Tests step it.
func (s *Sweeper) WithClock(now func() time.Time) *Sweeper {
	s.now = now
	return s
}

// eligible screens can change connectivity: enabled, not archived or
// deleted, and holding a live credential. sc aliases screens.
const eligible = `sc.enabled=TRUE AND sc.deleted_at IS NULL AND sc.archived_at IS NULL
	AND EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=sc.id AND c.revoked_at IS NULL)`

// Sweep records the transitions since the last sweep. The notify worker
// runs it every 30 seconds, before it scans incidents for notifications;
// the incident list runs it before it reads.
func (s *Sweeper) Sweep(ctx context.Context) error {
	now := s.now()
	threshold := devices.OfflineThreshold
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('tilecast.connectivity.sweep',0))`); err != nil {
			return err
		}
		// A screen seen for the first time gets its state without an event:
		// there is no transition to report.
		if _, err := tx.Exec(ctx, `INSERT INTO screen_connectivity(screen_id,state,changed_at)
			SELECT sc.id, CASE WHEN sc.last_heartbeat_at IS NOT NULL AND sc.last_heartbeat_at>=$1::timestamptz-$2::interval THEN 'reachable' ELSE 'offline' END, $1
			FROM screens sc WHERE `+eligible+`
			ON CONFLICT (screen_id) DO NOTHING`, now, threshold); err != nil {
			return err
		}
		for _, change := range []struct{ from, to, condition string }{
			{coreevents.ScreenReachable, coreevents.ScreenOffline, `(sc.last_heartbeat_at IS NULL OR sc.last_heartbeat_at<$1::timestamptz-$2::interval)`},
			{coreevents.ScreenOffline, coreevents.ScreenReachable, `sc.last_heartbeat_at>=$1::timestamptz-$2::interval`},
		} {
			rows, err := tx.Query(ctx, `UPDATE screen_connectivity conn SET state=$4, changed_at=$1
				FROM screens sc WHERE sc.id=conn.screen_id AND conn.state=$3 AND `+eligible+` AND `+change.condition+`
				RETURNING conn.screen_id, sc.last_heartbeat_at`, now, threshold, change.from, change.to)
			if err != nil {
				return err
			}
			type changed struct {
				id          uuid.UUID
				lastContact *time.Time
			}
			screens, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (changed, error) {
				var c changed
				return c, row.Scan(&c.id, &c.lastContact)
			})
			if err != nil {
				return err
			}
			for _, screen := range screens {
				if err := coreevents.Emit(ctx, tx, s.events, coreevents.Event{
					Name: plugin.CoreScreenStatusChanged, Subject: coreevents.ScreenSubject(screen.id), OccurredAt: now,
					Payload: coreevents.ScreenStatus{ScreenID: screen.id, Status: change.to, PreviousStatus: change.from, LastContactAt: screen.lastContact, ChangedAt: now},
				}); err != nil {
					return err
				}
			}
		}
		return s.syncIncidents(ctx, tx, now, threshold)
	})
}

// syncIncidents opens the connectivity incident of each screen that is
// past the threshold and recovers the incident of each screen that reports
// again. The partial unique index keeps one active incident for each
// screen, so a screen offline for a week still has one incident.
func (s *Sweeper) syncIncidents(ctx context.Context, tx pgx.Tx, now time.Time, threshold time.Duration) error {
	rows, err := tx.Query(ctx, `
		INSERT INTO incidents(
			id,incident_type,severity,status,title,description,opened_at,last_seen_at,
			primary_screen_id,location_id,group_id,device_model,player_version,dedupe_key,metadata)
		SELECT gen_random_uuid(),$1,'error','open',$2,
		       'The Player has not reported within the heartbeat grace period.',
		       -- Opened when reporting stopped, not when the sweep noticed,
		       -- so time-to-recover measures the outage.
		       sc.last_heartbeat_at + $4::interval, $3,
		       sc.id,sc.location_id,
		       (SELECT m.screen_group_id FROM screen_group_memberships m WHERE m.screen_id=sc.id ORDER BY m.screen_group_id LIMIT 1),
		       sc.device_model,sc.player_version,
		       $1||':screen:'||sc.id::text,'{"source":"offline_sweep"}'::jsonb
		FROM screens sc
		WHERE `+eligible+`
		  AND sc.last_heartbeat_at IS NOT NULL AND sc.last_heartbeat_at < $3::timestamptz-$4::interval
		ON CONFLICT DO NOTHING
		RETURNING id`, IncidentType, IncidentTitle, now, threshold)
	if err != nil {
		return err
	}
	opened, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	if err := coreevents.EmitIncidents(ctx, tx, s.events, plugin.CoreIncidentOpened, coreevents.IncidentDetected, now, opened...); err != nil {
		return err
	}
	// The heartbeat is the evidence, so this is an automatic recovery.
	rows, err = tx.Query(ctx, `
		UPDATE incidents i SET status='recovered',recovered_at=sc.last_heartbeat_at,
			recovery_mode='automatic',
			resolution_reason=COALESCE(NULLIF(i.resolution_reason,''),'Screen is reporting again.'),
			updated_at=now()
		FROM screens sc
		WHERE sc.id=i.primary_screen_id AND i.incident_type=$1 AND i.status IN('open','acknowledged')
		  AND sc.last_heartbeat_at IS NOT NULL AND sc.last_heartbeat_at >= $2::timestamptz-$3::interval
		RETURNING i.id`, IncidentType, now, threshold)
	if err != nil {
		return err
	}
	recovered, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	return coreevents.EmitIncidents(ctx, tx, s.events, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic, now, recovered...)
}
