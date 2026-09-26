package server

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The workflow is a pure state+transition model: no scripts, expressions, SQL, or shell. The
// default matches the product brief; managers may rename labels and configure a bounded set of
// states and transitions.

const (
	maxWorkflowStates      = 16
	maxWorkflowTransitions = 48
)

var stateKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// defaultWorkflow is seeded when a form is created.
func defaultWorkflow() Workflow {
	return Workflow{
		States: []WorkflowState{
			{Key: "draft", Label: "Draft", Position: 0, Initial: true},
			{Key: "submitted", Label: "Submitted", Position: 1},
			{Key: "changes_requested", Label: "Changes requested", Position: 2},
			{Key: "approved", Label: "Approved", Position: 3, EligibleForOutput: true},
			{Key: "rejected", Label: "Rejected", Position: 4, Terminal: true},
			{Key: "expired", Label: "Expired", Position: 5, Terminal: true},
		},
		Transitions: []WorkflowTransition{
			{From: "draft", To: "submitted", Label: "Submit", RequiredCapability: CapSubmit, Position: 0},
			{From: "submitted", To: "approved", Label: "Approve", RequiredCapability: CapApprove, Position: 1},
			{From: "submitted", To: "rejected", Label: "Reject", RequiredCapability: CapApprove, Position: 2},
			{From: "submitted", To: "changes_requested", Label: "Request changes", RequiredCapability: CapReview, Position: 3},
			{From: "changes_requested", To: "submitted", Label: "Resubmit", RequiredCapability: CapSubmit, Position: 4},
			{From: "approved", To: "expired", Label: "Expire", RequiredCapability: CapManage, Position: 5},
		},
	}
}

// seedWorkflow writes the default workflow for a newly created form inside tx.
func seedWorkflow(ctx context.Context, tx pgx.Tx, formID uuid.UUID) error {
	return writeWorkflow(ctx, tx, formID, defaultWorkflow())
}

// writeWorkflow replaces the stored states and transitions with the given workflow. Callers
// must validate first.
func writeWorkflow(ctx context.Context, tx pgx.Tx, formID uuid.UUID, wf Workflow) error {
	if _, err := tx.Exec(ctx, `DELETE FROM form_workflow_transitions WHERE data_source_id=$1`, formID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM form_workflow_states WHERE data_source_id=$1`, formID); err != nil {
		return err
	}
	for _, state := range wf.States {
		if _, err := tx.Exec(ctx, `INSERT INTO form_workflow_states
			(id,data_source_id,state_key,label,position,eligible_for_output,is_initial,is_terminal)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			uuid.New(), formID, state.Key, state.Label, state.Position, state.EligibleForOutput, state.Initial, state.Terminal); err != nil {
			return err
		}
	}
	for _, transition := range wf.Transitions {
		if _, err := tx.Exec(ctx, `INSERT INTO form_workflow_transitions
			(id,data_source_id,from_state,to_state,label,required_capability,position)
			VALUES($1,$2,$3,$4,$5,$6,$7)`,
			uuid.New(), formID, transition.From, transition.To, transition.Label, string(transition.RequiredCapability), transition.Position); err != nil {
			return err
		}
	}
	return nil
}

// loadWorkflow reads the configured workflow for a form.
func loadWorkflow(ctx context.Context, q rowQuerier, formID uuid.UUID) (Workflow, error) {
	wf := Workflow{States: []WorkflowState{}, Transitions: []WorkflowTransition{}}
	stateRows, err := q.Query(ctx, `SELECT state_key,label,position,eligible_for_output,is_initial,is_terminal
		FROM form_workflow_states WHERE data_source_id=$1 ORDER BY position,state_key`, formID)
	if err != nil {
		return Workflow{}, err
	}
	for stateRows.Next() {
		var state WorkflowState
		if err := stateRows.Scan(&state.Key, &state.Label, &state.Position, &state.EligibleForOutput, &state.Initial, &state.Terminal); err != nil {
			stateRows.Close()
			return Workflow{}, err
		}
		wf.States = append(wf.States, state)
	}
	stateRows.Close()
	if err := stateRows.Err(); err != nil {
		return Workflow{}, err
	}
	transitionRows, err := q.Query(ctx, `SELECT from_state,to_state,label,required_capability,position
		FROM form_workflow_transitions WHERE data_source_id=$1 ORDER BY position,from_state,to_state`, formID)
	if err != nil {
		return Workflow{}, err
	}
	defer transitionRows.Close()
	for transitionRows.Next() {
		var transition WorkflowTransition
		var capability string
		if err := transitionRows.Scan(&transition.From, &transition.To, &transition.Label, &capability, &transition.Position); err != nil {
			return Workflow{}, err
		}
		transition.RequiredCapability = Capability(capability)
		wf.Transitions = append(wf.Transitions, transition)
	}
	return wf, transitionRows.Err()
}

