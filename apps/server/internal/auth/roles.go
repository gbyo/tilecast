package auth

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Role is a named bundle of capabilities. Built-in roles are protected and
// carry their capabilities in code; custom roles store theirs in the
// role_capabilities table, filtered through the closed vocabulary on read.
type Role struct {
	Key          string       `json:"key"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	Builtin      bool         `json:"builtin"`
	Capabilities []Capability `json:"capabilities"`
	UserCount    int          `json:"userCount"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
}

// RoleInput is the editable part of a custom role.
type RoleInput struct {
	Name         string
	Description  string
	Capabilities []string
}

var (
	// ErrRoleNotFound means the key names no role.
	ErrRoleNotFound = errors.New("role not found")
	// ErrRoleProtected means the operation would change a built-in role.
	ErrRoleProtected = errors.New("built-in roles cannot be changed")
	// ErrRoleInUse means a role still has accounts assigned to it.
	ErrRoleInUse = errors.New("role is assigned to one or more accounts")
	// ErrRoleNameTaken means another role already uses the display name.
	ErrRoleNameTaken = errors.New("another role already uses that name")
	// ErrDelegation means the actor may not grant the requested authority.
	ErrDelegation = errors.New("you cannot grant authority you do not hold")
)

// RoleAudit records one role change inside the transaction that makes it.
// The request layer supplies it so role changes reach the shared audit path,
// which the auth package cannot import.
type RoleAudit func(ctx context.Context, tx pgx.Tx, action, key string, capabilities []string) error

// RoleValidationError explains why a custom role definition was refused.
type RoleValidationError struct{ Reason string }

func (e *RoleValidationError) Error() string { return e.Reason }

// ResolveCapabilities returns the effective capabilities of a role key. A
// built-in role answers from code without a query. A custom role is read
// live on every call, so changing it takes effect on the next request of
// every account that holds it. A key that names nothing resolves to the
// empty set: an account on a missing role can do nothing, rather than
// whatever a default might have allowed.
func (s *Service) ResolveCapabilities(ctx context.Context, role string) (CapabilitySet, error) {
	if set, ok := BuiltinCapabilities(role); ok {
		return set, nil
	}
	if !IsCustomRoleKey(role) {
		return CapabilitySet{}, nil
	}
	rows, err := s.db.Query(ctx, `SELECT capability FROM role_capabilities WHERE role_key=$1`, role)
	if err != nil {
		return nil, fmt.Errorf("resolve role capabilities: %w", err)
	}
	defer rows.Close()
	values := []Capability{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, Capability(value))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	set := NewCapabilitySet(values...)
	// Reserved capabilities are never honored on a custom role, even if a
	// row somehow says otherwise.
	for capability := range set {
		if capabilityIndex[capability].OwnerReserved {
			delete(set, capability)
		}
	}
	return set, nil
}

// ListRoles returns every role with its member count, built-ins first.
func (s *Service) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := s.db.Query(ctx, `
		SELECT r.key,r.name,r.description,r.builtin,r.created_at,r.updated_at,
		       (SELECT count(*) FROM users u WHERE u.role=r.key AND u.active)
		FROM roles r
		ORDER BY r.builtin DESC, r.sort_order, lower(r.name), r.key`)
	if err != nil {
		return nil, err
	}
	roles := []Role{}
	for rows.Next() {
		var role Role
		if err := rows.Scan(&role.Key, &role.Name, &role.Description, &role.Builtin, &role.CreatedAt, &role.UpdatedAt, &role.UserCount); err != nil {
			rows.Close()
			return nil, err
		}
		roles = append(roles, role)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range roles {
		set, err := s.ResolveCapabilities(ctx, roles[i].Key)
		if err != nil {
			return nil, err
		}
		roles[i].Capabilities = set.Sorted()
	}
	return roles, nil
}

