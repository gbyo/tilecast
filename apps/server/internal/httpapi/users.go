package httpapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

var managedUsernamePattern = regexp.MustCompile(`^[a-zA-Z0-9._@+-]{3,254}$`)

type managedUserInput struct {
	Name     string `json:"name"`
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
	Active   *bool  `json:"active,omitempty"`
	// ContentAccess sets the new account's Media library policy. It is
	// accepted on creation only; later changes use the content-access
	// endpoint. When omitted, the account receives the creator's own modes
	// with no grants: the whole library from an unrestricted creator, and
	// nothing from a restricted one.
	ContentAccess *media.ContentAccessInput `json:"contentAccess,omitempty"`
	// ScreenAccess sets the new account's screen-access policy. It is
	// accepted on creation only; later changes use the screen-scopes
	// endpoint. When omitted, the account reaches no screen: an API caller
	// that forgets the policy must not create a fleet-wide account.
	ScreenAccess *screenAccessInput `json:"screenAccess,omitempty"`
}

// canManageAccount reports whether principal may manage an account that holds
// role, or place an account on it. It needs users.manage, and the role must be
// one the principal may delegate: the Owner may manage anyone, nobody else
// may manage the protected Owner and Administrator identities, and a role is
// otherwise manageable only when it grants nothing the principal could not
// grant themselves.
func (s *server) canManageAccount(ctx context.Context, principal auth.Principal, role string) (bool, error) {
	if !principal.Can(auth.CapUsersManage) {
		return false, nil
	}
	capabilities, err := s.auth.ResolveCapabilities(ctx, role)
	if err != nil {
		return false, err
	}
	return principal.Delegator().CanAssignRole(role, capabilities), nil
}

