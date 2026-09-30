package demo

import (
	"context"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// historyDays is how much state history a seeded screen gets: enough to fill
// the longest uptime window, so every Fleet health range has data on the
// first page load instead of only the minutes since the demo started.
const historyDays = 30

// historyInterval is one recorded state span. A nil End is the open interval
// a silent screen leaves behind.
type historyInterval struct {
	State  string
	Reason string
	Start  time.Time
	End    *time.Time
}

// stateHistory builds a screen's past state timeline from `from` to `until`.
// Most of it is healthy, broken by occasional outages and short impaired
// spells, so uptime reads in the high nineties with visible dips. The pattern
// is seeded by the screen ID, so a reset reproduces it exactly.
//
// A screen the simulator drives gets closed intervals ending at `until`; the
// live heartbeat opens the next one. A silent screen instead ends on an open
// healthy interval: the uptime query clips an open up-state interval at the
// last heartbeat plus its grace period and counts the rest as down, exactly
// as it treats a real player that stopped reporting.
func stateHistory(screen uuid.UUID, from, until time.Time, silent bool) []historyInterval {
	seed := binary.BigEndian.Uint64(screen[:8]) ^ binary.BigEndian.Uint64(screen[8:])
	random := rand.New(rand.NewPCG(seed, seed>>1|1))
	between := func(min, max time.Duration) time.Duration {
		return min + time.Duration(random.Int64N(int64(max-min)))
	}
	intervals := []historyInterval{}
	add := func(state, reason string, start, end time.Time) {
		closed := end
		intervals = append(intervals, historyInterval{State: state, Reason: reason, Start: start, End: &closed})
	}
	cursor := from
	for {
		healthy := between(18*time.Hour, 60*time.Hour)
		if !cursor.Add(healthy).Before(until) {
			break
		}
		add("healthy", "", cursor, cursor.Add(healthy))
		cursor = cursor.Add(healthy)

		// A fault: usually an outage, sometimes a spell of impaired playback.
		var state, reason string
		var length time.Duration
		switch roll := random.IntN(10); {
		case roll < 6:
			state, length = "offline", between(10*time.Minute, 90*time.Minute)
		case roll < 9:
			state, reason, length = "degraded", "playback_error", between(5*time.Minute, 40*time.Minute)
		default:
			state, length = "safe_mode", between(5*time.Minute, 30*time.Minute)
		}
		if !cursor.Add(length).Before(until) {
			break
		}
		add(state, reason, cursor, cursor.Add(length))
		cursor = cursor.Add(length)
	}
	if silent {
		intervals = append(intervals, historyInterval{State: "healthy", Start: cursor})
	} else {
		add("healthy", "", cursor, until)
	}
	return intervals
}

// backfillHistory records a seeded screen's past state timeline. It writes
// only history: nothing after the seed, and never an open interval for a
// screen the simulator will drive.
func backfillHistory(ctx context.Context, db *pgxpool.Pool, spec ScreenSpec, now time.Time) error {
	if spec.State == StateDisabled {
		// Uptime excludes disabled screens, so their history would never show.
		return nil
	}
	silent := !spec.State.simulated()
	until := now
	if silent {
		until = now.Add(-spec.State.lastContactAge())
	}
	intervals := stateHistory(spec.ID, now.Add(-historyDays*24*time.Hour), until, silent)
	ids := make([]uuid.UUID, len(intervals))
	states := make([]string, len(intervals))
	reasons := make([]string, len(intervals))
	starts := make([]time.Time, len(intervals))
	ends := make([]*time.Time, len(intervals))
	for i, interval := range intervals {
		ids[i] = uuid.New()
		states[i], reasons[i], starts[i], ends[i] = interval.State, interval.Reason, interval.Start, interval.End
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO screen_state_intervals(id,screen_id,state,reason_code,started_at,ended_at,metadata)
		SELECT id,$2,state,NULLIF(reason,''),started_at,ended_at,'{"source":"demo"}'::jsonb
		FROM unnest($1::uuid[],$3::text[],$4::text[],$5::timestamptz[],$6::timestamptz[]) AS h(id,state,reason,started_at,ended_at)`,
		ids, spec.ID, states, reasons, starts, ends); err != nil {
		return fmt.Errorf("record state history for demo screen %s: %w", spec.ID, err)
	}
	return nil
}
