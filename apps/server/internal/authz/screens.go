package authz

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// Screen access modes.
const (
	ModeAll        = "all"
	ModeRestricted = "restricted"
)

// ScreenAccess is one account's resolved screen-access policy.
type ScreenAccess struct {
	UserID uuid.UUID
	// All is the whole fleet: the Owner, or a policy in mode "all".
	All bool
	// Configured is false when the account has no policy row. Such an
	// account reaches no screen, whatever grant rows remain.
	Configured bool
}

// Mode names the policy for API output. A missing policy reads as
// restricted, which is what it is.
func (a ScreenAccess) Mode() string {
	if a.All {
		return ModeAll
	}
	return ModeRestricted
}

// Access resolves the actor's screen-access policy.
func (z *Authorizer) Access(ctx context.Context, actor Actor) (ScreenAccess, error) {
	if actor.Owner {
		return ScreenAccess{UserID: actor.UserID, All: true, Configured: true}, nil
	}
	query := `SELECT mode FROM user_screen_access WHERE user_id=$1`
	if z.lock {
		query += ` FOR SHARE`
	}
	var mode string
	err := z.db.QueryRow(ctx, query, actor.UserID).Scan(&mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return ScreenAccess{UserID: actor.UserID}, nil
	}
	if err != nil {
		return ScreenAccess{}, fmt.Errorf("read screen access: %w", err)
	}
	return ScreenAccess{UserID: actor.UserID, All: mode == ModeAll, Configured: true}, nil
}

// authorize checks the capabilities and resolves the policy. Callers stop
// on an error and allow everything when the result is the whole fleet.
func (z *Authorizer) authorize(ctx context.Context, actor Actor, capabilities ...auth.Capability) (ScreenAccess, error) {
	if err := Require(actor, capabilities...); err != nil {
		return ScreenAccess{}, err
	}
	return z.Access(ctx, actor)
}

// The SQL below is the one definition of each reach rule. Lists, counts,
// direct decisions, and bulk decisions are built from these strings, so
// what an account sees and what it may act on cannot diverge. Each takes
// the alias of the row it judges and the placeholder that holds the
// account id. Inner aliases carry an authz_ prefix so a caller's alias
// cannot be captured.

// grantedScreenSQL: the screen's location is granted, or the screen
// belongs to a granted Display Group.
func grantedScreenSQL(alias, userParam string) string {
	return `(EXISTS(SELECT 1 FROM user_screen_scopes authz_ul
	       WHERE authz_ul.user_id=` + userParam + ` AND authz_ul.scope_type='location'
	         AND authz_ul.scope_id=` + alias + `.location_id)
	OR EXISTS(SELECT 1 FROM user_screen_scopes authz_ug
	          JOIN screen_group_memberships authz_gm ON authz_gm.screen_group_id=authz_ug.scope_id
	          WHERE authz_ug.user_id=` + userParam + ` AND authz_ug.scope_type='group'
	            AND authz_gm.screen_id=` + alias + `.id))`
}

// grantedPeersSQL: the screen is reachable, and so is every screen that
// shares a Display Group with it. A Display Group plays one assignment on
// every member, so assigning content to one member changes them all.
func grantedPeersSQL(alias, userParam string) string {
	return `(` + grantedScreenSQL(alias, userParam) + `
	AND NOT EXISTS(SELECT 1 FROM screen_group_memberships authz_pa
	               JOIN screen_group_memberships authz_pb ON authz_pb.screen_group_id=authz_pa.screen_group_id
	               JOIN screens authz_pp ON authz_pp.id=authz_pb.screen_id
	               WHERE authz_pa.screen_id=` + alias + `.id
	                 AND NOT ` + grantedScreenSQL("authz_pp", userParam) + `))`
}

// grantedGroupSQL: the group is granted directly, or it has at least one
// member and every member is reachable. An empty group without a direct
// grant has no anchor.
func grantedGroupSQL(alias, userParam string) string {
	return `(EXISTS(SELECT 1 FROM user_screen_scopes authz_dg
	       WHERE authz_dg.user_id=` + userParam + ` AND authz_dg.scope_type='group'
	         AND authz_dg.scope_id=` + alias + `.id)
	OR (EXISTS(SELECT 1 FROM screen_group_memberships authz_any WHERE authz_any.screen_group_id=` + alias + `.id)
	    AND NOT EXISTS(SELECT 1 FROM screen_group_memberships authz_mem
	                   JOIN screens authz_ms ON authz_ms.id=authz_mem.screen_id
	                   WHERE authz_mem.screen_group_id=` + alias + `.id
	                     AND NOT ` + grantedScreenSQL("authz_ms", userParam) + `)))`
}

