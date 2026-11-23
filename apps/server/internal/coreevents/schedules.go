package coreevents

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// EmitSchedules emits schedule.changed@1 for schedules changed in tx. The
// scheduling service, Campaigns, group deletion, and screen archive call it
// with the schedules their own statements changed, and with the time of
// their own clock.
func EmitSchedules(ctx context.Context, tx pgx.Tx, sink Sink, change string, targetsChanged bool, at time.Time, ids ...uuid.UUID) error {
	if sink == nil {
		return nil
	}
	now := at.UTC()
	for _, id := range ids {
		var enabled bool
		if err := tx.QueryRow(ctx, `SELECT enabled AND deleted_at IS NULL FROM schedules WHERE id=$1`, id).Scan(&enabled); err != nil {
			return err
		}
		if err := sink.Emit(ctx, tx, Event{
			Name: plugin.CoreScheduleChanged, Subject: ScheduleSubject(id), OccurredAt: now,
			Payload: Schedule{ScheduleID: id, Change: change, Enabled: enabled, TargetsChanged: targetsChanged, At: now},
		}); err != nil {
			return err
		}
	}
	return nil
}
