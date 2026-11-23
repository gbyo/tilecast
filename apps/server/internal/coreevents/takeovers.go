package coreevents

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/takeovers/precedence"
)

// endedStates are the screen states in which a Takeover no longer shows.
const endedStates = `('restored','cancelled','expired')`

// EffectiveCounts answers, for each Takeover, the number of its screens
// that show it at a time under the precedence rule. The Takeover service
// compares the counts before and after an activation to find the Takeovers
// the activation suspended.
func EffectiveCounts(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, at time.Time) (map[uuid.UUID]int, error) {
	out := map[uuid.UUID]int{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `SELECT st.takeover_id, count(*) FILTER (WHERE `+precedence.EffectiveIDSQL("st.screen_id", "$2")+` = st.takeover_id)
		FROM takeover_screen_states st
		WHERE st.takeover_id=ANY($1) AND st.state NOT IN `+endedStates+`
		GROUP BY st.takeover_id`, ids, at)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			return nil, err
		}
		out[id] = count
	}
	return out, rows.Err()
}

// EmitTakeover emits one takeover.started@1, takeover.ended@1, or
// takeover.suspended@1 for a Takeover changed in tx. It reads the Takeover
// once, so every producer sends the same payload.
func EmitTakeover(ctx context.Context, tx pgx.Tx, sink Sink, name string, id uuid.UUID, reason string, suspendedBy *uuid.UUID, at time.Time) error {
	if sink == nil {
		return nil
	}
	payload := Takeover{TakeoverID: id, Reason: reason, SuspendedBy: suspendedBy, At: at.UTC()}
	if err := tx.QueryRow(ctx, `SELECT class, activated_at, expires_at,
			(SELECT count(*) FROM takeover_screen_states st WHERE st.takeover_id=t.id),
			(SELECT count(*) FROM takeover_screen_states st WHERE st.takeover_id=t.id AND st.state NOT IN `+endedStates+`
				AND `+precedence.EffectiveIDSQL("st.screen_id", "$2")+` = t.id)
		FROM takeovers t WHERE t.id=$1`, id, at).Scan(&payload.Class, &payload.ActivatedAt, &payload.ExpiresAt,
		&payload.ScreenCount, &payload.EffectiveScreenCount); err != nil {
		return err
	}
	return sink.Emit(ctx, tx, Event{Name: name, Subject: TakeoverSubject(id), OccurredAt: at, Payload: payload})
}