// GetRole returns one role.
func (s *Service) GetRole(ctx context.Context, key string) (Role, error) {
	var role Role
	err := s.db.QueryRow(ctx, `
		SELECT r.key,r.name,r.description,r.builtin,r.created_at,r.updated_at,
		       (SELECT count(*) FROM users u WHERE u.role=r.key AND u.active)
		FROM roles r WHERE r.key=$1`, key).Scan(&role.Key, &role.Name, &role.Description, &role.Builtin, &role.CreatedAt, &role.UpdatedAt, &role.UserCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, ErrRoleNotFound
	}
	if err != nil {
		return Role{}, err
	}
	set, err := s.ResolveCapabilities(ctx, key)
	if err != nil {
		return Role{}, err
	}
	role.Capabilities = set.Sorted()
	return role, nil
}

// Delegator is the authority creating or assigning a role: the actor's own
// role key and effective capabilities.
type Delegator struct {
	UserID       uuid.UUID
	Role         string
	Capabilities CapabilitySet
}

// CanDelegate reports whether the delegator may hand out a role with the
// given capabilities. The Owner may grant anything. Anyone else may grant
// only capabilities they hold themselves, never an Owner-reserved one, and
// never the capabilities that administer access (users.manage,
// roles.manage): those stay with the Owner, which is the rule that has
// always kept an Administrator from creating another Administrator.
func (d Delegator) CanDelegate(set CapabilitySet) bool {
	if d.Role == RoleOwner {
		return true
	}
	for capability := range set {
		definition := capabilityIndex[capability]
		if !definition.Delegable || !d.Capabilities.Has(capability) {
			return false
		}
	}
	return true
}

// CanAssignRole reports whether the delegator may place an account on role
// (or take one off it). Built-in Owner and Administrator are Owner-only
// identities. Any other role is assignable when its capabilities are within
// what the delegator may grant.
func (d Delegator) CanAssignRole(role string, capabilities CapabilitySet) bool {
	if d.Role == RoleOwner {
		return true
	}
	if role == RoleOwner || role == RoleAdministrator {
		return false
	}
	return d.CanDelegate(capabilities)
}

var roleKeyCleaner = regexp.MustCompile(`[^a-z0-9]+`)

// normalizeRoleInput validates a custom role and returns its capability set.
func normalizeRoleInput(input RoleInput) (RoleInput, CapabilitySet, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if len(input.Name) < 2 || len(input.Name) > 60 {
		return input, nil, &RoleValidationError{Reason: "name must be between 2 and 60 characters"}
	}
	if len(input.Description) > 280 {
		return input, nil, &RoleValidationError{Reason: "description must be 280 characters or fewer"}
	}
	for _, key := range BuiltinRoleKeys {
		if strings.EqualFold(input.Name, key) {
			return input, nil, &RoleValidationError{Reason: "name matches a built-in role"}
		}
	}
	set := CapabilitySet{}
	for _, raw := range input.Capabilities {
		definition, ok := LookupCapability(raw)
		if !ok {
			return input, nil, &RoleValidationError{Reason: fmt.Sprintf("%q is not a Tilecast capability", raw)}
		}
		if definition.OwnerReserved {
			return input, nil, &RoleValidationError{Reason: fmt.Sprintf("%s is reserved for the Owner role", raw)}
		}
		set[definition.Key] = struct{}{}
	}
	if missing := set.MissingRequirements(); len(missing) > 0 {
		return input, nil, &RoleValidationError{Reason: "missing required capabilities: " + strings.Join(missing, ", ")}
	}
	return input, set, nil
}

