package fleetops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
)

// Operation is the record of an applied bulk change.
type Operation struct {
	ID           uuid.UUID      `json:"id"`
	Action       string         `json:"action"`
	ScreenCount  int            `json:"screenCount"`
	AppliedCount int            `json:"appliedCount"`
	SkippedCount int            `json:"skippedCount"`
	FailedCount  int            `json:"failedCount"`
	Results      []ScreenChange `json:"results"`
	Reversible   bool           `json:"reversible"`
	UndoExpires  *time.Time     `json:"undoExpiresAt,omitempty"`
	UndoneAt     *time.Time     `json:"undoneAt,omitempty"`
	CreatedAt    time.Time      `json:"createdAt"`
}

// undoEntry is the previous state of one screen.
type undoEntry struct {
	ScreenID   uuid.UUID  `json:"screenId"`
	PlaylistID *uuid.UUID `json:"playlistId,omitempty"`
	LayoutID   *uuid.UUID `json:"layoutId,omitempty"`
	Enabled    *bool      `json:"enabled,omitempty"`
}

// Apply performs the operation.
//
// expectedChangeCount is the number the operator confirmed. When the fleet has
// moved since the preview -- somebody else reassigned a screen, a group gained
// a member -- the apply is refused rather than run against a picture the
// operator never saw.
func (s *Service) Apply(ctx context.Context, user uuid.UUID, request Request, expectedChangeCount int) (Operation, error) {
	preview, err := s.Build(ctx, request)
	if err != nil {
		return Operation{}, err
	}
	if expectedChangeCount >= 0 && preview.ChangeCount != expectedChangeCount {
		return Operation{}, fmt.Errorf("%w: the preview showed %d screens changing, now it is %d. Review the change again.",
			ErrStale, expectedChangeCount, preview.ChangeCount)
	}
	if preview.ChangeCount == 0 {
		return Operation{}, validationError("nothing would change")
	}

	// Previous state is captured before anything is written. Assigning one
	// member of a sync group rewrites the group row, so the entry for each
	// affected screen has to be read first or the later ones would record the
	// state the earlier writes produced.
	undo, err := s.captureUndo(ctx, preview, request)
	if err != nil {
		// Undo state that cannot be read is not a change worth making: the
		// operation would be unreversible in a way nobody was told about.
		return Operation{}, err
	}

	results := make([]ScreenChange, 0, len(preview.Screens))
	applied, skipped, failed := 0, 0, 0
	for _, change := range preview.Screens {
		if change.Blocked != "" || !change.Changes {
			skipped++
			results = append(results, change)
			continue
		}
		if err := s.applyOne(ctx, user, request, change.ScreenID); err != nil {
			failed++
			change.Error = err.Error()
			results = append(results, change)
			continue
		}
		applied++
		change.Applied = true
		results = append(results, change)
	}

	operation := Operation{
		ID: uuid.New(), Action: request.Action, ScreenCount: len(preview.Screens),
		AppliedCount: applied, SkippedCount: skipped, FailedCount: failed,
		Results: results, Reversible: request.Reversible() && applied > 0,
		CreatedAt: time.Now().UTC(),
	}
	if operation.Reversible {
		expires := time.Now().Add(UndoWindow)
		operation.UndoExpires = &expires
	}
	if err := s.record(ctx, user, request, operation, undo); err != nil {
		// The screens have already changed. Reporting a 500 and dropping the
		// result would leave the operator with no account of what happened and
		// no undo, which is worse than an operation that cannot be reversed.
		s.logger.Error("recording the bulk operation failed", "error", err, "operation", operation.ID)
		operation.Reversible = false
		operation.UndoExpires = nil
	}
	return operation, nil
}

// applyOne routes one screen through the existing single-screen path. Nothing
// here writes an assignment directly: the manifest bump, group fan-out, player
// compatibility check, and audit entry belong to those services.
func (s *Service) applyOne(ctx context.Context, user uuid.UUID, request Request, screenID uuid.UUID) error {
	switch request.Action {
	case ActionAssignPlaylist:
		_, err := s.assigner.AssignPresentation(ctx, screenID, request.PlaylistID, nil, user)
		return err
	case ActionAssignLayout:
		_, err := s.assigner.AssignPresentation(ctx, screenID, nil, request.LayoutID, user)
		return err
	case ActionClearAssignment:
		_, err := s.assigner.Unassign(ctx, screenID, user)
		return err
	case ActionSetEnabled:
		return s.enabler.SetEnabled(ctx, screenID, user, *request.Enabled)
	case ActionSendCommand:
		if s.commands == nil {
			return errors.New("bulk commands are unavailable on this server")
		}
		return s.commands.EnqueueCommand(ctx, screenID, user, request.CommandType, request.CommandPayload)
	}
	return validationError("unknown action %q", request.Action)
}