// roleExists reports whether key names a role.
func (s *server) roleExists(ctx context.Context, key string) (bool, error) {
	if _, err := s.auth.GetRole(ctx, key); err != nil {
		if errors.Is(err, auth.ErrRoleNotFound) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (s *server) createUser(w http.ResponseWriter, r *http.Request) {
	var body managedUserInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Username = strings.ToLower(strings.TrimSpace(body.Username))
	body.Role = strings.ToLower(strings.TrimSpace(body.Role))
	if err := validateManagedUser(body, true); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := principal.User
	if exists, err := s.roleExists(r.Context(), body.Role); err != nil {
		s.internalError(w, r, err)
		return
	} else if !exists {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", "role must be an existing role")
		return
	}
	if allowed, err := s.canManageAccount(r.Context(), principal, body.Role); err != nil {
		s.internalError(w, r, err)
		return
	} else if !allowed {
		writeError(w, http.StatusForbidden, "insufficient_role", "You cannot assign that role. Only an Owner may assign the Owner or Administrator role or a role with more authority than your own.")
		return
	}
	actorAccess, err := s.contentAccess(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	contentAccess := media.ContentAccessInput{LibraryMode: modeName(actorAccess.LibraryAll), TagMode: modeName(actorAccess.TagsAll)}
	if body.ContentAccess != nil {
		contentAccess = *body.ContentAccess
	}
	screenAccess := authz.PolicyInput{Mode: authz.ModeRestricted, Grants: []authz.Grant{}}
	if body.ScreenAccess != nil {
		screenAccess = body.ScreenAccess.policy()
	}
	if body.Role == auth.RoleOwner {
		// An Owner always reaches every screen; the stored row only keeps
		// the account well defined if it is ever moved to another role.
		screenAccess = authz.PolicyInput{Mode: authz.ModeAll, Grants: []authz.Grant{}}
	}
	if err := screenAccess.Validate(); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "scope_invalid", strings.TrimPrefix(err.Error(), authz.ErrPolicyInvalid.Error()+": "))
		return
	}
	if !s.screenAccessDelegable(w, r, principal, screenAccess) {
		return
	}
	passwordHash, err := auth.HashPassword(body.Password)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	user := auth.User{
		ID:       uuid.New(),
		Name:     body.Name,
		Username: body.Username,
		Role:     body.Role,
		Active:   body.Active == nil || *body.Active,
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO users(id,name,username,password_hash,role,active)
		VALUES($1,$2,$3,$4,$5,$6)
		RETURNING created_at`, user.ID, user.Name, user.Username, passwordHash, user.Role, user.Active,
	).Scan(&user.CreatedAt); err != nil {
		if uniqueViolation(err) {
			writeError(w, http.StatusConflict, "username_exists", "That username is already in use.")
			return
		}
		s.internalError(w, r, err)
		return
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,'user.created','user',$3,jsonb_build_object('role',$4::text))`,
		uuid.New(), actor.ID, user.ID.String(), user.Role,
	)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// Every account is created with an explicit content policy in the same
	// transaction, so no account ever exists in the "no policy" state.
	if err := media.ReplaceContentAccessTx(r.Context(), tx, actor.ID, actorAccess, user.ID, contentAccess); err != nil {
		s.writeContentAccessError(w, r, err)
		return
	}
	// Screen access is written in the same transaction, so a new account is
	// never observable with broader screen access than requested.
	if err := authz.ReplacePolicyTx(r.Context(), tx, actor.ID, user.ID, screenAccess); err != nil {
		s.writeScreenAccessError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": user})
}

func (s *server) updateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body managedUserInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Username = strings.ToLower(strings.TrimSpace(body.Username))
	body.Role = strings.ToLower(strings.TrimSpace(body.Role))
	if err := validateManagedUser(body, false); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := principal.User
	target, err := s.readManagedUser(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "user_not_found", "The user account was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if exists, err := s.roleExists(r.Context(), body.Role); err != nil {
		s.internalError(w, r, err)
		return
	} else if !exists {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", "role must be an existing role")
		return
	}
	if actor.ID == target.ID && body.Role != target.Role && !principal.IsOwner() {
		writeError(w, http.StatusForbidden, "cannot_change_own_role", "You cannot change your own role.")
		return
	}
	if !s.canManageBoth(w, r, principal, target.Role, body.Role) {
		return
	}
	active := target.Active
	if body.Active != nil {
		active = *body.Active
	}
	if actor.ID == target.ID && !active {
		writeError(w, http.StatusConflict, "cannot_deactivate_self", "You cannot deactivate your own account.")
		return
	}
	var passwordHash *string
	var passwordValue any
	if body.Password != "" {
		hash, err := auth.HashPassword(body.Password)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		passwordHash = &hash
		passwordValue = hash
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if err := lockActiveOwnerInvariant(r.Context(), tx); err != nil {
		s.internalError(w, r, err)
		return
	}
	lastOwner, err := removesLastActiveOwner(r.Context(), tx, id, body.Role != auth.RoleOwner || !active)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if lastOwner {
		writeError(w, http.StatusConflict, "last_owner_required", "Tilecast must keep at least one active Owner account.")
		return
	}
	var updated auth.User
	err = tx.QueryRow(r.Context(), `
		UPDATE users SET
			name=$2,
			username=$3,
			role=$4,
			active=$5,
			password_hash=COALESCE($6,password_hash)
		WHERE id=$1
		RETURNING id,name,username,role,active,created_at,last_login_at`,
		id, body.Name, body.Username, body.Role, active, passwordValue,
	).Scan(&updated.ID, &updated.Name, &updated.Username, &updated.Role, &updated.Active, &updated.CreatedAt, &updated.LastLoginAt)
	if err != nil {
		if uniqueViolation(err) {
			writeError(w, http.StatusConflict, "username_exists", "That username is already in use.")
			return
		}
		s.internalError(w, r, err)
		return
	}
	if !active || passwordHash != nil {
		if err := auth.RevokeUserSessions(r.Context(), tx, id); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,'user.updated','user',$3,jsonb_build_object('role',$4::text,'active',$5::boolean,'passwordChanged',$6::boolean))`,
		uuid.New(), actor.ID, id.String(), updated.Role, updated.Active, passwordHash != nil,
	)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": updated})
}

// lockActiveOwnerInvariant serializes every write that can remove an active
// Owner. Without it, two requests can each count another Owner before either
// commits, and both can commit.
func lockActiveOwnerInvariant(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.users.active-owner'))`)
	return err
}

// removesLastActiveOwner reports whether the write would leave no active Owner.
// The check reads the current row inside the locked transaction, so it does not
// depend on any state read before the transaction began.
func removesLastActiveOwner(ctx context.Context, tx pgx.Tx, id uuid.UUID, removesAccess bool) (bool, error) {
	if !removesAccess {
		return false, nil
	}
	var targetIsOwner, otherOwnerExists bool
	err := tx.QueryRow(ctx, `
		SELECT
			EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='owner' AND active=TRUE),
			EXISTS(SELECT 1 FROM users WHERE id<>$1 AND role='owner' AND active=TRUE)`,
		id,
	).Scan(&targetIsOwner, &otherOwnerExists)
	if err != nil {
		return false, err
	}
	return targetIsOwner && !otherOwnerExists, nil
}

func (s *server) deleteUser(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := principal.User
	if actor.ID == id {
		writeError(w, http.StatusConflict, "cannot_deactivate_self", "You cannot deactivate your own account.")
		return
	}
	target, err := s.readManagedUser(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "user_not_found", "The user account was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !s.canManageBoth(w, r, principal, target.Role, target.Role) {
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if err := lockActiveOwnerInvariant(r.Context(), tx); err != nil {
		s.internalError(w, r, err)
		return
	}
	lastOwner, err := removesLastActiveOwner(r.Context(), tx, id, true)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if lastOwner {
		writeError(w, http.StatusConflict, "last_owner_required", "Tilecast must keep at least one active Owner account.")
		return
	}
	if _, err := tx.Exec(r.Context(), `UPDATE users SET active=FALSE WHERE id=$1`, id); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := auth.RevokeUserSessions(r.Context(), tx, id); err != nil {
		s.internalError(w, r, err)
		return
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)
		VALUES($1,$2,'user.deactivated','user',$3)`, uuid.New(), actor.ID, id.String())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) permanentlyDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := principal.User
	if actor.ID == id {
		writeError(w, http.StatusConflict, "cannot_delete_self", "You cannot permanently delete your own account.")
		return
	}
	target, err := s.readManagedUser(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "user_not_found", "The user account was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !s.canManageBoth(w, r, principal, target.Role, target.Role) {
		return
	}
	if target.Active {
		writeError(w, http.StatusConflict, "deactivate_user_first", "Deactivate the account before permanently deleting it.")
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if _, err = tx.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,'user.deleted','user',$3,jsonb_build_object('role',$4::text))`,
		uuid.New(), actor.ID, id.String(), target.Role,
	); err != nil {
		s.internalError(w, r, err)
		return
	}
	command, err := tx.Exec(r.Context(), `DELETE FROM users WHERE id=$1 AND active=FALSE`, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if command.RowsAffected() != 1 {
		writeError(w, http.StatusConflict, "user_state_changed", "The account changed before it could be deleted. Refresh and try again.")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) readManagedUser(r *http.Request, id uuid.UUID) (auth.User, error) {
	var user auth.User
	err := s.db.QueryRow(r.Context(), `
		SELECT id,name,username,role,active,created_at,last_login_at FROM users WHERE id=$1`, id,
	).Scan(&user.ID, &user.Name, &user.Username, &user.Role, &user.Active, &user.CreatedAt, &user.LastLoginAt)
	return user, err
}

func validateManagedUser(input managedUserInput, requirePassword bool) error {
	if len(input.Name) < 2 || len(input.Name) > 120 {
		return errors.New("name must be between 2 and 120 characters")
	}
	if !managedUsernamePattern.MatchString(input.Username) {
		return errors.New("username must be 3 to 254 characters and contain only letters, numbers, or . _ @ + -")
	}
	if input.Role == "" {
		return errors.New("role is required")
	}
	if !requirePassword && input.ScreenAccess != nil {
		return errors.New("screen access is set with the screen-scopes endpoint after creation")
	}
	if requirePassword || input.Password != "" {
		if len(input.Password) < 12 || len(input.Password) > 1024 {
			return errors.New("password must be between 12 and 1024 characters")
		}
	}
	return nil
}

// canManageBoth checks that principal may manage an account on its current
// role and on the role it is moving to. It returns false when it has already
// written the response.
func (s *server) canManageBoth(w http.ResponseWriter, r *http.Request, principal auth.Principal, current, next string) bool {
	for _, role := range []string{current, next} {
		allowed, err := s.canManageAccount(r.Context(), principal, role)
		if err != nil {
			s.internalError(w, r, err)
			return false
		}
		if !allowed {
			writeError(w, http.StatusForbidden, "insufficient_role", "You cannot manage that account. Only an Owner may manage Owner or Administrator accounts or roles with more authority than your own.")
			return false
		}
	}
	return true
}

func uniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// Screen access is an explicit per-account policy: all screens, or the
// union of granted locations and Display Groups. It is managed alongside the
// account itself, under the same role hierarchy that governs editing it, so
// nobody can widen their own reach.

// screenAccessInput is the wire shape of a policy.
type screenAccessInput struct {
	Mode   string        `json:"mode"`
	Scopes []authz.Grant `json:"scopes"`
}

func (input screenAccessInput) policy() authz.PolicyInput {
	grants := input.Scopes
	if grants == nil {
		grants = []authz.Grant{}
	}
	return authz.PolicyInput{Mode: input.Mode, Grants: grants}
}

func (s *server) getUserScreenScopes(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	policy, err := authz.PolicyFor(r.Context(), s.db, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"mode":       policy.Mode,
		"scopes":     policy.Grants,
		"configured": policy.Configured,
		// Deprecated: read mode. Kept for older clients; it is derived from
		// the stored mode, never from the number of grants.
		"wholeFleet": policy.Configured && policy.Mode == authz.ModeAll,
	}})
}

func (s *server) putUserScreenScopes(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body screenAccessInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := principal.User
	if actor.ID == id {
		// Otherwise a restricted administrator could simply widen themselves.
		writeError(w, http.StatusForbidden, "cannot_scope_self",
			"You cannot change your own screen access.")
		return
	}
	if body.Mode == "" {
		// The old contract read an empty list as the whole fleet. Guessing
		// the mode now could widen an account, so it must be stated.
		writeError(w, http.StatusUnprocessableEntity, "screen_access_mode_required",
			"Choose all screens or restricted access.")
		return
	}
	var target struct{ Role string }
	if err := s.db.QueryRow(r.Context(),
		`SELECT role FROM users WHERE id=$1`, id).Scan(&target.Role); err != nil {
		writeError(w, http.StatusNotFound, "user_not_found", "That account no longer exists.")
		return
	}
	if allowed, err := s.canManageAccount(r.Context(), principal, target.Role); err != nil {
		s.internalError(w, r, err)
		return
	} else if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You may not change that account.")
		return
	}
	if target.Role == auth.RoleOwner {
		// An installation must not be able to lock itself out of its own fleet.
		writeError(w, http.StatusUnprocessableEntity, "owner_not_scopable",
			"An Owner always reaches every screen.")
		return
	}
	policy := body.policy()
	if err := policy.Validate(); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "scope_invalid", strings.TrimPrefix(err.Error(), authz.ErrPolicyInvalid.Error()+": "))
		return
	}
	if !s.screenAccessDelegable(w, r, principal, policy) {
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if err := authz.ReplacePolicyTx(r.Context(), tx, actor.ID, id, policy); err != nil {
		s.writeScreenAccessError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.getUserScreenScopes(w, r)
}

// screenAccessDelegable keeps a restricted administrator from granting more
// of the fleet than they reach themselves. It returns false when it has
// already written the response.
func (s *server) screenAccessDelegable(w http.ResponseWriter, r *http.Request, principal auth.Principal, policy authz.PolicyInput) bool {
	err := s.authorizer().Delegable(r.Context(), authz.ActorFor(principal), policy)
	switch {
	case err == nil:
		return true
	case errors.Is(err, authz.ErrDelegation) && policy.Mode == authz.ModeAll:
		writeError(w, http.StatusForbidden, "screen_scope_delegation", "You cannot grant all screens because your own screen access is restricted.")
	case errors.Is(err, authz.ErrDelegation):
		writeError(w, http.StatusForbidden, "screen_scope_delegation", "You can grant only locations and Display Groups granted to you directly.")
	default:
		s.internalError(w, r, err)
	}
	return false
}

func (s *server) writeScreenAccessError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, authz.ErrPolicyInvalid) {
		writeError(w, http.StatusUnprocessableEntity, "scope_invalid", strings.TrimPrefix(err.Error(), authz.ErrPolicyInvalid.Error()+": "))
		return
	}
	s.internalError(w, r, err)
}
