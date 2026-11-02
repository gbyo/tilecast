package devices

import (
	"context"
	"fmt"

	"github.com/tilecast/tilecast/apps/server/internal/authz"
)

// ListScreensForAccess is ListScreens narrowed to one account's screen
// access. The predicate is authz's, the same one that authorizes each
// screen operation, so the list and what the account may act on agree.
func (s *Service) ListScreensForAccess(ctx context.Context, access authz.ScreenAccess) ([]Screen, error) {
	if access.All {
		return s.ListScreens(ctx)
	}
	rows, err := s.db.Query(ctx, screenSelect+`
		WHERE s.archived_at IS NULL
		  AND `+liveScreenSQL+`
		  AND `+access.ScreenSQL("s", "$1")+`
		ORDER BY s.name ASC LIMIT 500`, access.UserID)
	if err != nil {
		return nil, fmt.Errorf("list screens in scope: %w", err)
	}
	defer rows.Close()
	result := make([]Screen, 0)
	for rows.Next() {
		screen, err := scanScreen(rows, s.presence, s.now())
		if err != nil {
			return nil, err
		}
		result = append(result, screen)
	}
	return result, rows.Err()
}
