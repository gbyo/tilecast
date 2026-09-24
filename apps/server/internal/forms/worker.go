package forms

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ProjectionWorker wakes forms at their next time-window boundary to re-project time-based views
// and auto-expire records that have passed their expiry. Forms are otherwise projected eagerly on
// mutation; this worker only handles the passage of time, so it polls infrequently.
type ProjectionWorker struct {
	service *Service
	logger  *slog.Logger
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	gate    func() bool
}

func NewProjectionWorker(service *Service, logger *slog.Logger) *ProjectionWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &ProjectionWorker{service: service, logger: logger}
}

// SetGate installs a check consulted before doing work; backup and restore pause the worker.
func (w *ProjectionWorker) SetGate(gate func() bool) { w.gate = gate }

func (w *ProjectionWorker) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	w.cancel = cancel
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if w.gate != nil && !w.gate() {
				continue
			}
			if err := w.RunDue(ctx); err != nil && ctx.Err() == nil {
				w.logger.Error("form projection tick failed", "error", err)
			}
		}
	}()
}

func (w *ProjectionWorker) Stop() {
	if w.cancel != nil {
		w.cancel()
	}
	w.wg.Wait()
}

// RunDue claims every form whose scheduled boundary has arrived, expires overdue records inside a
// single transaction (so multiple Tilecast processes never expire or project the same form
// concurrently), then rebuilds each claimed form's projection after the claim commits. It is
// exported so tests can drive one deterministic pass.
func (w *ProjectionWorker) RunDue(ctx context.Context) error {
	tx, err := w.service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Claim due forms with SKIP LOCKED so concurrent workers take disjoint sets.
	rows, err := tx.Query(ctx, `SELECT rs.data_source_id
		FROM data_source_refresh_states rs
		JOIN data_sources ds ON ds.id=rs.data_source_id AND ds.deleted_at IS NULL AND ds.provider='form'
		WHERE rs.next_refresh_at<=now()
			-- Forms left behind without an installation (a restore or manual
			-- edit; Remove refuses while Forms exist) are not advanced.
			AND EXISTS(SELECT 1 FROM plugin_installations WHERE plugin_id='forms')
		FOR UPDATE OF rs SKIP LOCKED
		LIMIT 50`)
	if err != nil {
		return err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(ids) == 0 {
		return tx.Commit(ctx)
	}
	for _, id := range ids {
		if err := expireOverdueRecords(ctx, tx, id); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// Rebuild after the claim commits so the projection reflects the expirations and the refresh
	// state is rescheduled to the next boundary.
	for _, id := range ids {
		if err := w.service.RebuildProjection(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// expireOverdueRecords locks and expires records whose window has closed, capturing each record's
// actual previous state and writing a history event and an audit event in the same transaction.
func expireOverdueRecords(ctx context.Context, tx pgx.Tx, formID uuid.UUID) error {
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
		if _, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
			VALUES($1,NULL,'form.record_expired','data_source',$2,jsonb_build_object('record',$3::text,'from',$4::text))`,
			uuid.New(), formID.String(), o.id.String(), o.from); err != nil {
			return err
		}
	}
	return nil
}
