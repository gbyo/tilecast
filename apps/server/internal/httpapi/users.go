package httpapi

import (
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

var managedUsernamePattern = regexp.MustCompile(`^[a-zA-Z0-9._@+-]{3,254}$`)

// sortedManagedRoles keeps the validation message in step with the set, so a
// new role cannot be accepted while the error still lists the old ones.
func sortedManagedRoles() []string {
	out := make([]string, 0, len(managedRoles))
	for role := range managedRoles {
		out = append(out, role)
	}
	sort.Strings(out)
	return out
}

var managedRoles = map[string]bool{
	"owner":         true,
	"administrator": true,
	"editor":        true,
	"contributor":   true,
	"viewer":        true,
}

type managedUserInput struct {
	Name     string `json:"name"`
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
	Active   *bool  `json:"active,omitempty"`
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
	if !canManageRole(actor.Role, body.Role) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Only an Owner may create Owner or Administrator accounts.")
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
	if !canManageRole(actor.Role, target.Role) || !canManageRole(actor.Role, body.Role) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Only an Owner may manage Owner or Administrator accounts.")
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
	if target.Role == "owner" && (body.Role != "owner" || !active) {
		var owners int
		if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM users WHERE role='owner' AND active=TRUE`).Scan(&owners); err != nil {
			s.internalError(w, r, err)
			return
		}
		if owners <= 1 {
			writeError(w, http.StatusConflict, "last_owner_required", "Tilecast must keep at least one active Owner account.")
			return
		}
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
		if _, err := tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id=$1`, id); err != nil {
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
	if !canManageRole(actor.Role, target.Role) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Only an Owner may manage Owner or Administrator accounts.")
		return
	}
	if target.Role == "owner" && target.Active {
		var owners int
		if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM users WHERE role='owner' AND active=TRUE`).Scan(&owners); err != nil {
			s.internalError(w, r, err)
			return
		}
		if owners <= 1 {
			writeError(w, http.StatusConflict, "last_owner_required", "Tilecast must keep at least one active Owner account.")
			return
		}
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if _, err := tx.Exec(r.Context(), `UPDATE users SET active=FALSE WHERE id=$1`, id); err != nil {
		s.internalError(w, r, err)
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id=$1`, id); err != nil {
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
	if !canManageRole(actor.Role, target.Role) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Only an Owner may manage Owner or Administrator accounts.")
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
	if !managedRoles[input.Role] {
		return errors.New("role must be " + strings.Join(sortedManagedRoles(), ", "))
	}
	if requirePassword || input.Password != "" {
		if len(input.Password) < 12 || len(input.Password) > 1024 {
			return errors.New("password must be between 12 and 1024 characters")
		}
	}
	return nil
}

func canManageRole(actorRole, targetRole string) bool {
	if actorRole == "owner" {
		return true
	}
	return actorRole == "administrator" &&
		(targetRole == "editor" || targetRole == "contributor" || targetRole == "viewer")
}

func uniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// Screen scopes narrow which screens an account may operate on. They are
// managed alongside the account itself, under the same role hierarchy that
// governs editing it, so nobody can widen their own reach.

func (s *server) getUserScreenScopes(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	scopes, err := s.devices.ScopesFor(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"scopes": scopes,
		// An empty list means the whole fleet, which is worth saying out loud
		// rather than leaving a reader to infer from an empty table.
		"wholeFleet": len(scopes) == 0,
	}})
}

func (s *server) putUserScreenScopes(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Scopes []devices.Scope `json:"scopes"`
	}
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
		// Otherwise a scoped administrator could simply widen themselves.
		writeError(w, http.StatusForbidden, "cannot_scope_self",
			"You cannot change your own screen scope.")
		return
	}
	var target struct{ Role string }
	if err := s.db.QueryRow(r.Context(),
		`SELECT role FROM users WHERE id=$1`, id).Scan(&target.Role); err != nil {
		writeError(w, http.StatusNotFound, "user_not_found", "That account no longer exists.")
		return
	}
	if !canManageRole(actor.Role, target.Role) {
		writeError(w, http.StatusForbidden, "forbidden", "You may not change that account.")
		return
	}
	if target.Role == "owner" {
		// An installation must not be able to lock itself out of its own fleet.
		writeError(w, http.StatusUnprocessableEntity, "owner_not_scopable",
			"An Owner always reaches every screen.")
		return
	}
	if err := s.devices.ReplaceScopes(r.Context(), actor.ID, id, body.Scopes); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "scope_invalid", err.Error())
		return
	}
	s.getUserScreenScopes(w, r)
}
