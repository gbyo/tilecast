package server

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

// ApprovalFilter bounds and paginates the central approvals inbox.
type ApprovalFilter struct {
	Page     int
	PageSize int
}

// PendingApprovals returns a paginated page of records awaiting a review decision across every Form
// Data Source the user may review, approve, or manage. A record is pending when its current state
// has an outgoing transition that requires the review or approve capability. Results are paginated
// (with a total count) rather than silently capped, so no pending item is ever hidden by a limit.
func (s *Service) PendingApprovals(ctx context.Context, userID uuid.UUID, filter ApprovalFilter) (ApprovalPage, error) {
	if filter.Page < 1 {
		filter.Page = 1
	}
	if filter.PageSize < 1 {
		filter.PageSize = 25
	}
	if filter.PageSize > 100 {
		filter.PageSize = 100
	}
	role, err := s.userGlobalRole(ctx, userID)
	if err != nil {
		return ApprovalPage{}, err
	}
	isOwner := role == "owner"

	// The live form set comes from Host.DataSources: only rows of this
	// provider that are not soft-deleted can contribute inbox items. Names
	// and creators resolve from the same listing.
	forms, err := s.host.DataSources.ListLive(ctx, providerName)
	if err != nil {
		return ApprovalPage{}, err
	}
	ids := make([]uuid.UUID, 0, len(forms))
	names := make(map[uuid.UUID]string, len(forms))
	created := []uuid.UUID{}
	for _, form := range forms {
		ids = append(ids, form.ID)
		names[form.ID] = form.Name
		if form.CreatedBy != uuid.Nil && form.CreatedBy == userID {
			created = append(created, form.ID)
		}
	}

	// Shared FROM + authorization/pending predicate for both the count and the page query. The
	// LEFT JOIN to states supplies the human-readable state label and never changes the row count.
	const from = `FROM form_records r
		LEFT JOIN form_workflow_states st ON st.data_source_id=r.data_source_id AND st.state_key=r.state_key
		WHERE r.deleted_at IS NULL
		AND r.data_source_id = ANY($5)
		AND EXISTS(SELECT 1 FROM form_workflow_transitions t
			WHERE t.data_source_id=r.data_source_id AND t.from_state=r.state_key AND t.required_capability IN ('review','approve'))
		AND (
			$2
			OR r.data_source_id = ANY($6)
			OR EXISTS(SELECT 1 FROM form_grants g
				WHERE g.data_source_id=r.data_source_id AND g.user_id=$1 AND g.capability IN ('review','approve','manage'))
		)`

	// The count reuses the shared predicate with its own parameter numbering ($3/$4 for the
	// Host-derived ID lists) because the page query reserves $3/$4 for LIMIT/OFFSET.
	countFrom := strings.Replace(strings.Replace(from, "$5", "$3", 1), "$6", "$4", 1)
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) `+countFrom, userID, isOwner, ids, created).Scan(&total); err != nil {
		return ApprovalPage{}, err
	}

	// submittedAt reflects the transition INTO the current pending-review state (e.g. when the record
	// was submitted for review), not when the record was first created. Fall back to creation time if
	// no such transition event exists.
	const submittedAt = `COALESCE((SELECT max(e.created_at) FROM form_record_events e
			WHERE e.record_id=r.id AND e.event_type='transition' AND e.to_state=r.state_key), r.created_at)`
	rows, err := s.db.Query(ctx, `SELECT r.id,r.data_source_id,r.display_title,r.submitter_name,r.state_key,
			COALESCE(st.label,r.state_key),r.display_at,r.expires_at,`+submittedAt+`
		`+from+`
		ORDER BY `+submittedAt+` ASC
		LIMIT $3 OFFSET $4`, userID, isOwner, filter.PageSize, (filter.Page-1)*filter.PageSize, ids, created)
	if err != nil {
		return ApprovalPage{}, err
	}
	defer rows.Close()
	items := []ApprovalItem{}
	for rows.Next() {
		var item ApprovalItem
		if err := rows.Scan(&item.RecordID, &item.DataSourceID, &item.Title, &item.SubmitterName, &item.State, &item.StateLabel, &item.DisplayAt, &item.ExpiresAt, &item.SubmittedAt); err != nil {
			return ApprovalPage{}, err
		}
		item.FormName = names[item.DataSourceID]
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return ApprovalPage{}, err
	}
	return ApprovalPage{Items: items, Total: total, Page: filter.Page, PageSize: filter.PageSize}, nil
}
