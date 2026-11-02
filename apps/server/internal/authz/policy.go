package authz

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
)

// Grant is one location or Display Group in a restricted policy.
type Grant struct {
	Type string    `json:"type"`
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name,omitempty"`
}

// Policy is the stored screen-access policy of one account.
type Policy struct {
	Mode   string  `json:"mode"`
	Grants []Grant `json:"scopes"`
	// Configured is false when the account has no policy row.
	Configured bool `json:"configured"`
}

// Policy errors.
var (
	// ErrPolicyInvalid means the requested policy is malformed.
	ErrPolicyInvalid = errors.New("screen access policy is invalid")
	// ErrDelegation means the actor tried to grant more than it reaches.
	ErrDelegation = errors.New("you can grant only screen access you hold yourself")
)

// PolicyFor reads an account's stored policy with grant names for display.
// It reads the row as stored, without the Owner rule, so an editor can
// show exactly what is saved.
func PolicyFor(ctx context.Context, db Querier, user uuid.UUID) (Policy, error) {
	policy := Policy{Mode: ModeRestricted, Grants: []Grant{}}
	err := db.QueryRow(ctx, `SELECT mode FROM user_screen_access WHERE user_id=$1`, user).Scan(&policy.Mode)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		policy.Mode = ModeRestricted
	case err != nil:
		return Policy{}, fmt.Errorf("read screen access: %w", err)
	default:
		policy.Configured = true
	}
	rows, err := db.Query(ctx, `
		SELECT sc.scope_type, sc.scope_id, COALESCE(l.name, g.name, '')
		FROM user_screen_scopes sc
		LEFT JOIN locations l ON sc.scope_type='location' AND l.id=sc.scope_id
		LEFT JOIN screen_groups g ON sc.scope_type='group' AND g.id=sc.scope_id AND g.deleted_at IS NULL
		WHERE sc.user_id=$1
		ORDER BY sc.scope_type, COALESCE(l.name, g.name, '')`, user)
	if err != nil {
		return Policy{}, fmt.Errorf("read screen access grants: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var grant Grant
		if err := rows.Scan(&grant.Type, &grant.ID, &grant.Name); err != nil {
			return Policy{}, err
		}
		policy.Grants = append(policy.Grants, grant)
	}
	return policy, rows.Err()
}

// PolicyInput is a requested policy.
type PolicyInput struct {
	Mode   string
	Grants []Grant
}

// Validate checks the shape of a requested policy without the database.
func (input PolicyInput) Validate() error {
	switch input.Mode {
	case ModeAll:
		if len(input.Grants) != 0 {
			return fmt.Errorf("%w: all screens takes no location or group grants", ErrPolicyInvalid)
		}
	case ModeRestricted:
		for _, grant := range input.Grants {
			if grant.Type != "location" && grant.Type != "group" {
				return fmt.Errorf("%w: unknown grant type %q", ErrPolicyInvalid, grant.Type)
			}
			if grant.ID == uuid.Nil {
				return fmt.Errorf("%w: a grant needs an id", ErrPolicyInvalid)
			}
		}
	default:
		return fmt.Errorf("%w: mode must be all or restricted", ErrPolicyInvalid)
	}
	return nil
}

// Delegable reports ErrDelegation unless actor may hand input to someone
// else: a restricted actor cannot grant the whole fleet, and may grant only
// locations and Display Groups granted to it directly. A group the actor
// reaches only through its members is not delegable, because the group can
// gain members the actor could never reach.
func (z *Authorizer) Delegable(ctx context.Context, actor Actor, input PolicyInput) error {
	access, err := z.Access(ctx, actor)
	if err != nil || access.All {
		return err
	}
	if input.Mode == ModeAll || (!access.Configured && len(input.Grants) > 0) {
		return ErrDelegation
	}
	for _, grant := range input.Grants {
		ok, err := z.exists(ctx, `SELECT EXISTS(SELECT 1 FROM user_screen_scopes WHERE user_id=$1 AND scope_type=$2 AND scope_id=$3)`, actor.UserID, grant.Type, grant.ID)
		if err != nil {
			return fmt.Errorf("check screen access delegation: %w", err)
		}
		if !ok {
			return ErrDelegation
		}
	}
	return nil
}

// ReplacePolicyTx stores input as user's policy inside tx and records the
// change in the audit log. It writes the policy row before the grants, so
// a concurrent decision holding the row FOR SHARE finishes first and the
// next one sees the new policy. Callers authorize the actor beforehand.
func ReplacePolicyTx(ctx context.Context, tx pgx.Tx, actor, user uuid.UUID, input PolicyInput) error {
	if err := input.Validate(); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_screen_access(user_id,mode,updated_by,updated_at) VALUES($1,$2,$3,now())
		ON CONFLICT (user_id) DO UPDATE SET mode=EXCLUDED.mode,updated_by=EXCLUDED.updated_by,updated_at=now()`,
		user, input.Mode, nullable(actor)); err != nil {
		return fmt.Errorf("save screen access: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_screen_scopes WHERE user_id=$1`, user); err != nil {
		return fmt.Errorf("clear screen access grants: %w", err)
	}
	for _, grant := range input.Grants {
		// The referenced location or group must exist. A grant pointing at
		// nothing would silently narrow an account to zero screens.
		query := `SELECT EXISTS(SELECT 1 FROM locations WHERE id=$1)`
		if grant.Type == "group" {
			query = `SELECT EXISTS(SELECT 1 FROM screen_groups WHERE id=$1 AND deleted_at IS NULL)`
		}
		var exists bool
		if err := tx.QueryRow(ctx, query, grant.ID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("%w: that %s no longer exists", ErrPolicyInvalid, grant.Type)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_screen_scopes(user_id,scope_type,scope_id,created_by)
			VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
			user, grant.Type, grant.ID, nullable(actor)); err != nil {
			return fmt.Errorf("save screen access grant: %w", err)
		}
	}
	summary := "Screen access set to all screens"
	if input.Mode == ModeRestricted {
		summary = fmt.Sprintf("Screen access restricted to %d grants", len(input.Grants))
	}
	if err := audit.RecordTx(ctx, tx, audit.Event{
		Action: "user.screen_scopes_changed", ResourceType: "user", ResourceID: user.String(),
		Summary: summary, Actor: nullable(actor),
		Metadata: map[string]any{"mode": input.Mode, "grantCount": len(input.Grants)},
	}); err != nil {
		return fmt.Errorf("audit screen access: %w", err)
	}
	return nil
}

func nullable(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}
