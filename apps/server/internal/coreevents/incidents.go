package coreevents

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// EmitIncidents emits incident.opened@1 or incident.recovered@1 for each
// incident a writer just opened or closed in tx. Every incident writer
// calls it with the IDs its own statement returned, so one payload builder
// serves the event-derived incidents, the connectivity sweep, Content
// Health, and operator transitions.
func EmitIncidents(ctx context.Context, tx pgx.Tx, sink Sink, name, reason string, at time.Time, ids ...uuid.UUID) error {
	if sink == nil || len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT id,incident_type,severity,failure_code,primary_screen_id,related_type,related_id
		FROM incidents WHERE id=ANY($1) ORDER BY id`, ids)
	if err != nil {
		return err
	}
	incidents, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Incident, error) {
		incident := Incident{Reason: reason, At: at.UTC()}
		err := row.Scan(&incident.IncidentID, &incident.Type, &incident.Severity, &incident.FailureCode,
			&incident.ScreenID, &incident.RelatedType, &incident.RelatedID)
		return incident, err
	})
	if err != nil {
		return err
	}
	for _, incident := range incidents {
		if err := sink.Emit(ctx, tx, Event{Name: name, Subject: IncidentSubject(incident.IncidentID), OccurredAt: at, Payload: incident}); err != nil {
			return err
		}
	}
	return nil
}
