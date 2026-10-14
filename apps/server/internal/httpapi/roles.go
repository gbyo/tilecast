package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

type roleRequest struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Capabilities []string `json:"capabilities"`
}

// roleView is a role as Studio presents it: the role itself plus whether the
// caller may change it and assign it.
type roleView struct {
	auth.Role
	Editable   bool `json:"editable"`
	Assignable bool `json:"assignable"`
}

func (s *server) roleView(principal auth.Principal, role auth.Role) roleView {
	set := auth.NewCapabilitySet(role.Capabilities...)
	delegator := principal.Delegator()
	return roleView{
		Role:       role,
		Editable:   !role.Builtin && principal.Can(auth.CapRolesManage) && delegator.CanDelegate(set),
		Assignable: principal.Can(auth.CapUsersManage) && delegator.CanAssignRole(role.Key, set),
	}
}

func (s *server) listRoles(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	roles, err := s.auth.ListRoles(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	items := make([]roleView, 0, len(roles))
	for _, role := range roles {
		items = append(items, s.roleView(principal, role))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) getRole(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	role, err := s.auth.GetRole(r.Context(), chi.URLParam(r, "key"))
	if err != nil {
		s.writeRoleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.roleView(principal, role)})
}

// listCapabilities serves the closed vocabulary, with whether the caller may
// put each capability into a custom role.
func (s *server) listCapabilities(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	type capabilityView struct {
		auth.CapabilityDefinition
		Grantable bool `json:"grantable"`
	}
	delegator := principal.Delegator()
	items := []capabilityView{}
	for _, definition := range auth.CapabilityCatalog() {
		grantable := !definition.OwnerReserved && delegator.CanDelegate(auth.NewCapabilitySet(definition.Key))
		items = append(items, capabilityView{CapabilityDefinition: definition, Grantable: grantable})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) createRole(w http.ResponseWriter, r *http.Request) {
	var body roleRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	role, err := s.auth.CreateRole(r.Context(), principal.Delegator(), auth.RoleInput{Name: body.Name, Description: body.Description, Capabilities: body.Capabilities}, recordRoleChange)
	if err != nil {
		s.writeRoleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": s.roleView(principal, role)})
}

func (s *server) updateRole(w http.ResponseWriter, r *http.Request) {
	var body roleRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	role, err := s.auth.UpdateRole(r.Context(), principal.Delegator(), chi.URLParam(r, "key"), auth.RoleInput{Name: body.Name, Description: body.Description, Capabilities: body.Capabilities}, recordRoleChange)
	if err != nil {
		s.writeRoleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.roleView(principal, role)})
}

func (s *server) deleteRole(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	if err := s.auth.DeleteRole(r.Context(), principal.Delegator(), chi.URLParam(r, "key"), recordRoleChange); err != nil {
		s.writeRoleError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) writeRoleError(w http.ResponseWriter, r *http.Request, err error) {
	var validation *auth.RoleValidationError
	switch {
	case errors.As(err, &validation):
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", validation.Error())
	case errors.Is(err, auth.ErrRoleNotFound):
		writeError(w, http.StatusNotFound, "role_not_found", "The role was not found.")
	case errors.Is(err, auth.ErrRoleProtected):
		writeError(w, http.StatusConflict, "role_protected", "Built-in roles cannot be changed or deleted.")
	case errors.Is(err, auth.ErrRoleInUse):
		writeError(w, http.StatusConflict, "role_in_use", "Move every account off this role before deleting it.")
	case errors.Is(err, auth.ErrRoleNameTaken):
		writeError(w, http.StatusConflict, "role_name_taken", "Another role already uses that name.")
	case errors.Is(err, auth.ErrDelegation):
		writeError(w, http.StatusForbidden, "role_delegation", "You can grant only capabilities you hold yourself. Only an Owner may grant user or role management.")
	default:
		s.internalError(w, r, err)
	}
}

// recordRoleChange writes a role change to the shared audit path inside the
// transaction that makes it. The capabilities are the role's new set (or,
// for a deletion, the set it had).
func recordRoleChange(ctx context.Context, tx pgx.Tx, action, key string, capabilities []string) error {
	return audit.RecordTx(ctx, tx, audit.Event{
		Action: action, ResourceType: "role", ResourceID: key,
		Metadata: map[string]any{"capabilities": capabilities},
	})
}
