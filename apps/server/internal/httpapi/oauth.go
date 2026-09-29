package httpapi

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
)

// oauthAuthorize describes one approval request for the dashboard approval
// screen. It stores nothing: approval revalidates the same parameters.
func (s *server) oauthAuthorize(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	req, err := s.oauth.ValidateAuthorize(r.Context(),
		query.Get("client_id"), query.Get("redirect_uri"), query.Get("scope"),
		query.Get("state"), query.Get("code_challenge"), query.Get("code_challenge_method"))
	if err != nil {
		writeOAuthError(w, err)
		return
	}
	scopes := make([]map[string]string, 0, len(req.Scopes))
	for _, scope := range req.Scopes {
		scopes = append(scopes, map[string]string{"scope": scope, "description": oauth.Scopes[scope]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"client":      map[string]any{"name": req.DisplayName, "clientId": req.ClientID},
		"scopes":      scopes,
		"redirectUri": req.RedirectURI,
		"state":       req.State,
	}})
}

type oauthDecision struct {
	Client    string `json:"client"`
	Redirect  string `json:"redirectUri"`
	Scope     string `json:"scope"`
	State     string `json:"state"`
	Challenge string `json:"challenge"`
	Method    string `json:"method"`
}

// oauthApprove records the grant and returns the loopback redirect carrying
// the single-use code. The approval screen posts the exact parameters it
// displayed, so approval cannot drift from what the user saw.
func (s *server) oauthApprove(w http.ResponseWriter, r *http.Request) {
	var body oauthDecision
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	req, err := s.oauth.ValidateAuthorize(r.Context(), body.Client, body.Redirect, body.Scope, body.State, body.Challenge, body.Method)
	if err != nil {
		writeOAuthError(w, err)
		return
	}
	code, err := s.oauth.Approve(r.Context(), principal.User.ID, req)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	_ = audit.Record(r.Context(), s.db, audit.Event{
		Action: "oauth.grant_created", ResourceType: "oauth_grant", ResourceName: req.DisplayName,
		Summary:  "Authorized " + req.DisplayName,
		Metadata: map[string]any{"scopes": req.Scopes},
	})
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"redirectUri": oauthRedirect(req.RedirectURI, map[string]string{"code": code, "state": req.State, "iss": authorizationIssuer(r)}),
	}})
}

// oauthDeny answers the client with access_denied without recording a grant.
func (s *server) oauthDeny(w http.ResponseWriter, r *http.Request) {
	var body oauthDecision
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	req, err := s.oauth.ValidateAuthorize(r.Context(), body.Client, body.Redirect, body.Scope, body.State, body.Challenge, body.Method)
	if err != nil {
		writeOAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"redirectUri": oauthRedirect(req.RedirectURI, map[string]string{"error": "access_denied", "state": req.State, "iss": authorizationIssuer(r)}),
	}})
}

// authorizationIssuer identifies this server in an authorization response
// (RFC 9207 iss), so a native client that talks to many installations can
// refuse a code that another server issued. The value is the origin of the
// approval screen, which the browser reports in Origin: approval requires
// the session cookie and its CSRF token, so only a Studio page served from
// this server can make the request, and a page cannot choose its own
// Origin header. Forwarded headers are not consulted. The value is empty,
// and iss is omitted, when the request carries no usable origin.
func authorizationIssuer(r *http.Request) string {
	origin := r.Header.Get("Origin")
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" ||
		parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func oauthRedirect(base string, params map[string]string) string {
	values := url.Values{}
	for key, value := range params {
		if value != "" {
			values.Set(key, value)
		}
	}
	separator := "?"
	if urlContainsQuery(base) {
		separator = "&"
	}
	return base + separator + values.Encode()
}

func urlContainsQuery(raw string) bool {
	for _, char := range raw {
		if char == '?' {
			return true
		}
	}
	return false
}

type oauthTokenRequest struct {
	GrantType    string `json:"grant_type"`
	ClientID     string `json:"client_id"`
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	Verifier     string `json:"code_verifier"`
	RefreshToken string `json:"refresh_token"`
}

// oauthToken exchanges codes and rotates refresh tokens. It is public and
// rate-limited: PKCE is the client authentication for loopback clients.
func (s *server) oauthToken(w http.ResponseWriter, r *http.Request) {
	var body oauthTokenRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	switch body.GrantType {
	case "authorization_code":
		if body.ClientID == oauth.ClientIOS {
			writeError(w, http.StatusBadRequest, "invalid_request", "Use the iOS session endpoint for this client.")
			return
		}
		tokens, grantID, err := s.oauth.Exchange(r.Context(), body.ClientID, body.Code, body.RedirectURI, body.Verifier)
		if err != nil {
			writeOAuthTokenError(w, err)
			return
		}
		grant, err := s.oauth.GrantByID(r.Context(), grantID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		_ = audit.Record(r.Context(), s.db, audit.Event{
			Action: "oauth.token_issued", ResourceType: "oauth_grant", ResourceID: grantID.String(),
			Actor: &grant.UserID, Surface: auditSurfaceForGrant(grant.BearerKind(), grant.ClientID),
			Summary: "Exchanged an authorization code",
		})
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"access_token": tokens.AccessToken, "refresh_token": tokens.RefreshToken,
			"token_type": "Bearer", "expires_at": tokens.ExpiresAt,
		}})
	case "refresh_token":
		tokens, grantID, reused, err := s.oauth.Refresh(r.Context(), body.RefreshToken)
		if reused {
			s.recordRefreshReuse(w, r, grantID)
			return
		}
		if err != nil {
			writeOAuthTokenError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"access_token": tokens.AccessToken, "refresh_token": tokens.RefreshToken,
			"token_type": "Bearer", "expires_at": tokens.ExpiresAt,
		}})
	default:
		writeError(w, http.StatusBadRequest, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.")
	}
}

