package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/integrations"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

const integrationContextKey contextKey = "integration"

// requireIntegrationToken authenticates a token and checks one scope.
//
// Integration authentication is a third, separate boundary alongside the
// dashboard cookie and the device credential. A token is never accepted as a
// session and a session is never accepted here: the scopes exist precisely so
// that this path can reach less than a signed-in person can.
func (s *server) requireIntegrationToken(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.integrations == nil {
				writeError(w, http.StatusNotFound, "not_found", "Integration tokens are unavailable.")
				return
			}
			principal, err := s.integrations.Authenticate(r.Context(), r.Header.Get("Authorization"))
			if err != nil {
				if !errors.Is(err, integrations.ErrUnauthenticated) {
					s.internalError(w, r, err)
					return
				}
				// One reason for every failure. A revoked token must not be
				// distinguishable from an unknown one.
				w.Header().Set("WWW-Authenticate", `Bearer realm="Tilecast"`)
				writeError(w, http.StatusUnauthorized, "invalid_token",
					"The integration token is missing, revoked, expired, or wrong.")
				return
			}
			if !principal.HasScope(scope) {
				writeError(w, http.StatusForbidden, "insufficient_scope",
					"This token does not have the "+scope+" capability.")
				return
			}
			next.ServeHTTP(w, r.WithContext(
				context.WithValue(r.Context(), integrationContextKey, principal)))
		})
	}
}

func integrationPrincipal(r *http.Request) integrations.Principal {
	principal, _ := r.Context().Value(integrationContextKey).(integrations.Principal)
	return principal
}

type manualRowsRequest struct {
	Rows []media.ManualRowWrite `json:"rows"`
}

// replaceDataSourceRows is the only write an integration can perform. It
// replaces the rows of one Manual Table Data Source; it cannot create or delete
// a source, and it cannot change the columns that Widgets bind to.
func (s *server) replaceDataSourceRows(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal := integrationPrincipal(r)
	if !principal.MayWrite(id) {
		// A token narrowed to specific sources gets the same answer as one with
		// no write scope at all, so the response cannot be used to discover
		// which Data Sources exist.
		writeError(w, http.StatusForbidden, "insufficient_scope",
			"This token may not write that Data Source.")
		return
	}
	var body manualRowsRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.Rows == nil {
		// An explicit empty array clears the rows; a missing field is a mistake.
		writeError(w, http.StatusBadRequest, "invalid_request",
			`Send a "rows" array. Send an empty array to clear every row.`)
		return
	}
	source, err := s.media.ReplaceManualRows(r.Context(), id, principal.ActingUser, body.Rows)
	if errors.Is(err, media.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "That Data Source no longer exists.")
		return
	}
	if errors.Is(err, media.ErrDataSourceChanged) {
		writeError(w, http.StatusConflict, "data_source_changed", "The Data Source changed while these rows were being written. Retry the request.")
		return
	}
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "rows_invalid", err.Error())
		return
	}
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,summary,metadata)
		VALUES($1,$2,'data_source.rows_replaced','data_source',$3,$4,'success',$5,$6::jsonb)`,
		uuid.New(), principal.ActingUser, id.String(), source.Name,
		"Rows replaced by an integration token",
		`{"integrationToken":"`+principal.Name+`"}`)

	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"id": source.ID, "name": source.Name, "rowCount": len(body.Rows),
		"updatedAt": source.UpdatedAt,
	}})
}

func (s *server) integrationFleetHealth(w http.ResponseWriter, r *http.Request) {
	health, err := s.integrations.Health(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": health})
}

func (s *server) integrationMetrics(w http.ResponseWriter, r *http.Request) {
	health, err := s.integrations.Health(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(health.Prometheus()))
}

// Token management is Studio-side: an integration token can never mint another
// one, which keeps the capability set from being escalated by a leaked token.

func (s *server) listIntegrationTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.integrations.List(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": tokens})
}

type integrationTokenRequest struct {
	Name          string      `json:"name"`
	Scopes        []string    `json:"scopes"`
	DataSourceIDs []uuid.UUID `json:"dataSourceIds,omitempty"`
	ExpiresAt     *time.Time  `json:"expiresAt,omitempty"`
}

func (s *server) createIntegrationToken(w http.ResponseWriter, r *http.Request) {
	var body integrationTokenRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	token, secret, err := s.integrations.Create(r.Context(), user.ID, body.Name, body.Scopes, body.DataSourceIDs, body.ExpiresAt)
	if errors.Is(err, integrations.ErrValidation) {
		writeError(w, http.StatusUnprocessableEntity, "token_invalid",
			strings.TrimPrefix(err.Error(), integrations.ErrValidation.Error()+": "))
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The secret is never logged and never placed in audit metadata.
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,summary)
		VALUES($1,$2,'integration_token.created','integration_token',$3,$4,'success',$5)`,
		uuid.New(), user.ID, token.ID.String(), token.Name,
		"Integration token created with scopes "+strings.Join(token.Scopes, ", "))

	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{
		"token": token,
		// Returned exactly once. No route reads it back.
		"secret": secret,
		"notice": "Copy this token now. Tilecast does not show it again. Anything it does is recorded as " +
			user.Name + ", and it stops working if that account is removed.",
	}})
}

func (s *server) revokeIntegrationToken(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	if err := s.integrations.Revoke(r.Context(), id); errors.Is(err, integrations.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "That token no longer exists or is already revoked.")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,summary)
		VALUES($1,$2,'integration_token.revoked','integration_token',$3,'success','Integration token revoked')`,
		uuid.New(), user.ID, id.String())
	w.WriteHeader(http.StatusNoContent)
}
