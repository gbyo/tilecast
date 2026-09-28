package httpapi

import (
	"errors"
	"net/http"

	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
)

type patRequest struct {
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	ExpiresIn int      `json:"expiresInDays"`
}

// createPAT mints a named personal access token for the caller. The
// plaintext secret is returned exactly once in this response; the list
// and grant endpoints never reveal it again.
func (s *server) createPAT(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	var body patRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	secret, pat, err := s.oauth.CreatePAT(r.Context(), principal.User.ID, body.Name, body.Scopes, body.ExpiresIn)
	if err != nil {
		switch {
		case errors.Is(err, oauth.ErrBadPATName):
			writeError(w, http.StatusBadRequest, "invalid_name", "Give the token a name up to 100 characters.")
		case errors.Is(err, oauth.ErrBadPATLifetime):
			writeError(w, http.StatusBadRequest, "invalid_lifetime", "Lifetime must be one of 7, 30, 90, or 365 days. Tokens always expire.")
		default:
			writeOAuthError(w, err)
		}
		return
	}
	_ = audit.Record(r.Context(), s.db, audit.Event{
		Action: "oauth.pat_created", ResourceType: "oauth_grant", ResourceID: pat.ID.String(),
		ResourceName: pat.Name, Summary: "Created a personal access token",
		Metadata: map[string]any{"scopes": pat.Scopes, "expiresAt": pat.ExpiresAt},
	})
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{
		"token": secret,
		"pat":   renderPAT(pat),
	}})
}

// listPATs shows the caller's personal access tokens, expired and revoked
// included until explicitly revoked, with display metadata only. An
// optional search query filters by name.
func (s *server) listPATs(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	pats, err := s.oauth.ListPATs(r.Context(), principal.User.ID, r.URL.Query().Get("search"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	rendered := make([]map[string]any, 0, len(pats))
	for _, pat := range pats {
		rendered = append(rendered, renderPAT(pat))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"pats": rendered}})
}

func renderPAT(pat oauth.PAT) map[string]any {
	return map[string]any{
		"id": pat.ID, "name": pat.Name, "scopes": pat.Scopes,
		"createdAt": pat.CreatedAt, "expiresAt": pat.ExpiresAt,
		"lastUsedAt": pat.LastUsedAt, "revokedAt": pat.RevokedAt,
	}
}