type iosSessionRequest struct {
	GrantType     string `json:"grant_type"`
	ClientID      string `json:"client_id"`
	Code          string `json:"code"`
	RedirectURI   string `json:"redirect_uri"`
	Verifier      string `json:"code_verifier"`
	RefreshToken  string `json:"refresh_token"`
	StudioSession bool   `json:"studio_session"`
}

// oauthIOSSession is the Tilecast for iOS bootstrap. One browser
// authorization gives the app two credentials for the same grant: an
// ordinary HttpOnly Studio cookie for its web view and a rotating OAuth
// credential for native API calls. The Studio session belongs to the grant,
// so revoking either ends both.
//
// authorization_code consumes the single-use PKCE code and always sets the
// cookie. refresh_token rotates a tilecast-ios refresh token, and sets a
// new cookie only when studio_session asks for one: replacing the cookie
// under a running Studio page would strand that page's CSRF token.
func (s *server) oauthIOSSession(w http.ResponseWriter, r *http.Request) {
	var body iosSessionRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.ClientID != oauth.ClientIOS {
		writeError(w, http.StatusBadRequest, "invalid_request", "An iOS authorization is required.")
		return
	}
	var tokens oauth.Tokens
	var grantID uuid.UUID
	issueSession := true
	switch body.GrantType {
	case "authorization_code":
		if body.RedirectURI != oauth.IOSRedirectURI || body.RefreshToken != "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "An iOS authorization code is required.")
			return
		}
		var err error
		tokens, grantID, err = s.oauth.Exchange(r.Context(), body.ClientID, body.Code, body.RedirectURI, body.Verifier)
		if err != nil {
			writeOAuthTokenError(w, err)
			return
		}
	case "refresh_token":
		if body.Code != "" || body.Verifier != "" || body.RedirectURI != "" || body.RefreshToken == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "An iOS refresh token is required.")
			return
		}
		var reused bool
		var err error
		tokens, grantID, reused, err = s.oauth.RefreshForClient(r.Context(), oauth.ClientIOS, body.RefreshToken)
		if reused {
			s.recordRefreshReuse(w, r, grantID)
			return
		}
		if err != nil {
			writeOAuthTokenError(w, err)
			return
		}
		issueSession = body.StudioSession
	default:
		writeError(w, http.StatusBadRequest, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.")
		return
	}
	grant, err := s.oauth.GrantByID(r.Context(), grantID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The tokens are not released until the account is known to be usable.
	// Otherwise the grant is revoked, so a failed bootstrap leaves nothing
	// behind that could be used later.
	user, err := s.activeUser(r.Context(), grant.UserID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !user.Active {
		s.revokeIOSGrant(w, r, grant)
		return
	}
	if issueSession {
		pending, err := s.enrollmentPending(r.Context(), user, s.mfaPolicy(r))
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		session, err := s.auth.IssueGrantSession(r.Context(), grant.UserID, grantID, "oauth", pending)
		if err != nil {
			s.revokeIOSGrant(w, r, grant)
			return
		}
		s.setSessionCookie(w, session)
	}
	// Routine rotation is not audited, as on the general token endpoint. A
	// refresh that starts a Studio session is.
	if body.GrantType == "authorization_code" || issueSession {
		summary := "Exchanged an iOS authorization code"
		if body.GrantType == "refresh_token" {
			summary = "Started a Studio session from the iOS credential"
		}
		_ = audit.Record(r.Context(), s.db, audit.Event{
			Action: "oauth.token_issued", ResourceType: "oauth_grant", ResourceID: grantID.String(),
			Actor: &grant.UserID, Surface: auditSurfaceForGrant(grant.BearerKind(), grant.ClientID),
			Summary: summary,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"authenticated": issueSession,
		"credential": map[string]any{
			"access_token": tokens.AccessToken, "refresh_token": tokens.RefreshToken,
			"token_type": "Bearer", "expires_at": tokens.ExpiresAt,
		},
	}})
}

// revokeIOSGrant answers an iOS bootstrap for an account that cannot sign
// in, after revoking the grant the exchange just produced.
func (s *server) revokeIOSGrant(w http.ResponseWriter, r *http.Request, grant oauth.Grant) {
	if err := s.oauth.RevokeGrant(r.Context(), grant.UserID, grant.ID); err != nil && !errors.Is(err, oauth.ErrGrantNotFound) {
		s.internalError(w, r, err)
		return
	}
	writeError(w, http.StatusUnauthorized, "authentication_required", "The account is no longer active.")
}

// recordRefreshReuse audits a replayed refresh token. The service already
// revoked its grant.
func (s *server) recordRefreshReuse(w http.ResponseWriter, r *http.Request, grantID uuid.UUID) {
	grant, err := s.oauth.GrantByID(r.Context(), grantID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	_ = audit.Record(r.Context(), s.db, audit.Event{
		Action: "oauth.reuse_detected", ResourceType: "oauth_grant", ResourceID: grantID.String(),
		Actor: &grant.UserID, Surface: auditSurfaceForGrant(grant.BearerKind(), grant.ClientID),
		Result: audit.ResultFailure, Summary: "A rotated refresh token was reused; the grant was revoked",
	})
	writeError(w, http.StatusBadRequest, "invalid_grant", "The refresh token was already used. The grant was revoked as a precaution.")
}

// oauthRevoke revokes the grant behind a presented credential.
func (s *server) oauthRevoke(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.Token == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "A token is required.")
		return
	}
	grant, err := s.oauth.RevokeCredential(r.Context(), body.Token)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_grant", "The token is unknown.")
		return
	}
	_ = audit.Record(r.Context(), s.db, audit.Event{
		Action: "oauth.grant_revoked", ResourceType: "oauth_grant", ResourceID: grant.ID.String(),
		Actor: &grant.UserID, Surface: auditSurfaceForGrant(grant.BearerKind(), grant.ClientID),
		Summary: "Revoked a grant from a presented credential",
	})
	w.WriteHeader(http.StatusNoContent)
}