func (s *Service) captureUndo(ctx context.Context, preview Preview, request Request) ([]undoEntry, error) {
	if !request.Reversible() {
		return nil, nil
	}
	entries := make([]undoEntry, 0, len(preview.Screens))
	for _, change := range preview.Screens {
		if change.Blocked != "" || !change.Changes {
			continue
		}
		entry := undoEntry{ScreenID: change.ScreenID}
		if request.Action == ActionSetEnabled {
			var enabled bool
			if err := s.db.QueryRow(ctx, `SELECT enabled FROM screens WHERE id=$1`, change.ScreenID).Scan(&enabled); err != nil {
				return nil, fmt.Errorf("read previous state for %s: %w", change.ScreenID, err)
			}
			entry.Enabled = &enabled
		} else {
			var playlistID, layoutID *uuid.UUID
			// Read through the group, because that is where a grouped screen's
			// assignment actually lives.
			if err := s.db.QueryRow(ctx, `
				SELECT COALESCE(sa.playlist_id, ga.playlist_id), COALESCE(sa.layout_id, ga.layout_id)
				FROM screens sc
				LEFT JOIN screen_group_memberships m ON m.screen_id=sc.id
				LEFT JOIN screen_playlist_assignments sa ON sa.screen_id=sc.id
				LEFT JOIN screen_group_playlist_assignments ga ON ga.screen_group_id=m.screen_group_id
				WHERE sc.id=$1
				LIMIT 1`, change.ScreenID).Scan(&playlistID, &layoutID); err != nil {
				return nil, fmt.Errorf("read previous state for %s: %w", change.ScreenID, err)
			}
			entry.PlaylistID, entry.LayoutID = playlistID, layoutID
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func (s *Service) record(ctx context.Context, user uuid.UUID, request Request, operation Operation, undo []undoEntry) error {
	var org uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		return err
	}
	parameters, _ := json.Marshal(map[string]any{
		"playlistId":  request.PlaylistID,
		"layoutId":    request.LayoutID,
		"enabled":     request.Enabled,
		"commandType": request.CommandType,
	})
	if operation.Results == nil {
		operation.Results = []ScreenChange{}
	}
	if undo == nil {
		// json.Marshal of a nil slice is "null", not "[]", and this column is
		// declared as an array. Keep the stored shape honest.
		undo = []undoEntry{}
	}
	results, _ := json.Marshal(operation.Results)
	undoState, _ := json.Marshal(undo)

	if _, err := s.db.Exec(ctx, `
		INSERT INTO bulk_operations(
			id,organization_id,action,parameters,requested_by,
			screen_count,applied_count,skipped_count,failed_count,
			results,undo_state,reversible,undo_expires_at)
		VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)`,
		operation.ID, org, request.Action, string(parameters), user,
		operation.ScreenCount, operation.AppliedCount, operation.SkippedCount, operation.FailedCount,
		string(results), string(undoState), operation.Reversible, operation.UndoExpires); err != nil {
		return err
	}
	// One audit entry for the operation. The per-screen entries come from the
	// services that did the work, so the trail shows both the intent and every
	// individual change.
	_, _ = s.db.Exec(ctx, `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,summary,metadata)
		VALUES($1,$2,'fleet.bulk_operation','bulk_operation',$3,$4,$5,$6::jsonb)`,
		uuid.New(), user, operation.ID.String(),
		auditResult(operation), fmt.Sprintf("%s applied to %d screens", request.Action, operation.AppliedCount),
		string(parameters))
	return nil
}

func auditResult(operation Operation) string {
	if operation.FailedCount > 0 {
		return "partial"
	}
	return "success"
}

// Undo puts back what a reversible operation replaced.
//
// It re-applies the previous assignment through the same single-screen path, so
// undo is an ordinary change with its own audit trail rather than a hidden
// rewrite of history.
func (s *Service) Undo(ctx context.Context, actor authz.Actor, id uuid.UUID) (Operation, error) {
	user := actor.UserID
	var action string
	var reversible bool
	var undoneAt, expires *time.Time
	var undoRaw []byte
	err := s.db.QueryRow(ctx, `
		SELECT action,reversible,undone_at,undo_expires_at,undo_state
		FROM bulk_operations WHERE id=$1`, id).Scan(&action, &reversible, &undoneAt, &expires, &undoRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, ErrNotFound
	}
	if err != nil {
		return Operation{}, err
	}
	if !reversible {
		return Operation{}, ErrNotReversible
	}
	if undoneAt != nil {
		return Operation{}, fmt.Errorf("%w: this operation was already undone", ErrValidation)
	}
	if expires == nil || time.Now().After(*expires) {
		return Operation{}, fmt.Errorf("%w: the undo window has closed. Change the screens again instead.", ErrValidation)
	}
	var entries []undoEntry
	if err := json.Unmarshal(undoRaw, &entries); err != nil {
		return Operation{}, err
	}
	// Access is enforced against the caller, not against the stored
	// operation, and before the claim: a refused undo must leave the
	// operation exactly as it was. Without this an operation id would be a
	// way to rewrite screens the caller can no longer reach, or never could.
	if s.scopes == nil {
		return Operation{}, errors.New("fleet operations need a screen access authorizer")
	}
	screens := make([]uuid.UUID, 0, len(entries))
	for _, entry := range entries {
		screens = append(screens, entry.ScreenID)
	}
	if err := s.scopes.Screens(ctx, actor, auth.CapScreenManage, screens); err != nil {
		return Operation{}, err
	}
	// Claim it before restoring anything. The read above and the write at the
	// end left a window in which two concurrent undos both passed the check and
	// both re-applied the previous assignments.
	claim, err := s.db.Exec(ctx, `
		UPDATE bulk_operations SET undone_at=now(),undone_by=$2
		WHERE id=$1 AND undone_at IS NULL`, id, user)
	if err != nil {
		return Operation{}, err
	}
	if claim.RowsAffected() == 0 {
		return Operation{}, fmt.Errorf("%w: this operation was already undone", ErrValidation)
	}

	restored, failed := 0, 0
	results := make([]ScreenChange, 0, len(entries))
	var remaining []undoEntry
	for _, entry := range entries {
		change := ScreenChange{ScreenID: entry.ScreenID, Selected: true}
		var restoreErr error
		switch {
		case entry.Enabled != nil:
			restoreErr = s.enabler.SetEnabled(ctx, entry.ScreenID, user, *entry.Enabled)
		case entry.PlaylistID != nil || entry.LayoutID != nil:
			_, restoreErr = s.assigner.AssignPresentation(ctx, entry.ScreenID, entry.PlaylistID, entry.LayoutID, user)
		default:
			_, restoreErr = s.assigner.Unassign(ctx, entry.ScreenID, user)
		}
		if restoreErr != nil {
			failed++
			change.Error = restoreErr.Error()
			remaining = append(remaining, entry)
		} else {
			restored++
			change.Applied = true
		}
		results = append(results, change)
	}

	_, _ = s.db.Exec(ctx, `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,summary)
		VALUES($1,$2,'fleet.bulk_operation_undone','bulk_operation',$3,$4,$5)`,
		uuid.New(), user, id.String(), auditResult(Operation{FailedCount: failed}),
		fmt.Sprintf("restored %d screens", restored))

	now := time.Now().UTC()
	undone := &now
	// A partial undo stays open for the screens that failed: keep only their
	// entries and release the claim, so a retry inside the window restores
	// those screens and never re-applies the ones already restored.
	if len(remaining) > 0 {
		encoded, err := json.Marshal(remaining)
		if err != nil {
			return Operation{}, err
		}
		if _, err := s.db.Exec(ctx, `
			UPDATE bulk_operations SET undone_at=NULL,undone_by=NULL,undo_state=$2
			WHERE id=$1`, id, encoded); err != nil {
			return Operation{}, err
		}
		undone = nil
	}
	return Operation{
		ID: id, Action: action, ScreenCount: len(entries), AppliedCount: restored,
		FailedCount: failed, Results: results, UndoneAt: undone, CreatedAt: now,
	}, nil
}

// Recent lists recent operations, so an operator can see what was done and
// undo the last one.
//
// The per-screen results carry screen names, locations, and assignments, so a
// scoped caller is given only the operations it could have run itself. An
// operation that touched anything outside the scope is withheld whole rather
// than shown with rows removed: a partial account of somebody else's change is
// more misleading than no entry at all.
func (s *Service) Recent(ctx context.Context, actor authz.Actor, limit int) ([]Operation, error) {
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	rows, err := s.db.Query(ctx, `
		SELECT id,action,screen_count,applied_count,skipped_count,failed_count,
		       results,reversible,undo_expires_at,undone_at,created_at
		FROM bulk_operations ORDER BY created_at DESC, id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Operation{}
	for rows.Next() {
		var operation Operation
		var raw []byte
		if err := rows.Scan(&operation.ID, &operation.Action, &operation.ScreenCount,
			&operation.AppliedCount, &operation.SkippedCount, &operation.FailedCount,
			&raw, &operation.Reversible, &operation.UndoExpires, &operation.UndoneAt,
			&operation.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &operation.Results)
		if s.scopes == nil {
			return nil, errors.New("fleet operations need a screen access authorizer")
		}
		screens := make([]uuid.UUID, 0, len(operation.Results))
		for _, result := range operation.Results {
			screens = append(screens, result.ScreenID)
		}
		if err := s.scopes.Screens(ctx, actor, auth.CapScreenManage, screens); err != nil {
			if errors.Is(err, authz.ErrOutOfScope) {
				continue
			}
			return nil, err
		}
		// A window that has already closed is reported as closed rather than
		// offering a control that will be refused.
		if operation.UndoneAt != nil || operation.UndoExpires == nil || time.Now().After(*operation.UndoExpires) {
			operation.Reversible = false
		}
		out = append(out, operation)
	}
	return out, rows.Err()
}