// transitionRequiresNote reports whether a transition must carry a reviewer note. It is the single
// source of truth shared by availableTransitions (decorateDetail) and the Transition enforcement:
// a reviewer-driven (review/approve) transition that sends a record back into a still-editable,
// non-initial state — the default "request changes" path — requires a note. Derived from the
// configured workflow rather than any hardcoded state key.
func transitionRequiresNote(wf Workflow, transition WorkflowTransition) bool {
	if transition.RequiredCapability != CapReview && transition.RequiredCapability != CapApprove {
		return false
	}
	editable := false
	for _, candidate := range wf.Transitions {
		if candidate.From == transition.To && candidate.RequiredCapability == CapSubmit {
			editable = true
			break
		}
	}
	if !editable {
		return false
	}
	for _, state := range wf.States {
		if state.Key == transition.To {
			return !state.Initial
		}
	}
	return true
}

// decorateWorkflowUsage fills each state's RecordCount from live record usage and Removable from
// every persisted reference. A state referenced by a non-deleted record or saved view cannot be
// renamed or removed (its key is immutable), matching the ConfigureWorkflow reconciliation rules;
// the UI uses this to lock those controls.
func (s *Service) decorateWorkflowUsage(ctx context.Context, q rowQuerier, id uuid.UUID, wf *Workflow) error {
	rows, err := q.Query(ctx, `SELECT state_key,count(*) FROM form_records
		WHERE data_source_id=$1 AND deleted_at IS NULL GROUP BY state_key`, id)
	if err != nil {
		return err
	}
	counts := map[string]int{}
	for rows.Next() {
		var key string
		var count int
		if err := rows.Scan(&key, &count); err != nil {
			rows.Close()
			return err
		}
		counts[key] = count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	viewRows, err := q.Query(ctx, `SELECT DISTINCT state_key FROM form_views
		CROSS JOIN LATERAL unnest(included_states) AS state_key
		WHERE data_source_id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	viewStates := map[string]bool{}
	for viewRows.Next() {
		var key string
		if err := viewRows.Scan(&key); err != nil {
			viewRows.Close()
			return err
		}
		viewStates[key] = true
	}
	viewRows.Close()
	if err := viewRows.Err(); err != nil {
		return err
	}
	for i := range wf.States {
		count := counts[wf.States[i].Key]
		wf.States[i].RecordCount = count
		wf.States[i].Removable = count == 0 && !viewStates[wf.States[i].Key]
	}
	return nil
}

// validateWorkflow enforces the bounded, script-free workflow rules.
func validateWorkflow(wf Workflow) error {
	if len(wf.States) == 0 || len(wf.States) > maxWorkflowStates {
		return fmt.Errorf("%w: a workflow needs between 1 and %d states", ErrValidation, maxWorkflowStates)
	}
	if len(wf.Transitions) > maxWorkflowTransitions {
		return fmt.Errorf("%w: a workflow allows at most %d transitions", ErrValidation, maxWorkflowTransitions)
	}
	states := map[string]WorkflowState{}
	initialCount := 0
	eligibleCount := 0
	for _, state := range wf.States {
		if !stateKeyPattern.MatchString(state.Key) {
			return fmt.Errorf("%w: state key %q is invalid", ErrValidation, state.Key)
		}
		if _, exists := states[state.Key]; exists {
			return fmt.Errorf("%w: duplicate state key %q", ErrValidation, state.Key)
		}
		if strings.TrimSpace(state.Label) == "" {
			return fmt.Errorf("%w: state %q needs a label", ErrValidation, state.Key)
		}
		states[state.Key] = state
		if state.Initial {
			initialCount++
		}
		if state.EligibleForOutput {
			eligibleCount++
		}
	}
	if initialCount != 1 {
		return fmt.Errorf("%w: exactly one state must be the initial state", ErrValidation)
	}
	if eligibleCount == 0 {
		return fmt.Errorf("%w: at least one state must be eligible for signage output", ErrValidation)
	}
	seenTransitions := map[string]bool{}
	for _, transition := range wf.Transitions {
		if _, ok := states[transition.From]; !ok {
			return fmt.Errorf("%w: transition references unknown state %q", ErrValidation, transition.From)
		}
		if _, ok := states[transition.To]; !ok {
			return fmt.Errorf("%w: transition references unknown state %q", ErrValidation, transition.To)
		}
		if !validCapabilities[transition.RequiredCapability] {
			return fmt.Errorf("%w: transition uses an invalid capability", ErrValidation)
		}
		key := transition.From + "\x00" + transition.To
		if seenTransitions[key] {
			return fmt.Errorf("%w: duplicate transition %s -> %s", ErrValidation, transition.From, transition.To)
		}
		seenTransitions[key] = true
	}
	return nil
}

// WorkflowInput configures a form's workflow.
type WorkflowInput struct {
	Workflow Workflow
}

// ConfigureWorkflow reconciles a form's workflow in place rather than dropping and recreating it,
// so states referenced by existing records or saved views are never orphaned. Referenced state keys
// are immutable: their labels, order, terminal flag, and output eligibility may change, but the
// states cannot be removed or renamed. The initial state cannot move while records still sit in the
// current initial state. Transitions are replaced wholesale. Eligibility changes are re-derived
// immediately and the projection is rebuilt.
func (s *Service) ConfigureWorkflow(ctx context.Context, id, actor uuid.UUID, in WorkflowInput) error {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return err
	}
	if err := validateWorkflow(in.Workflow); err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	current, err := loadWorkflow(ctx, tx, id)
	if err != nil {
		return err
	}
	currentByKey := map[string]WorkflowState{}
	var currentInitial string
	for _, state := range current.States {
		currentByKey[state.Key] = state
		if state.Initial {
			currentInitial = state.Key
		}
	}
	newByKey := map[string]WorkflowState{}
	var newInitial string
	for _, state := range in.Workflow.States {
		newByKey[state.Key] = state
		if state.Initial {
			newInitial = state.Key
		}
	}

	// State keys referenced by any non-deleted record are immutable: they must still exist.
	usedRows, err := tx.Query(ctx, `SELECT DISTINCT state_key FROM form_records WHERE data_source_id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	usedStates := map[string]bool{}
	for usedRows.Next() {
		var key string
		if err := usedRows.Scan(&key); err != nil {
			usedRows.Close()
			return err
		}
		usedStates[key] = true
	}
	usedRows.Close()
	if err := usedRows.Err(); err != nil {
		return err
	}
	viewRows, err := tx.Query(ctx, `SELECT DISTINCT state_key FROM form_views
		CROSS JOIN LATERAL unnest(included_states) AS state_key
		WHERE data_source_id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	viewStates := map[string]bool{}
	for viewRows.Next() {
		var key string
		if err := viewRows.Scan(&key); err != nil {
			viewRows.Close()
			return err
		}
		viewStates[key] = true
	}
	viewRows.Close()
	if err := viewRows.Err(); err != nil {
		return err
	}
	for key := range usedStates {
		if _, ok := newByKey[key]; !ok {
			return fmt.Errorf("%w: state %q is referenced by existing records and cannot be removed or renamed", ErrValidation, key)
		}
	}
	for key := range viewStates {
		if _, ok := newByKey[key]; !ok {
			return fmt.Errorf("%w: state %q is referenced by a saved view and cannot be removed or renamed", ErrValidation, key)
		}
	}
	// Changing which state is initial while records still occupy the current initial state would
	// strand those records under a new intake path; require they be cleared first.
	if currentInitial != "" && newInitial != currentInitial && usedStates[currentInitial] {
		return fmt.Errorf("%w: cannot change the initial state while records remain in %q", ErrValidation, currentInitial)
	}

	// Reconcile states: update existing, insert new, delete only unused removed states.
	for _, state := range in.Workflow.States {
		if _, ok := currentByKey[state.Key]; ok {
			if _, err := tx.Exec(ctx, `UPDATE form_workflow_states
				SET label=$3,position=$4,eligible_for_output=$5,is_initial=$6,is_terminal=$7,updated_at=now()
				WHERE data_source_id=$1 AND state_key=$2`,
				id, state.Key, state.Label, state.Position, state.EligibleForOutput, state.Initial, state.Terminal); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO form_workflow_states
			(id,data_source_id,state_key,label,position,eligible_for_output,is_initial,is_terminal)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			uuid.New(), id, state.Key, state.Label, state.Position, state.EligibleForOutput, state.Initial, state.Terminal); err != nil {
			return err
		}
	}
	for _, state := range current.States {
		if _, ok := newByKey[state.Key]; !ok {
			// Guaranteed unused by the check above.
			if _, err := tx.Exec(ctx, `DELETE FROM form_workflow_states WHERE data_source_id=$1 AND state_key=$2`, id, state.Key); err != nil {
				return err
			}
		}
	}

	// Transitions carry no record references, so replacing them wholesale is safe.
	if _, err := tx.Exec(ctx, `DELETE FROM form_workflow_transitions WHERE data_source_id=$1`, id); err != nil {
		return err
	}
	for _, transition := range in.Workflow.Transitions {
		if _, err := tx.Exec(ctx, `INSERT INTO form_workflow_transitions
			(id,data_source_id,from_state,to_state,label,required_capability,position)
			VALUES($1,$2,$3,$4,$5,$6,$7)`,
			uuid.New(), id, transition.From, transition.To, transition.Label, string(transition.RequiredCapability), transition.Position); err != nil {
			return err
		}
	}

	// Re-derive eligibility for existing records: clear all, then set records whose current state
	// is now output-eligible.
	if _, err := tx.Exec(ctx, `UPDATE form_records SET eligible=FALSE,updated_at=now()
		WHERE data_source_id=$1 AND deleted_at IS NULL AND eligible`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE form_records r SET eligible=TRUE,updated_at=now()
		FROM form_workflow_states st
		WHERE r.data_source_id=$1 AND r.deleted_at IS NULL
		AND st.data_source_id=$1 AND st.state_key=r.state_key AND st.eligible_for_output`, id); err != nil {
		return err
	}
	if err := s.recordAudit(ctx, tx, actor, "form.workflow_configured", id.String(), nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.RebuildProjection(ctx, id)
}