// CreateRole adds a custom role. Its key is derived once from the name and
// never changes, so audit history and assignments survive a rename.
func (s *Service) CreateRole(ctx context.Context, delegator Delegator, input RoleInput, record RoleAudit) (Role, error) {
	input, set, err := normalizeRoleInput(input)
	if err != nil {
		return Role{}, err
	}
	if !delegator.CanDelegate(set) {
		return Role{}, ErrDelegation
	}
	base := strings.Trim(roleKeyCleaner.ReplaceAllString(strings.ToLower(input.Name), "-"), "-")
	if base == "" {
		base = "role"
	}
	if len(base) > 40 {
		base = strings.Trim(base[:40], "-")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Role{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := ensureRoleNameFree(ctx, tx, input.Name, ""); err != nil {
		return Role{}, err
	}
	key := CustomRolePrefix + base
	for suffix := 2; ; suffix++ {
		var taken bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE key=$1)`, key).Scan(&taken); err != nil {
			return Role{}, err
		}
		if !taken {
			break
		}
		key = fmt.Sprintf("%s%s-%d", CustomRolePrefix, base, suffix)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO roles(key,name,description,builtin,created_by) VALUES($1,$2,$3,FALSE,$4)`, key, input.Name, input.Description, delegator.UserID); err != nil {
		return Role{}, err
	}
	if err := writeRoleCapabilities(ctx, tx, key, set); err != nil {
		return Role{}, err
	}
	if err := record(ctx, tx, "role.created", key, set.Strings()); err != nil {
		return Role{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, err
	}
	return s.GetRole(ctx, key)
}

// UpdateRole replaces a custom role's name, description, and capabilities.
// The delegator must be able to grant both the old and the new set: editing
// a role is granting its new authority to everyone who holds it, and taking
// the old authority away from them.
func (s *Service) UpdateRole(ctx context.Context, delegator Delegator, key string, input RoleInput, record RoleAudit) (Role, error) {
	if IsBuiltinRole(key) {
		return Role{}, ErrRoleProtected
	}
	input, set, err := normalizeRoleInput(input)
	if err != nil {
		return Role{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Role{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var builtin bool
	if err := tx.QueryRow(ctx, `SELECT builtin FROM roles WHERE key=$1 FOR UPDATE`, key).Scan(&builtin); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Role{}, ErrRoleNotFound
		}
		return Role{}, err
	}
	if builtin {
		return Role{}, ErrRoleProtected
	}
	current, err := s.ResolveCapabilities(ctx, key)
	if err != nil {
		return Role{}, err
	}
	if !delegator.CanDelegate(current) || !delegator.CanDelegate(set) {
		return Role{}, ErrDelegation
	}
	if err := ensureRoleNameFree(ctx, tx, input.Name, key); err != nil {
		return Role{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE roles SET name=$2,description=$3,updated_at=now() WHERE key=$1`, key, input.Name, input.Description); err != nil {
		return Role{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM role_capabilities WHERE role_key=$1`, key); err != nil {
		return Role{}, err
	}
	if err := writeRoleCapabilities(ctx, tx, key, set); err != nil {
		return Role{}, err
	}
	if err := record(ctx, tx, "role.updated", key, set.Strings()); err != nil {
		return Role{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, err
	}
	return s.GetRole(ctx, key)
}

// DeleteRole removes a custom role that no account holds, active or not.
func (s *Service) DeleteRole(ctx context.Context, delegator Delegator, key string, record RoleAudit) error {
	if IsBuiltinRole(key) {
		return ErrRoleProtected
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var builtin bool
	if err := tx.QueryRow(ctx, `SELECT builtin FROM roles WHERE key=$1 FOR UPDATE`, key).Scan(&builtin); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRoleNotFound
		}
		return err
	}
	if builtin {
		return ErrRoleProtected
	}
	current, err := s.ResolveCapabilities(ctx, key)
	if err != nil {
		return err
	}
	if !delegator.CanDelegate(current) {
		return ErrDelegation
	}
	var assigned bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE role=$1)`, key).Scan(&assigned); err != nil {
		return err
	}
	if assigned {
		return ErrRoleInUse
	}
	if _, err := tx.Exec(ctx, `DELETE FROM roles WHERE key=$1`, key); err != nil {
		return err
	}
	if err := record(ctx, tx, "role.deleted", key, current.Strings()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func ensureRoleNameFree(ctx context.Context, tx pgx.Tx, name, except string) error {
	var taken bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE lower(name)=lower($1) AND key<>$2)`, name, except).Scan(&taken); err != nil {
		return err
	}
	if taken {
		return ErrRoleNameTaken
	}
	return nil
}

func writeRoleCapabilities(ctx context.Context, tx pgx.Tx, key string, set CapabilitySet) error {
	for _, capability := range set.Sorted() {
		if _, err := tx.Exec(ctx, `INSERT INTO role_capabilities(role_key,capability) VALUES($1,$2)`, key, string(capability)); err != nil {
			return err
		}
	}
	return nil
}
