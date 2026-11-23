package scheduling

import (
	"context"
	"strconv"
	"strings"

	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/keyset"
)

// Keyset reads for callers that need stable continuation rather than page
// numbers: oldest first by creation, the id as the final tie-breaker. A nil
// access reads the whole installation; otherwise the rows are narrowed with
// the same authz predicates the Studio decisions use.

// ListAfter returns at most limit schedules after the position, without
// their targets.
func (s *Service) ListAfter(ctx context.Context, filter ListFilter, access *authz.ScreenAccess, after *keyset.After, limit int) ([]Record, error) {
	if err := filter.Validate(); err != nil {
		return nil, err
	}
	args := filter.args()
	where := listWhere
	if access != nil && !access.All {
		args = append(args, access.UserID)
		where += ` AND ` + access.ScheduleSQL("s", "$"+strconv.Itoa(len(args)))
	}
	where += ` AND ` + keyset.Ascending(after, "s.created_at", "s.id", &args)
	args = append(args, limit)
	rows, err := s.db.Query(ctx, recordSelect+where+` ORDER BY s.created_at,s.id LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Record{}
	for rows.Next() {
		record, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, record)
	}
	return items, rows.Err()
}

// ListGroupsAfter returns at most limit Display Groups after the position,
// without their members.
func (s *Service) ListGroupsAfter(ctx context.Context, search string, access *authz.ScreenAccess, after *keyset.After, limit int) ([]Group, error) {
	args := []any{strings.TrimSpace(search)}
	where := ` WHERE g.deleted_at IS NULL AND ($1='' OR g.name ILIKE '%'||$1||'%')`
	if access != nil && !access.All {
		args = append(args, access.UserID)
		where += ` AND ` + access.GroupSQL("g", "$"+strconv.Itoa(len(args)))
	}
	where += ` AND ` + keyset.Ascending(after, "g.created_at", "g.id", &args)
	args = append(args, limit)
	rows, err := s.db.Query(ctx, groupSummarySelect+where+` `+groupSummaryGroupBy+` ORDER BY g.created_at,g.id LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanGroupSummaries(rows)
}
