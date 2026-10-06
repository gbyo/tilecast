package devices

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// Screen scopes narrow which screens an account may operate on.
//
// The rules, in one place because every caller depends on all of them:
//
//   - No scope rows means the whole fleet. That is what every account has after
//     the feature ships, so an upgrade changes nobody's access.
//   - The Owner is never scoped. An installation must not be able to lock itself
//     out of its own fleet.
//   - Scopes apply to operations on screens, not to the content library. A
//     shared playlist is the point of a shared library.
//   - A scope is a location or a sync group. A screen is in scope when its
//     location matches, or when it belongs to a scoped group.

// ErrOutOfScope means the account may not operate on that screen.
var ErrOutOfScope = errors.New("screen is outside your assigned scope")

// Scope is one grant.
type Scope struct {
	Type string    `json:"type"`
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name,omitempty"`
}

// ScopesFor lists an account's grants, resolved to names for display.
func (s *Service) ScopesFor(ctx context.Context, user uuid.UUID) ([]Scope, error) {
	rows, err := s.db.Query(ctx, `
		SELECT sc.scope_type, sc.scope_id,
		       COALESCE(l.name, g.name, '')
		FROM user_screen_scopes sc
		LEFT JOIN locations l ON sc.scope_type='location' AND l.id=sc.scope_id
		LEFT JOIN screen_groups g ON sc.scope_type='group' AND g.id=sc.scope_id
		WHERE sc.user_id=$1
		ORDER BY sc.scope_type, COALESCE(l.name, g.name, '')`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Scope{}
	for rows.Next() {
		var scope Scope
		if err := rows.Scan(&scope.Type, &scope.ID, &scope.Name); err != nil {
			return nil, err
		}
		out = append(out, scope)
	}
	return out, rows.Err()
}

// ReplaceScopes sets an account's grants. An empty list restores whole-fleet
// access, which is the only way back: there is no separate "unscoped" flag to
// fall out of step with the rows.
func (s *Service) ReplaceScopes(ctx context.Context, actor, user uuid.UUID, scopes []Scope) error {
	for _, scope := range scopes {
		if scope.Type != "location" && scope.Type != "group" {
			return fmt.Errorf("unknown scope type %q", scope.Type)
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `DELETE FROM user_screen_scopes WHERE user_id=$1`, user); err != nil {
		return err
	}
	for _, scope := range scopes {
		// The referenced location or group must exist. A scope pointing at
		// nothing would silently narrow an account to zero screens.
		var exists bool
		query := `SELECT EXISTS(SELECT 1 FROM locations WHERE id=$1)`
		if scope.Type == "group" {
			query = `SELECT EXISTS(SELECT 1 FROM screen_groups WHERE id=$1)`
		}
		if err := tx.QueryRow(ctx, query, scope.ID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("that %s no longer exists", scope.Type)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_screen_scopes(user_id,scope_type,scope_id,created_by)
			VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
			user, scope.Type, scope.ID, actor); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,summary)
		VALUES($1,$2,'user.screen_scopes_changed','user',$3,'success',$4)`,
		uuid.New(), actor, user.String(),
		fmt.Sprintf("Screen scope set to %d grants", len(scopes))); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Scoped reports whether an account is narrowed at all. An Owner never is.
func (s *Service) Scoped(ctx context.Context, user uuid.UUID, role string) (bool, error) {
	if role == "owner" {
		return false, nil
	}
	var count int
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM user_screen_scopes WHERE user_id=$1`, user).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

// AuthorizeScreens returns ErrOutOfScope unless every named screen is within the
// account's scope.
//
// All or nothing on purpose: a bulk operation that quietly dropped the screens
// an operator could not touch would report a change count they did not ask for.
func (s *Service) AuthorizeScreens(ctx context.Context, user uuid.UUID, role string, screens []uuid.UUID) error {
	if len(screens) == 0 {
		return nil
	}
	scoped, err := s.Scoped(ctx, user, role)
	if err != nil {
		return err
	}
	if !scoped {
		return nil
	}
	var outside int
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FROM screens sc
		WHERE sc.id = ANY($2) AND NOT `+InScopeSQL("sc", "$1"),
		user, screens).Scan(&outside); err != nil {
		return err
	}
	if outside > 0 {
		return fmt.Errorf("%w: %d of the selected screens are outside it", ErrOutOfScope, outside)
	}
	return nil
}

// AuthorizeScreen is the single-screen case.
func (s *Service) AuthorizeScreen(ctx context.Context, user uuid.UUID, role string, screen uuid.UUID) error {
	if err := s.AuthorizeScreens(ctx, user, role, []uuid.UUID{screen}); err != nil {
		if errors.Is(err, ErrOutOfScope) {
			return ErrOutOfScope
		}
		return err
	}
	return nil
}

// InScopeSQL is the one definition of "this screen is in that account's scope".
// Every scoped read and every scoped operation is built from it, so the list a
// person sees and the screens they may act on cannot diverge. The alias names
// the screens row in the caller's query, and userParam is the placeholder
// holding the account id.
func InScopeSQL(alias, userParam string) string {
	return `(EXISTS(SELECT 1 FROM user_screen_scopes us
	       WHERE us.user_id=` + userParam + ` AND us.scope_type='location'
	         AND us.scope_id=` + alias + `.location_id)
	OR EXISTS(SELECT 1 FROM user_screen_scopes us
	          JOIN screen_group_memberships m ON m.screen_group_id=us.scope_id
	          WHERE us.user_id=` + userParam + ` AND us.scope_type='group'
	            AND m.screen_id=` + alias + `.id))`
}

// ListScreensForUser is ListScreens narrowed to an account's scope. An unscoped
// account, and every Owner, sees the whole fleet.
func (s *Service) ListScreensForUser(ctx context.Context, user uuid.UUID, role string) ([]Screen, error) {
	scoped, err := s.Scoped(ctx, user, role)
	if err != nil {
		return nil, err
	}
	if !scoped {
		return s.ListScreens(ctx)
	}
	rows, err := s.db.Query(ctx, screenSelect+`
		WHERE s.archived_at IS NULL
		  AND `+liveScreenSQL+`
		  AND `+InScopeSQL("s", "$1")+`
		ORDER BY s.name ASC LIMIT 500`, user)
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