// listOAuthGrants shows the caller's grants, revoked included, in the
// security self-service area.
func (s *server) listOAuthGrants(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	grants, err := s.oauth.ListGrants(r.Context(), principal.User.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	rendered := make([]map[string]any, 0, len(grants))
	for _, grant := range grants {
		rendered = append(rendered, map[string]any{
			"id": grant.ID, "client": grant.DisplayName(), "scopes": grant.Scopes,
			"createdAt": grant.CreatedAt, "lastUsedAt": grant.LastUsedAt, "revokedAt": grant.RevokedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"grants": rendered}})
}

// revokeOAuthGrant revokes one of the caller's grants and every token under it.
func (s *server) revokeOAuthGrant(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	if err := s.oauth.RevokeGrant(r.Context(), principal.User.ID, id); err != nil {
		if errors.Is(err, oauth.ErrGrantNotFound) {
			writeError(w, http.StatusNotFound, "grant_not_found", "That grant does not exist.")
			return
		}
		s.internalError(w, r, err)
		return
	}
	_ = audit.Record(r.Context(), s.db, audit.Event{
		Action: "oauth.grant_revoked", ResourceType: "oauth_grant", ResourceID: id.String(), Summary: "Revoked a grant",
	})
	w.WriteHeader(http.StatusNoContent)
}

func writeOAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, oauth.ErrUnknownClient):
		writeError(w, http.StatusBadRequest, "invalid_client", "Unknown OAuth client.")
	case errors.Is(err, oauth.ErrBadRedirect):
		writeError(w, http.StatusBadRequest, "invalid_redirect", err.Error())
	case errors.Is(err, oauth.ErrBadScope):
		writeError(w, http.StatusBadRequest, "invalid_scope", err.Error())
	case errors.Is(err, oauth.ErrBadChallenge):
		writeError(w, http.StatusBadRequest, "invalid_request", "A PKCE S256 code challenge is required.")
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", "The authorization request is not valid.")
	}
}

func writeOAuthTokenError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, oauth.ErrCodeExpired),
		errors.Is(err, oauth.ErrTokenExpired),
		errors.Is(err, oauth.ErrPKCEFailed),
		errors.Is(err, oauth.ErrClientMismatch),
		errors.Is(err, oauth.ErrRedirectMismatch):
		writeError(w, http.StatusBadRequest, "invalid_grant", "The code or refresh token is expired, used, or does not match.")
	case errors.Is(err, oauth.ErrGrantRevoked):
		writeError(w, http.StatusBadRequest, "invalid_grant", "The grant was revoked.")
	default:
		writeError(w, http.StatusBadRequest, "invalid_grant", "The token request failed.")
	}
}
