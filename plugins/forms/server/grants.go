package server

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// GrantInput grants one capability to one user on one form.
type GrantInput struct {
	UserID     uuid.UUID
	Capability Capability
}

// ListGrants returns every per-form grant.
func (s *Service) ListGrants(ctx context.Context, id uuid.UUID) ([]Grant, error) {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT id,user_id,capability FROM form_grants
		WHERE data_source_id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type grantRow struct {
		grant    Grant
		dangling bool
	}
	listed := []grantRow{}
	for rows.Next() {
		var item grantRow
		var capability string
		if err := rows.Scan(&item.grant.ID, &item.grant.UserID, &capability); err != nil {
			return nil, err
		}
		item.grant.Capability = Capability(capability)
		user, err := s.host.Users.Get(ctx, item.grant.UserID)
		if errors.Is(err, plugin.ErrNotFound) {
			item.dangling = true
		} else if err != nil {
			return nil, err
		} else {
			item.grant.UserName = user.Name
		}
		listed = append(listed, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Preserve the historical order: grants whose user is gone sort last,
	// then by user name, then by capability.
	sort.SliceStable(listed, func(i, j int) bool {
		if listed[i].dangling != listed[j].dangling {
			return listed[j].dangling
		}
		if listed[i].grant.UserName != listed[j].grant.UserName {
			return listed[i].grant.UserName < listed[j].grant.UserName
		}
		return listed[i].grant.Capability < listed[j].grant.Capability
	})
	grants := make([]Grant, 0, len(listed))
	for _, item := range listed {
		grants = append(grants, item.grant)
	}
	return grants, nil
}

// SetGrant adds a capability grant for a user (idempotent).
func (s *Service) SetGrant(ctx context.Context, id, actor uuid.UUID, in GrantInput) (Grant, error) {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return Grant{}, err
	}
	if !validCapabilities[in.Capability] {
		return Grant{}, fmt.Errorf("%w: unknown capability", ErrValidation)
	}
	if _, err := s.host.Users.Get(ctx, in.UserID); errors.Is(err, plugin.ErrNotFound) {
		return Grant{}, fmt.Errorf("%w: user does not exist", ErrValidation)
	} else if err != nil {
		return Grant{}, err
	}
	grantID := uuid.New()
	err := s.db.QueryRow(ctx, `INSERT INTO form_grants(id,data_source_id,user_id,capability,granted_by)
		VALUES($1,$2,$3,$4,$5)
		ON CONFLICT(data_source_id,user_id,capability) DO UPDATE SET granted_by=EXCLUDED.granted_by
		RETURNING id`, grantID, id, in.UserID, string(in.Capability), actor).Scan(&grantID)
	if err != nil {
		return Grant{}, err
	}
	s.auditBestEffort(ctx, actor, "form.grant_set", id.String(),
		map[string]any{"user": in.UserID.String(), "capability": string(in.Capability)})
	return Grant{ID: grantID, UserID: in.UserID, UserName: s.userName(ctx, in.UserID), Capability: in.Capability}, nil
}

// SearchUsers returns a bounded, manager-safe directory of active users for granting form access. It
// exposes only id, name, username, and global role — never credentials, activity, or timestamps —
// and is authorized per-form (a form manager), not via the Owner/Admin-only user administration API.
func (s *Service) SearchUsers(ctx context.Context, query string, limit int) ([]DirectoryUser, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	found, err := s.host.Users.SearchActive(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	users := make([]DirectoryUser, 0, len(found))
	for _, user := range found {
		users = append(users, DirectoryUser{ID: user.ID, Name: user.Name, Username: user.Username, Role: user.Role})
	}
	return users, nil
}

// collapseCapabilities reduces a requested capability set to its minimal generating set by dropping
// implied capabilities (manage implies everything; approve⇒review⇒view_all⇒view_own; submit is
// independent), so redundant implied grants are never stored or shown separately.
func collapseCapabilities(caps []Capability) []Capability {
	set := map[Capability]bool{}
	for _, capability := range caps {
		if validCapabilities[capability] {
			set[capability] = true
		}
	}
	if set[CapManage] {
		return []Capability{CapManage}
	}
	result := []Capability{}
	switch {
	case set[CapApprove]:
		result = append(result, CapApprove)
	case set[CapReview]:
		result = append(result, CapReview)
	case set[CapViewAll]:
		result = append(result, CapViewAll)
	case set[CapViewOwn]:
		result = append(result, CapViewOwn)
	}
	if set[CapSubmit] {
		result = append(result, CapSubmit)
	}
	return result
}

func containsCap(caps []Capability, want Capability) bool {
	for _, capability := range caps {
		if capability == want {
			return true
		}
	}
	return false
}

// ReplaceGrants atomically replaces one user's grants on a form with the collapsed capability set,
// auditing the change in the same transaction (all-or-nothing). The form creator is always an
// implicit manager and cannot have grants edited here. A user cannot remove their own only path to
// managing the form (unless they retain it as the creator or a global Owner).
func (s *Service) ReplaceGrants(ctx context.Context, id, actor, targetUser uuid.UUID, caps []Capability) ([]AccessEntry, error) {
	createdBy, err := s.ensureForm(ctx, id)
	if err != nil {
		return nil, err
	}
	if createdBy != nil && *createdBy == targetUser {
		return nil, fmt.Errorf("%w: the form creator is always a manager and cannot be changed here", ErrValidation)
	}
	target, err := s.host.Users.Get(ctx, targetUser)
	if errors.Is(err, plugin.ErrNotFound) {
		return nil, fmt.Errorf("%w: user does not exist", ErrValidation)
	} else if err != nil {
		return nil, err
	}
	if target.Role == "owner" {
		return nil, fmt.Errorf("%w: global Owners are always managers and cannot be changed here", ErrValidation)
	}
	for _, capability := range caps {
		if !validCapabilities[capability] {
			return nil, fmt.Errorf("%w: unknown capability %q", ErrValidation, capability)
		}
	}
	collapsed := collapseCapabilities(caps)

	// Guard against a manager removing their own last management path.
	if targetUser == actor && !containsCap(collapsed, CapManage) {
		isCreator := createdBy != nil && *createdBy == actor
		role, roleErr := s.userGlobalRole(ctx, actor)
		if roleErr != nil {
			return nil, roleErr
		}
		if !isCreator && role != "owner" {
			return nil, fmt.Errorf("%w: you cannot remove your own management access to this form", ErrValidation)
		}
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `DELETE FROM form_grants WHERE data_source_id=$1 AND user_id=$2`, id, targetUser); err != nil {
		return nil, err
	}
	for _, capability := range collapsed {
		if _, err := tx.Exec(ctx, `INSERT INTO form_grants(id,data_source_id,user_id,capability,granted_by)
			VALUES($1,$2,$3,$4,$5)`, uuid.New(), id, targetUser, string(capability), actor); err != nil {
			return nil, err
		}
	}
	if err := s.recordAudit(ctx, tx, actor, "form.grants_replaced", id.String(),
		map[string]any{"user": targetUser.String(), "capabilities": strings.Join(capabilityStrings(collapsed), ",")}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.ListAccess(ctx, id)
}

func capabilityStrings(caps []Capability) []string {
	out := make([]string, 0, len(caps))
	for _, capability := range caps {
		out = append(out, string(capability))
	}
	return out
}

// ListAccess returns one row per user with effective access to the form: the creator and every
// active global Owner as implicit managers, followed by granted users with collapsed capabilities.
func (s *Service) ListAccess(ctx context.Context, id uuid.UUID) ([]AccessEntry, error) {
	createdBy, err := s.ensureForm(ctx, id)
	if err != nil {
		return nil, err
	}
	entries := []AccessEntry{}
	seen := map[uuid.UUID]bool{}
	if createdBy != nil {
		var entry AccessEntry
		entry.UserID = *createdBy
		if user, err := s.host.Users.Get(ctx, *createdBy); err == nil {
			entry.Name, entry.Username, entry.Role = user.Name, user.Username, user.Role
		} else if !errors.Is(err, plugin.ErrNotFound) {
			return nil, err
		}
		entry.Capabilities = []Capability{CapManage}
		entry.IsCreator = true
		entry.IsGlobalOwner = entry.Role == "owner"
		entries = append(entries, entry)
		seen[*createdBy] = true
	}
	owners, err := s.host.Users.ListByRole(ctx, "owner")
	if err != nil {
		return nil, err
	}
	for _, owner := range owners {
		if seen[owner.ID] {
			continue
		}
		entries = append(entries, AccessEntry{
			UserID: owner.ID, Name: owner.Name, Username: owner.Username, Role: owner.Role,
			Capabilities: []Capability{CapManage}, IsGlobalOwner: true,
		})
		seen[owner.ID] = true
	}
	rows, err := s.db.Query(ctx, `SELECT user_id,capability FROM form_grants
		WHERE data_source_id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type grantName struct {
		name, username, role string
		dangling             bool
	}
	byUser := map[uuid.UUID]*AccessEntry{}
	names := map[uuid.UUID]grantName{}
	order := []uuid.UUID{}
	for rows.Next() {
		var userID uuid.UUID
		var capability string
		if err := rows.Scan(&userID, &capability); err != nil {
			return nil, err
		}
		if seen[userID] {
			continue // an implicit creator/Owner manager row already covers them
		}
		entry, ok := byUser[userID]
		if !ok {
			entry = &AccessEntry{UserID: userID, Capabilities: []Capability{}}
			byUser[userID] = entry
			order = append(order, userID)
			if user, err := s.host.Users.Get(ctx, userID); err == nil {
				names[userID] = grantName{name: user.Name, username: user.Username, role: user.Role}
			} else if errors.Is(err, plugin.ErrNotFound) {
				names[userID] = grantName{dangling: true}
			} else {
				return nil, err
			}
		}
		entry.Capabilities = append(entry.Capabilities, Capability(capability))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Preserve the historical order: grants whose user is gone sort last,
	// then by user name, then by user id. Capabilities collapse per user.
	granted := make([]AccessEntry, 0, len(order))
	for _, userID := range order {
		entry := byUser[userID]
		known := names[userID]
		entry.Name, entry.Username, entry.Role = known.name, known.username, known.role
		entry.Capabilities = collapseCapabilities(entry.Capabilities)
		granted = append(granted, *entry)
	}
	sort.SliceStable(granted, func(i, j int) bool {
		if names[granted[i].UserID].dangling != names[granted[j].UserID].dangling {
			return names[granted[j].UserID].dangling
		}
		if granted[i].Name != granted[j].Name {
			return granted[i].Name < granted[j].Name
		}
		return granted[i].UserID.String() < granted[j].UserID.String()
	})
	return append(entries, granted...), nil
}

// RevokeGrant removes one grant by id.
func (s *Service) RevokeGrant(ctx context.Context, id, grantID, actor uuid.UUID) error {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM form_grants WHERE id=$1 AND data_source_id=$2`, grantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.auditBestEffort(ctx, actor, "form.grant_revoked", id.String(), nil)
	return nil
}
