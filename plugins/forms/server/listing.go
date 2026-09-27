package server

import (
	"context"

	"github.com/google/uuid"
)

// ListAccessibleForms returns every Form Data Source the user may see, decorated with the user's
// effective capabilities and their own submission counts. A global Owner sees all forms; everyone
// else sees forms they created or hold any grant on. This backs the lightweight Forms portal and
// the operator navigation, so it deliberately avoids loading full form detail per row.
func (s *Service) ListAccessibleForms(ctx context.Context, userID uuid.UUID) ([]FormSummary, error) {
	role, err := s.userGlobalRole(ctx, userID)
	if err != nil {
		return nil, err
	}
	isOwner := role == "owner"
	// The candidate set comes from Host.DataSources; visibility scoping
	// (creator or grant holder, unless a global Owner) stays here with the
	// plugin's capability model.
	forms, err := s.host.DataSources.ListLive(ctx, providerName)
	if err != nil {
		return nil, err
	}
	summaries := make([]FormSummary, 0, len(forms))
	for _, form := range forms {
		var createdBy *uuid.UUID
		if form.CreatedBy != uuid.Nil {
			createdBy = &form.CreatedBy
		}
		if !isOwner {
			if createdBy == nil || *createdBy != userID {
				var hasGrant bool
				if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM form_grants WHERE data_source_id=$1 AND user_id=$2)`, form.ID, userID).Scan(&hasGrant); err != nil {
					return nil, err
				}
				if !hasGrant {
					continue
				}
			}
		}
		var published *int
		if err := s.db.QueryRow(ctx, `SELECT max(revision_number) FROM form_revisions WHERE data_source_id=$1`, form.ID).Scan(&published); err != nil {
			return nil, err
		}
		capabilities, err := s.grantedCapabilities(ctx, s.db, form.ID, createdBy, userID)
		if err != nil {
			return nil, err
		}
		counts, err := s.ownSubmissionCounts(ctx, form.ID, userID)
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, FormSummary{
			ID:                      form.ID,
			Name:                    form.Name,
			Description:             form.Description,
			PublishedRevisionNumber: published,
			Capabilities:            capabilities,
			Counts:                  counts,
		})
	}
	return summaries, nil
}

// ownSubmissionCounts buckets a user's own submissions on one form by the workflow-derived meaning
// of each state: the initial state is a draft; any other state that a submitter can still edit
// (an outgoing submit transition) is "changes requested"; everything else is "submitted".
func (s *Service) ownSubmissionCounts(ctx context.Context, formID, userID uuid.UUID) (SubmissionCounts, error) {
	var counts SubmissionCounts
	err := s.db.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE category='draft'),
			count(*) FILTER (WHERE category='changes_requested'),
			count(*) FILTER (WHERE category='submitted'),
			count(*)
		FROM (
			SELECT CASE
				WHEN COALESCE(st.is_initial,FALSE) THEN 'draft'
				WHEN EXISTS(SELECT 1 FROM form_workflow_transitions t
					WHERE t.data_source_id=r.data_source_id AND t.from_state=r.state_key AND t.required_capability='submit') THEN 'changes_requested'
				ELSE 'submitted'
			END AS category
			FROM form_records r
			LEFT JOIN form_workflow_states st ON st.data_source_id=r.data_source_id AND st.state_key=r.state_key
			WHERE r.data_source_id=$1 AND r.submitted_by=$2 AND r.deleted_at IS NULL
		) categorized`, formID, userID).Scan(&counts.Draft, &counts.ChangesRequested, &counts.Submitted, &counts.Total)
	if err != nil {
		return SubmissionCounts{}, err
	}
	return counts, nil
}
