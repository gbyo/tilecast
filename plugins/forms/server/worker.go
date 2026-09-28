package server

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var _ plugin.WorkerProvider = (*Service)(nil)

// projectionWorkerName is the registered background worker. The host starts
// it after migrations and stops it at shutdown; the manifest must declare
// capabilities.backgroundWorkers.
const projectionWorkerName = "form-projection"

// projectionTickInterval is the cadence between time-boundary checks. Forms
// are projected eagerly on mutation; the worker only handles the passage of
// time, so it polls infrequently.
const projectionTickInterval = 15 * time.Second

// Workers contributes the projection worker. It wakes forms at their next
// time-window boundary to re-project time-based views and auto-expire
// records that have passed their expiry.
func (s *Service) Workers() []plugin.Worker {
	return []plugin.Worker{{Name: projectionWorkerName, Run: s.runProjection}}
}

func (s *Service) runProjection(ctx context.Context) error {
	logger := s.host.Logger
	if logger == nil {
		logger = slog.Default()
	}
	ticker := time.NewTicker(projectionTickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		if jobs := s.host.BackgroundJobs; jobs != nil && !jobs.Allowed() {
			continue
		}
		if err := s.RunDue(ctx); err != nil && ctx.Err() == nil {
			logger.Error("form projection tick failed", "error", err)
		}
	}
}

// RunDue claims every form whose scheduled boundary has arrived, expires overdue records inside a
// single transaction (so multiple Tilecast processes never expire or project the same form
// concurrently), then rebuilds each claimed form's projection after the claim commits. It is
// exported so tests can drive one deterministic pass.
func (s *Service) RunDue(ctx context.Context) error {
	// Forms left behind without an installation (a restore or manual edit;
	// Remove refuses while Forms exist) are not advanced.
	installed, err := s.host.Installation.Installed(ctx)
	if err != nil {
		return err
	}
	if !installed {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Hold the installation while claiming, so an uninstall racing the
	// tick cannot slip between the check above and the claim below.
	if err := s.host.Installation.LockInTx(ctx, tx); errors.Is(err, plugin.ErrNotInstalled) {
		return tx.Commit(ctx)
	} else if err != nil {
		return err
	}

	// Claim due forms with SKIP LOCKED so concurrent workers take disjoint sets.
	ids, err := s.host.DataSources.ClaimDueInTx(ctx, tx, 50)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return tx.Commit(ctx)
	}
	for _, id := range ids {
		if err := s.expireOverdueRecords(ctx, tx, id); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// Rebuild after the claim commits so the projection reflects the expirations and the refresh
	// state is rescheduled to the next boundary.
	for _, id := range ids {
		if err := s.RebuildProjection(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// expireOverdueRecords locks and expires records whose window has closed, capturing each record's
// actual previous state and writing a history event and an audit event in the same transaction.
func (s *Service) expireOverdueRecords(ctx context.Context, tx pgx.Tx, formID uuid.UUID) error {
	var expiredEligible bool
	err := tx.QueryRow(ctx, `SELECT eligible_for_output FROM form_workflow_states WHERE data_source_id=$1 AND state_key='expired'`, formID).Scan(&expiredEligible)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil // No expired state configured; nothing to do.
		}
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id,state_key FROM form_records
		WHERE data_source_id=$1 AND deleted_at IS NULL AND eligible AND expires_at IS NOT NULL AND expires_at<=now()
		FOR UPDATE`, formID)
	if err != nil {
		return err
	}
	type overdue struct {
		id   uuid.UUID
		from string
	}
	due := []overdue{}
	for rows.Next() {
		var o overdue
		if err := rows.Scan(&o.id, &o.from); err != nil {
			rows.Close()
			return err
		}
		due = append(due, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, o := range due {
		if _, err := tx.Exec(ctx, `UPDATE form_records SET state_key='expired',eligible=$2,version=version+1,updated_at=now() WHERE id=$1`, o.id, expiredEligible); err != nil {
			return err
		}
		// System-generated event: actor_id is NULL (no acting user), not the zero UUID.
		if _, err := tx.Exec(ctx, `INSERT INTO form_record_events(id,record_id,data_source_id,event_type,from_state,to_state,actor_id,actor_name,note)
			VALUES($1,$2,$3,'transition',$4,'expired',NULL,'system','Automatically expired')`, uuid.New(), o.id, formID, o.from); err != nil {
			return err
		}
		// System-generated audit: no acting user.
		if err := s.recordAudit(ctx, tx, uuid.Nil, "form.record_expired", formID.String(),
			map[string]any{"record": o.id.String(), "from": o.from}); err != nil {
			return err
		}
	}
	return nil
}