// grantedScreenSetSQL: a container whose concrete screens are rows of table
// keyed by column. It needs at least one row, and every row's screen must
// be reachable.
func grantedScreenSetSQL(table, column, idExpr, userParam string) string {
	return `(EXISTS(SELECT 1 FROM ` + table + ` authz_set WHERE authz_set.` + column + `=` + idExpr + `)
	AND NOT EXISTS(SELECT 1 FROM ` + table + ` authz_row
	               JOIN screens authz_rs ON authz_rs.id=authz_row.screen_id
	               WHERE authz_row.` + column + `=` + idExpr + `
	                 AND NOT ` + grantedScreenSQL("authz_rs", userParam) + `))`
}

// policySQL wraps a grant predicate with the policy mode. The constant
// forms still name the account parameter, so a query that passes it stays
// valid whatever the mode: PostgreSQL refuses a parameter it cannot type.
func (a ScreenAccess) policySQL(userParam, granted string) string {
	switch {
	case a.All:
		return "(" + userParam + "::uuid IS NOT NULL OR TRUE)"
	case !a.Configured:
		return "(" + userParam + "::uuid IS NULL AND FALSE)"
	default:
		return granted
	}
}

// ScreenSQL is the predicate "this screen row is within the account's
// access". alias names the screens row; userParam holds the account id.
func (a ScreenAccess) ScreenSQL(alias, userParam string) string {
	return a.policySQL(userParam, grantedScreenSQL(alias, userParam))
}

// AssignableScreenSQL is ScreenSQL for operations that a Display Group
// carries to every member: the screen and all of its group peers.
func (a ScreenAccess) AssignableScreenSQL(alias, userParam string) string {
	return a.policySQL(userParam, grantedPeersSQL(alias, userParam))
}

// GroupSQL is the predicate "this screen_groups row is reachable".
func (a ScreenAccess) GroupSQL(alias, userParam string) string {
	return a.policySQL(userParam, grantedGroupSQL(alias, userParam))
}

// ScheduleSQL is the predicate "this schedules row is reachable": at least
// one target, and every target a reachable screen or Display Group.
func (a ScreenAccess) ScheduleSQL(alias, userParam string) string {
	return a.policySQL(userParam, `(EXISTS(SELECT 1 FROM schedule_targets authz_t0 WHERE authz_t0.schedule_id=`+alias+`.id)
	AND NOT EXISTS(SELECT 1 FROM schedule_targets authz_t
	        LEFT JOIN screens authz_ts ON authz_t.target_type='screen' AND authz_ts.id=authz_t.screen_id
	        LEFT JOIN screen_groups authz_tg ON authz_t.target_type='group' AND authz_tg.id=authz_t.screen_group_id
	        WHERE authz_t.schedule_id=`+alias+`.id AND NOT COALESCE(
	          (authz_t.target_type='screen' AND authz_ts.id IS NOT NULL AND `+grantedScreenSQL("authz_ts", userParam)+`)
	          OR (authz_t.target_type='group' AND authz_tg.id IS NOT NULL AND `+grantedGroupSQL("authz_tg", userParam)+`), FALSE)))`)
}

// TakeoverSQL is the predicate "this takeover is reachable", judged by the
// screens it reaches.
func (a ScreenAccess) TakeoverSQL(idExpr, userParam string) string {
	return a.policySQL(userParam, grantedScreenSetSQL("takeover_screen_states", "takeover_id", idExpr, userParam))
}

// DeploymentSQL is the predicate "every screen of this deployment is
// reachable". Reading a deployment uses DeploymentVisibleSQL instead.
func (a ScreenAccess) DeploymentSQL(idExpr, userParam string) string {
	return a.policySQL(userParam, grantedScreenSetSQL("screen_update_states", "deployment_id", idExpr, userParam))
}

// locationGrantSQL: the location itself is granted.
func locationGrantSQL(idExpr, userParam string) string {
	return `EXISTS(SELECT 1 FROM user_screen_scopes authz_lg
	       WHERE authz_lg.user_id=` + userParam + ` AND authz_lg.scope_type='location'
	         AND authz_lg.scope_id=` + idExpr + `)`
}

// LocationVisibleSQL is the predicate for listing a locations row: a
// granted location, or the location of a screen the account reaches. A
// restricted account sees the names relevant to its own screens, not the
// organization's catalog.
func (a ScreenAccess) LocationVisibleSQL(alias, userParam string) string {
	return a.policySQL(userParam, `(`+locationGrantSQL(alias+".id", userParam)+`
	OR EXISTS(SELECT 1 FROM screens authz_ls WHERE authz_ls.location_id=`+alias+`.id
	          AND authz_ls.deleted_at IS NULL AND `+grantedScreenSQL("authz_ls", userParam)+`))`)
}

