package authz

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// Directory is a stored target that is resolved again later, such as a
// plugin's configured targets or an alert rule. Its Display Groups and
// locations can gain members after the decision, so they are judged by
// grant, not by their members today.
type Directory struct {
	// All targets the whole fleet, now and later.
	All         bool
	ScreenIDs   []uuid.UUID
	GroupIDs    []uuid.UUID
	LocationIDs []uuid.UUID
}

// Directory authorizes a stored target, all or nothing. A restricted
// account may name screens it reaches, and Display Groups and locations
// granted to it directly. It may not target the whole fleet, and an empty
// target has no anchor.
func (z *Authorizer) Directory(ctx context.Context, actor Actor, capability auth.Capability, target Directory) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	screens, groups, locations := unique(target.ScreenIDs), unique(target.GroupIDs), unique(target.LocationIDs)
	if target.All || !access.Configured || len(screens)+len(groups)+len(locations) == 0 {
		return ErrOutOfScope
	}
	var reachedScreens, grantedGroups, grantedLocations int
	if err := z.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM screens s WHERE s.id=ANY($2) AND s.deleted_at IS NULL AND `+access.ScreenSQL("s", "$1")+`),
		(SELECT count(*) FROM user_screen_scopes WHERE user_id=$1 AND scope_type='group' AND scope_id=ANY($3)),
		(SELECT count(*) FROM user_screen_scopes WHERE user_id=$1 AND scope_type='location' AND scope_id=ANY($4))`,
		actor.UserID, screens, groups, locations).Scan(&reachedScreens, &grantedGroups, &grantedLocations); err != nil {
		return fmt.Errorf("authorize target: %w", err)
	}
	if reachedScreens != len(screens) || grantedGroups != len(groups) || grantedLocations != len(locations) {
		return ErrOutOfScope
	}
	return nil
}

// DirectGrantSQL is the predicate "the account holds a direct grant of this
// location or Display Group", for directory pickers. kind is "location" or
// "group"; idExpr is the SQL expression of the object's id.
func (a ScreenAccess) DirectGrantSQL(kind, idExpr, userParam string) string {
	if kind != "location" && kind != "group" {
		return "FALSE"
	}
	return a.policySQL(userParam, `EXISTS(SELECT 1 FROM user_screen_scopes authz_dir
	       WHERE authz_dir.user_id=`+userParam+` AND authz_dir.scope_type='`+kind+`'
	         AND authz_dir.scope_id=`+idExpr+`)`)
}