// exists runs a single-boolean query.
func (z *Authorizer) exists(ctx context.Context, query string, args ...any) (bool, error) {
	var ok bool
	if err := z.db.QueryRow(ctx, query, args...).Scan(&ok); err != nil {
		return false, err
	}
	return ok, nil
}

// Screen authorizes one screen. Outside the account's reach, and unknown,
// both answer ErrNotFound. A whole-fleet account passes without a lookup
// so the caller keeps reporting its own not-found.
func (z *Authorizer) Screen(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	ok, err := z.exists(ctx, `SELECT EXISTS(SELECT 1 FROM screens s WHERE s.id=$2 AND s.deleted_at IS NULL AND `+access.ScreenSQL("s", "$1")+`)`, actor.UserID, id)
	if err != nil {
		return fmt.Errorf("authorize screen: %w", err)
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// ScreenAssignment authorizes an operation on one screen that its Display
// Groups carry to every member. The screen and all of its group peers must
// be reachable; otherwise it answers ErrNotFound when the screen itself is
// out of reach and ErrOutOfScope when only a peer is.
func (z *Authorizer) ScreenAssignment(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	if err := z.Screen(ctx, actor, capability, id); err != nil {
		return err
	}
	return z.Selection(ctx, actor, capability, Selection{ScreenIDs: []uuid.UUID{id}, Peers: true})
}

// Screens authorizes a set of screens, all or nothing. A restricted account
// naming no screen at all has nothing to anchor the decision and is refused.
func (z *Authorizer) Screens(ctx context.Context, actor Actor, capability auth.Capability, ids []uuid.UUID) error {
	return z.Selection(ctx, actor, capability, Selection{ScreenIDs: ids})
}

// Selection names screens and Display Groups an operation will act on.
type Selection struct {
	ScreenIDs []uuid.UUID
	GroupIDs  []uuid.UUID
	// Peers marks an operation that a Display Group carries to every
	// member, such as assigning content. Each named screen's group peers
	// must then be reachable too.
	Peers bool
}

func unique(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// Selection authorizes every screen and Display Group, all or nothing. A
// group is judged as a container (see grantedGroupSQL), never by expanding
// it into members that might be zero.
func (z *Authorizer) Selection(ctx context.Context, actor Actor, capability auth.Capability, selection Selection) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	screens, groups := unique(selection.ScreenIDs), unique(selection.GroupIDs)
	if len(screens)+len(groups) == 0 {
		return ErrOutOfScope
	}
	screenSQL := access.ScreenSQL("s", "$1")
	if selection.Peers {
		screenSQL = access.AssignableScreenSQL("s", "$1")
	}
	var reachedScreens, reachedGroups int
	if err := z.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM screens s WHERE s.id=ANY($2) AND s.deleted_at IS NULL AND `+screenSQL+`),
		(SELECT count(*) FROM screen_groups g WHERE g.id=ANY($3) AND g.deleted_at IS NULL AND `+access.GroupSQL("g", "$1")+`)`,
		actor.UserID, screens, groups).Scan(&reachedScreens, &reachedGroups); err != nil {
		return fmt.Errorf("authorize selection: %w", err)
	}
	if reachedScreens != len(screens) || reachedGroups != len(groups) {
		return ErrOutOfScope
	}
	return nil
}

// Group authorizes one Display Group as a container.
func (z *Authorizer) Group(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	return z.found(ctx, `SELECT EXISTS(SELECT 1 FROM screen_groups g WHERE g.id=$2 AND g.deleted_at IS NULL AND `+access.GroupSQL("g", "$1")+`)`, actor.UserID, id)
}

// found turns a false boolean into ErrNotFound.
func (z *Authorizer) found(ctx context.Context, query string, args ...any) error {
	ok, err := z.exists(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// GroupMember authorizes adding a screen to, or removing it from, a group.
// Both must be reachable: membership must never make a screen reachable to
// the group's grantees unless the actor could already reach it.
func (z *Authorizer) GroupMember(ctx context.Context, actor Actor, capability auth.Capability, group, screen uuid.UUID) error {
	if err := z.Group(ctx, actor, capability, group); err != nil {
		return err
	}
	return z.Screen(ctx, actor, capability, screen)
}

// Schedule authorizes one schedule as a container.
func (z *Authorizer) Schedule(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	return z.found(ctx, `SELECT EXISTS(SELECT 1 FROM schedules sch WHERE sch.id=$2 AND `+access.ScheduleSQL("sch", "$1")+`)`, actor.UserID, id)
}

// Takeover authorizes one takeover by the screens it reaches.
func (z *Authorizer) Takeover(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	return z.found(ctx, `SELECT `+access.TakeoverSQL("$2", "$1"), actor.UserID, id)
}

// PresentationOverrideSQL is the predicate "this presentation_overrides
// row is reachable", judged by its target as an assignment.
func (a ScreenAccess) PresentationOverrideSQL(alias, userParam string) string {
	return a.policySQL(userParam, `((`+alias+`.target_type='screen' AND EXISTS(SELECT 1 FROM screens authz_os WHERE authz_os.id=`+alias+`.target_id AND `+grantedPeersSQL("authz_os", userParam)+`))
	OR (`+alias+`.target_type='group' AND EXISTS(SELECT 1 FROM screen_groups authz_og WHERE authz_og.id=`+alias+`.target_id AND `+grantedGroupSQL("authz_og", userParam)+`)))`)
}

// PresentationOverride authorizes one active Quick Present by its target.
func (z *Authorizer) PresentationOverride(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	return z.found(ctx, `SELECT EXISTS(SELECT 1 FROM presentation_overrides o WHERE o.id=$2 AND o.stopped_at IS NULL AND `+access.PresentationOverrideSQL("o", "$1")+`)`,
		actor.UserID, id)
}

// AirPlaySession authorizes one AirPlay Present session by its participants.
func (z *Authorizer) AirPlaySession(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	return z.found(ctx, `SELECT `+access.policySQL("$1", grantedScreenSetSQL("external_presentation_screen_states", "session_id", "$2", "$1")), actor.UserID, id)
}

// DeploymentRead authorizes reading an update deployment. A restricted
// account reads a deployment that reaches at least one of its screens; the
// caller narrows the rows with ScreenSQL.
func (z *Authorizer) DeploymentRead(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	return z.found(ctx, `SELECT EXISTS(SELECT 1 FROM screen_update_states st JOIN screens s ON s.id=st.screen_id
		WHERE st.deployment_id=$2 AND `+access.ScreenSQL("s", "$1")+`)`, actor.UserID, id)
}

// Deployment authorizes an operation on a whole update deployment. It
// answers ErrNotFound when the account reaches none of it and ErrOutOfScope
// when it reaches only part of it.
func (z *Authorizer) Deployment(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID) error {
	if err := z.DeploymentRead(ctx, actor, capability, id); err != nil {
		return err
	}
	access, err := z.Access(ctx, actor)
	if err != nil || access.All {
		return err
	}
	ok, err := z.exists(ctx, `SELECT `+access.DeploymentSQL("$2", "$1"), actor.UserID, id)
	if err != nil {
		return fmt.Errorf("authorize deployment: %w", err)
	}
	if !ok {
		return ErrOutOfScope
	}
	return nil
}

// Reachable filters a set of objects of one kind down to the reachable
// ones, with the same predicate as the single-object decision. Lists use it
// so a list and a direct read cannot disagree.
type Kind string

const (
	KindScreen   Kind = "screen"
	KindGroup    Kind = "group"
	KindSchedule Kind = "schedule"
	KindTakeover Kind = "takeover"
	// KindPresentationOverride is a Quick Present.
	KindPresentationOverride Kind = "presentation_override"
)

// Reachable returns the members of ids the actor reaches. The capability is
// the list's own read capability.
func (z *Authorizer) Reachable(ctx context.Context, actor Actor, capability auth.Capability, kind Kind, ids []uuid.UUID) (map[uuid.UUID]bool, error) {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]bool, len(ids))
	if access.All {
		for _, id := range ids {
			out[id] = true
		}
		return out, nil
	}
	if len(ids) == 0 {
		return out, nil
	}
	var query string
	switch kind {
	case KindScreen:
		query = `SELECT s.id FROM screens s WHERE s.id=ANY($2) AND ` + access.ScreenSQL("s", "$1")
	case KindGroup:
		query = `SELECT g.id FROM screen_groups g WHERE g.id=ANY($2) AND ` + access.GroupSQL("g", "$1")
	case KindSchedule:
		query = `SELECT sch.id FROM schedules sch WHERE sch.id=ANY($2) AND ` + access.ScheduleSQL("sch", "$1")
	case KindTakeover:
		query = `SELECT t.id FROM takeovers t WHERE t.id=ANY($2) AND ` + access.TakeoverSQL("t.id", "$1")
	case KindPresentationOverride:
		query = `SELECT o.id FROM presentation_overrides o WHERE o.id=ANY($2) AND ` + access.PresentationOverrideSQL("o", "$1")
	default:
		return nil, fmt.Errorf("authz: unknown kind %q", kind)
	}
	rows, err := z.db.Query(ctx, query, actor.UserID, ids)
	if err != nil {
		return nil, fmt.Errorf("filter reachable %s: %w", kind, err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}
