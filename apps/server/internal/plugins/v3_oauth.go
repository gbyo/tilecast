package plugins

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/outbound"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// OAuth 2.0 connections (docs/plugin-connections.md#oauth-20-connections).
// Tilecast is the OAuth client of an external provider here. This is a
// separate model from internal/oauth, where Tilecast is the authorization
// server for its own CLI, iOS, and MCP clients.
//
// The host runs the authorization code flow with PKCE S256. The attempt is
// a database row, so the callback can reach any Server process and survive
// a restart. Tokens and the client secret are plugin secrets owned by the
// connection. Plugin code asks http.fetch@1 to use the connection and never
// holds a token.

// OAuth statuses stored on the connection row.
const (
	OAuthNotConnected      = "not_connected"
	OAuthConnected         = "connected"
	OAuthReconnectRequired = "reconnect_required"
)

// Secret keys a connection owns.
const (
	oauthClientSecretKey = "oauth.client_secret"
	oauthAccessTokenKey  = "oauth.access_token"
	oauthRefreshTokenKey = "oauth.refresh_token"
	oauthVerifierKey     = "oauth.pkce_verifier"
)

// OAuth bounds and timings.
const (
	// oauthAttemptLifetime bounds one authorization attempt.
	oauthAttemptLifetime = 10 * time.Minute
	// oauthRefreshMargin refreshes a token this long before it expires, so a
	// request never knowingly sends an expired token.
	oauthRefreshMargin = 60 * time.Second
	// oauthTokenTimeout bounds one token or revocation request.
	oauthTokenTimeout = 20 * time.Second
	// oauthTokenResponseBytes bounds a token response.
	oauthTokenResponseBytes = 64 << 10
	// oauthRefreshBackoff is the wait after a failed refresh before the
	// host asks the provider again.
	oauthRefreshBackoff = 30 * time.Second
	maxClientIDLength   = 256
)

// Stable OAuth failure codes, for plugin code and Studio.
const (
	CodeOAuthNotConnected      = "oauth_not_connected"
	CodeOAuthReconnectRequired = "oauth_reconnect_required"
	CodeOAuthRefreshFailed     = "oauth_refresh_failed"
	// CodeOAuthAuthorizationHeader refuses a plugin-supplied Authorization
	// header on an oauth2 connection.
	CodeOAuthAuthorizationHeader = "oauth_authorization_header_refused"
)

// Reasons the Connect control is unavailable.
const (
	ConnectNeedsHTTPSPublicURL = "public_url_https_required"
	ConnectNeedsClientID       = "client_id_required"
	ConnectNeedsClientSecret   = "client_secret_required"
)

// OAuthState is the OAuth part of a connection document. It never holds a
// token or the client secret.
type OAuthState struct {
	Status               string              `json:"status"`
	ClientID             *string             `json:"clientId,omitempty"`
	ClientSecretRequired bool                `json:"clientSecretRequired"`
	ClientSecret         pluginsecrets.State `json:"clientSecret"`
	// CallbackURL is the exact redirect URI to register with the provider.
	CallbackURL      string     `json:"callbackUrl,omitempty"`
	ConnectAvailable bool       `json:"connectAvailable"`
	ConnectBlocker   string     `json:"connectUnavailableReason,omitempty"`
	AuthorizationURL string     `json:"authorizationEndpoint"`
	Scopes           []string   `json:"scopes"`
	ConnectedAt      *time.Time `json:"connectedAt,omitempty"`
	ConnectedBy      *uuid.UUID `json:"connectedBy,omitempty"`
	AccessExpiresAt  *time.Time `json:"accessExpiresAt,omitempty"`
	RefreshedAt      *time.Time `json:"refreshedAt,omitempty"`
	LastError        *string    `json:"lastError,omitempty"`
	LastErrorAt      *time.Time `json:"lastErrorAt,omitempty"`
	// Revocation is what the last disconnect learned: confirmed, failed, or
	// not_declared. Tilecast deletes its own tokens in every case.
	Revocation     *string    `json:"revocation,omitempty"`
	DisconnectedAt *time.Time `json:"disconnectedAt,omitempty"`
}

func connectionSecret(row connectionRow, key string) pluginsecrets.SecretRef {
	return pluginsecrets.SecretRef{PluginID: row.pluginID, OwnerType: pluginsecrets.OwnerConnection, OwnerID: row.id, Key: key}
}

// oauthCallbackURL derives the redirect URI from trusted configuration,
// never from a request. It is empty unless TILECAST_PUBLIC_URL is HTTPS.
func (s *Service) oauthCallbackURL(pluginID string, id uuid.UUID) string {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(s.publicURL), "/"))
	if err != nil || base.Scheme != "https" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return ""
	}
	return base.String() + "/api/v1/plugins/" + pluginID + "/connections/" + id.String() + "/callback"
}

func (s *Service) oauthState(ctx context.Context, q queryer, row connectionRow, declaration plugin.Connection) (*OAuthState, error) {
	o := declaration.OAuth
	state := &OAuthState{Status: OAuthNotConnected, ClientID: row.oauth.clientID, ClientSecretRequired: o.NeedsClientSecret(),
		ClientSecret: pluginsecrets.State("not_required"), AuthorizationURL: o.AuthorizationEndpoint, Scopes: append([]string{}, o.Scopes...),
		CallbackURL: s.oauthCallbackURL(row.pluginID, row.id), ConnectedAt: row.oauth.connectedAt, ConnectedBy: row.oauth.connectedBy,
		AccessExpiresAt: row.oauth.accessExpiresAt, RefreshedAt: row.oauth.refreshedAt, LastError: row.oauth.lastError,
		LastErrorAt: row.oauth.lastErrorAt, Revocation: row.oauth.revocation, DisconnectedAt: row.oauth.disconnectedAt}
	if row.oauth.status != nil {
		state.Status = *row.oauth.status
	}
	if state.Status == OAuthConnected && (row.oauth.fingerprint == nil || *row.oauth.fingerprint != declaration.SecurityFingerprint()) {
		// The release changed the endpoints or the scopes since the tokens
		// were granted.
		state.Status = OAuthReconnectRequired
	}
	if o.NeedsClientSecret() {
		state.ClientSecret = pluginsecrets.StateNeedsValue
		if s.secrets != nil {
			states, err := s.secrets.States(ctx, q, row.pluginID, pluginsecrets.OwnerConnection, row.id, []string{oauthClientSecretKey})
			if err != nil {
				return nil, err
			}
			state.ClientSecret = states[oauthClientSecretKey]
		}
	}
	switch {
	case state.CallbackURL == "":
		state.ConnectBlocker = ConnectNeedsHTTPSPublicURL
	case row.oauth.clientID == nil:
		state.ConnectBlocker = ConnectNeedsClientID
	case o.NeedsClientSecret() && state.ClientSecret != pluginsecrets.StateSet:
		state.ConnectBlocker = ConnectNeedsClientSecret
	}
	state.ConnectAvailable = state.ConnectBlocker == ""
	return state, nil
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func hashState(state string) string {
	sum := sha256.Sum256([]byte(state))
	return hex.EncodeToString(sum[:])
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func oauthUnavailable(reason string) error {
	return &plugin.APIError{Status: http.StatusConflict, Code: "plugin_connection_oauth_unavailable",
		Message: "This connection cannot connect yet.", Details: map[string]any{"reason": reason}}
}

func (s *Service) oauthDeclaration(pluginID string, row connectionRow) (hostedPlugin, plugin.Connection, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok {
		return hostedPlugin{}, plugin.Connection{}, ErrPluginNotFound
	}
	declaration, ok := hosted.manifest.ConnectionByID(row.definition)
	if !ok || !declaration.IsOAuth() {
		return hosted, plugin.Connection{}, invalidConnection("This connection does not use OAuth.")
	}
	return hosted, declaration, nil
}

// StartOAuth begins an authorization attempt and returns the provider URL
// Studio sends the operator to. A new attempt replaces an earlier one of
// the same connection.
func (s *Service) StartOAuth(ctx context.Context, pluginID string, id, userID uuid.UUID) (string, error) {
	if _, err := s.hostedV3(pluginID); err != nil {
		return "", err
	}
	if s.secrets == nil {
		return "", &plugin.APIError{Status: 503, Code: "secrets_unavailable", Message: "Plugin secrets are unavailable on this server."}
	}
	state, err := randomToken()
	if err != nil {
		return "", err
	}
	verifier, err := randomToken()
	if err != nil {
		return "", err
	}
	var authorization string
	_, err = s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		if err := s.lockInstallation(ctx, tx, pluginID); err != nil {
			return nil, err
		}
		row, err := s.lockConnection(ctx, tx, pluginID, id)
		if err != nil {
			return nil, err
		}
		_, declaration, err := s.oauthDeclaration(pluginID, row)
		if err != nil {
			return nil, err
		}
		current, err := s.oauthState(ctx, tx, row, declaration)
		if err != nil {
			return nil, err
		}
		if !current.ConnectAvailable {
			return nil, oauthUnavailable(current.ConnectBlocker)
		}
		if _, err := s.expireOAuthAttempts(ctx, tx); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_oauth_transactions WHERE connection_id=$1`, id); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO plugin_oauth_transactions(state_hash,connection_id,plugin_id,user_id,expires_at) VALUES($1,$2,$3,$4,$5)`,
			hashState(state), id, pluginID, userID, s.clock.Now().Add(oauthAttemptLifetime)); err != nil {
			return nil, err
		}
		if err := s.secrets.WriteInTx(ctx, tx, connectionSecret(row, oauthVerifierKey), verifier, nullableUser(userID)); err != nil {
			return nil, err
		}
		query := url.Values{}
		for key, value := range declaration.OAuth.AuthorizationParameters {
			query.Set(key, value)
		}
		query.Set("response_type", "code")
		query.Set("client_id", *row.oauth.clientID)
		query.Set("redirect_uri", current.CallbackURL)
		query.Set("scope", strings.Join(declaration.OAuth.Scopes, " "))
		query.Set("state", state)
		query.Set("code_challenge", pkceChallenge(verifier))
		query.Set("code_challenge_method", "S256")
		authorization = declaration.OAuth.AuthorizationEndpoint + "?" + query.Encode()
		return nil, nil
	})
	return authorization, err
}

// ExpireOAuthAttempts deletes expired authorization attempts and their
// PKCE verifiers. The maintenance loop runs it; StartOAuth runs it too.
func (s *Service) ExpireOAuthAttempts(ctx context.Context) (int, error) {
	if s.secrets == nil {
		return 0, nil
	}
	removed := 0
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var err error
		removed, err = s.expireOAuthAttempts(ctx, tx)
		return err
	})
	return removed, err
}

func (s *Service) expireOAuthAttempts(ctx context.Context, tx pgx.Tx) (int, error) {
	rows, err := tx.Query(ctx, `DELETE FROM plugin_oauth_transactions WHERE expires_at<=$1 RETURNING connection_id,plugin_id`, s.clock.Now())
	if err != nil {
		return 0, err
	}
	type expired struct {
		id       uuid.UUID
		pluginID string
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (expired, error) {
		var item expired
		return item, row.Scan(&item.id, &item.pluginID)
	})
	if err != nil {
		return 0, err
	}
	for _, item := range list {
		if _, err := s.secrets.DeleteInTx(ctx, tx, pluginsecrets.SecretRef{PluginID: item.pluginID, OwnerType: pluginsecrets.OwnerConnection, OwnerID: item.id, Key: oauthVerifierKey}); err != nil {
			return 0, err
		}
	}
	return len(list), nil
}

// OAuthCallback is what the provider returned to the callback URL, as
// Studio hands it to the completion request.
type OAuthCallback struct {
	State string `json:"state"`
	Code  string `json:"code"`
	// Error is the provider's error parameter, such as access_denied.
	Error string `json:"error"`
}

// Bounds of the callback parameters.
const (
	maxOAuthStateLength = 256
	maxOAuthCodeLength  = 4096
)

var oauthErrorPattern = regexp.MustCompile(`^[a-z_]{1,64}$`)

// OAuthCallbackPage answers the provider's redirect to the callback URL.
//
// The callback is a cross-site navigation from the provider, and the Studio
// session cookie is SameSite=Strict, so the browser does not send it there.
// The callback therefore changes nothing. It returns the fixed Studio page
// of the connection, with the state, the code, and a provider error code in
// the URL fragment. That page runs in Studio, where the session is present,
// and posts them to the completion operation with the CSRF token. A
// fragment never reaches a server log or a Referer header. No request
// parameter chooses the destination.
func (s *Service) OAuthCallbackPage(pluginID, connectionID string, query url.Values) string {
	hosted, ok := s.hostedPlugin(pluginID)
	id, err := uuid.Parse(connectionID)
	route := ""
	if ok {
		route = hosted.manifest.StudioRoute()
	}
	if !ok || err != nil || hosted.manifest.APIVersion < 3 || !strings.HasPrefix(route, "/") || strings.HasPrefix(route, "//") {
		return "/plugins"
	}
	fragment := url.Values{}
	if state := query.Get("state"); state != "" && len(state) <= maxOAuthStateLength {
		fragment.Set("state", state)
	}
	if code := query.Get("code"); code != "" && len(code) <= maxOAuthCodeLength {
		fragment.Set("code", code)
	}
	if providerError := query.Get("error"); providerError != "" {
		if !oauthErrorPattern.MatchString(providerError) {
			providerError = "invalid_request"
		}
		fragment.Set("error", providerError)
	}
	return route + "/connections/" + id.String() + "#oauth=" + url.QueryEscape(fragment.Encode())
}

// Reasons a completion fails.
const (
	OAuthFailInvalidState      = "invalid_state"
	OAuthFailProviderDenied    = "provider_denied"
	OAuthFailInvalidResponse   = "invalid_response"
	OAuthFailConnectionChanged = "connection_changed"
	OAuthFailUnavailable       = "unavailable"
)

func oauthFailed(reason string) error {
	return &plugin.APIError{Status: http.StatusBadRequest, Code: "plugin_oauth_failed",
		Message: "The provider did not connect this connection.", Details: map[string]any{"reason": reason}}
}

// CompleteOAuth finishes an attempt for the signed-in operator who started
// it. A wrong, expired, or used state, a state of another plugin,
// connection, or operator, and every provider or exchange failure answer
// plugin_oauth_failed with a stable reason and never with provider text.
func (s *Service) CompleteOAuth(ctx context.Context, pluginID string, id, userID uuid.UUID, callback OAuthCallback) (ConnectionDocument, error) {
	if _, err := s.hostedV3(pluginID); err != nil {
		return ConnectionDocument{}, err
	}
	if s.secrets == nil {
		return ConnectionDocument{}, &plugin.APIError{Status: 503, Code: "secrets_unavailable", Message: "Plugin secrets are unavailable on this server."}
	}
	if callback.State == "" || len(callback.State) > maxOAuthStateLength {
		return ConnectionDocument{}, oauthFailed(OAuthFailInvalidState)
	}
	// The attempt is consumed before anything else, so a failed callback
	// can never be replayed, and one DELETE ... RETURNING lets exactly one
	// Server process consume it.
	var connectionID, owner uuid.UUID
	var attemptPlugin string
	var expires time.Time
	err := s.db.QueryRow(ctx, `DELETE FROM plugin_oauth_transactions WHERE state_hash=$1 RETURNING connection_id,plugin_id,user_id,expires_at`,
		hashState(callback.State)).Scan(&connectionID, &attemptPlugin, &owner, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return ConnectionDocument{}, oauthFailed(OAuthFailInvalidState)
	}
	if err != nil {
		return ConnectionDocument{}, err
	}
	if connectionID != id || attemptPlugin != pluginID || owner != userID || !s.clock.Now().Before(expires) {
		s.dropVerifier(ctx, attemptPlugin, connectionID)
		return ConnectionDocument{}, oauthFailed(OAuthFailInvalidState)
	}
	row, err := scanConnection(s.db.QueryRow(ctx, `SELECT `+connectionColumns+` FROM plugin_connections WHERE id=$1 AND plugin_id=$2`, id, pluginID))
	if err != nil {
		return ConnectionDocument{}, oauthFailed(OAuthFailConnectionChanged)
	}
	verifier, verifierErr := s.secrets.Read(ctx, s.db, connectionSecret(row, oauthVerifierKey))
	s.dropVerifier(ctx, pluginID, id)
	if callback.Error != "" {
		return ConnectionDocument{}, oauthFailed(OAuthFailProviderDenied)
	}
	if callback.Code == "" || len(callback.Code) > maxOAuthCodeLength || verifierErr != nil {
		return ConnectionDocument{}, oauthFailed(OAuthFailInvalidResponse)
	}
	_, declaration, err := s.oauthDeclaration(pluginID, row)
	if err != nil || row.oauth.clientID == nil {
		return ConnectionDocument{}, oauthFailed(OAuthFailConnectionChanged)
	}
	callbackURL := s.oauthCallbackURL(pluginID, id)
	if callbackURL == "" {
		return ConnectionDocument{}, oauthUnavailable(ConnectNeedsHTTPSPublicURL)
	}
	clientID := *row.oauth.clientID
	tokens, failure := s.tokenRequest(ctx, s.db, row, declaration, url.Values{
		"grant_type": {"authorization_code"}, "code": {callback.Code},
		"redirect_uri": {callbackURL}, "code_verifier": {verifier},
	})
	if failure != "" {
		return ConnectionDocument{}, oauthFailed(failure)
	}
	if _, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		locked, err := s.lockConnection(ctx, tx, pluginID, id)
		if err != nil {
			return nil, err
		}
		if locked.oauth.clientID == nil || *locked.oauth.clientID != clientID {
			return nil, errOAuthConnectionChanged
		}
		if err := s.secrets.WriteInTx(ctx, tx, connectionSecret(locked, oauthAccessTokenKey), tokens.access, nullableUser(userID)); err != nil {
			return nil, err
		}
		if tokens.refresh != "" {
			if err := s.secrets.WriteInTx(ctx, tx, connectionSecret(locked, oauthRefreshTokenKey), tokens.refresh, nullableUser(userID)); err != nil {
				return nil, err
			}
		} else if _, err := s.secrets.DeleteInTx(ctx, tx, connectionSecret(locked, oauthRefreshTokenKey)); err != nil {
			return nil, err
		}
		now := s.clock.Now().UTC()
		if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET oauth_status='connected',oauth_fingerprint=$2,oauth_access_expires_at=$3,
			oauth_connected_at=$4,oauth_connected_by=$5,oauth_refreshed_at=NULL,oauth_last_error=NULL,oauth_last_error_at=NULL,
			oauth_revocation=NULL,oauth_disconnected_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1`,
			id, declaration.SecurityFingerprint(), tokens.expiresAt, now, nullableUser(userID)); err != nil {
			return nil, err
		}
		return nil, s.auditConnection(ctx, tx, "plugin.connection.oauth_connected", pluginID, id, locked.name, userID,
			map[string]any{"definition": locked.definition, "refreshToken": tokens.refresh != ""})
	}); err != nil {
		if errors.Is(err, errOAuthConnectionChanged) || errors.Is(err, ErrNotFound) {
			return ConnectionDocument{}, oauthFailed(OAuthFailConnectionChanged)
		}
		var explicit *plugin.APIError
		if errors.As(err, &explicit) {
			return ConnectionDocument{}, oauthFailed(OAuthFailConnectionChanged)
		}
		return ConnectionDocument{}, err
	}
	return s.GetConnection(ctx, pluginID, id)
}

var errOAuthConnectionChanged = errors.New("the connection changed during authorization")

func (s *Service) dropVerifier(ctx context.Context, pluginID string, id uuid.UUID) {
	if pluginID == "" || id == uuid.Nil {
		return
	}
	_ = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		_, err := s.secrets.DeleteInTx(ctx, tx, pluginsecrets.SecretRef{PluginID: pluginID, OwnerType: pluginsecrets.OwnerConnection, OwnerID: id, Key: oauthVerifierKey})
		return err
	})
}

type tokenSet struct {
	access    string
	refresh   string
	expiresAt *time.Time
}

// Token endpoint error classes.
const (
	tokenInvalidGrant = "invalid_grant"
	tokenRejected     = "token_rejected"
	tokenUnavailable  = "token_endpoint_unavailable"
	tokenInvalid      = "invalid_token_response"
)

// tokenRequest posts one grant to the token endpoint through the outbound
// engine. It returns a stable failure code, never provider text.
//
// q reads the client secret. A refresh passes its own transaction, so a
// refresh never needs a second pool connection while it holds the row lock.
func (s *Service) tokenRequest(ctx context.Context, q queryer, row connectionRow, declaration plugin.Connection, form url.Values) (tokenSet, string) {
	o := declaration.OAuth
	clientID := ""
	if row.oauth.clientID != nil {
		clientID = *row.oauth.clientID
	}
	headers := []outbound.RequestHeader{{Name: "Accept", Value: "application/json"}}
	switch o.TokenEndpointAuthMethod {
	case plugin.ClientSecretBasic:
		secret, err := s.secrets.Read(ctx, q, connectionSecret(row, oauthClientSecretKey))
		if err != nil {
			return tokenSet{}, "client_secret_unavailable"
		}
		// RFC 6749 section 2.3.1: each value is form-encoded first.
		credentials := url.QueryEscape(clientID) + ":" + url.QueryEscape(secret)
		headers = append(headers, outbound.RequestHeader{Name: "Authorization", Value: "Basic " + base64.StdEncoding.EncodeToString([]byte(credentials)), Sensitive: true})
	case plugin.ClientSecretPost:
		secret, err := s.secrets.Read(ctx, q, connectionSecret(row, oauthClientSecretKey))
		if err != nil {
			return tokenSet{}, "client_secret_unavailable"
		}
		form.Set("client_id", clientID)
		form.Set("client_secret", secret)
	default:
		form.Set("client_id", clientID)
	}
	var body []byte
	if o.JSONTokenRequests() {
		document := map[string]string{}
		for key := range form {
			document[key] = form.Get(key)
		}
		body, _ = json.Marshal(document)
		headers = append(headers, outbound.RequestHeader{Name: "Content-Type", Value: "application/json"})
	} else {
		body = []byte(form.Encode())
		headers = append(headers, outbound.RequestHeader{Name: "Content-Type", Value: "application/x-www-form-urlencoded"})
	}
	response, err := s.providerRequest(ctx, o.TokenEndpoint, headers, body)
	if err != nil {
		return tokenSet{}, tokenUnavailable
	}
	return parseTokenResponse(response.Status, response.Body, s.clock.Now())
}

// providerRequest posts to a declared provider endpoint. The policy has the
// endpoint's own origin only, refuses private addresses and plain HTTP, and
// follows no redirect.
func (s *Service) providerRequest(ctx context.Context, endpoint string, headers []outbound.RequestHeader, body []byte) (*outbound.Response, error) {
	target, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	origin, err := plugin.OriginOf(target)
	if err != nil {
		return nil, err
	}
	return s.outboundEngine().Do(ctx, outbound.Policy{Origins: []plugin.Origin{origin}, MaxResponseBytes: oauthTokenResponseBytes,
		Timeout: oauthTokenTimeout, MaxRedirects: -1}, outbound.Request{Method: http.MethodPost, URL: target, Headers: headers, Body: body})
}

// parseTokenResponse reads a token endpoint answer. A refused grant
// (invalid_grant) needs a new authorization. Any other 4xx is a request the
// provider refuses, for example a wrong client secret: retrying the same
// request cannot help, but the grant itself may still be good. A 5xx, a
// 408, a 429, or anything else is transient.
func parseTokenResponse(status int, body []byte, now time.Time) (tokenSet, string) {
	var document map[string]any
	_ = json.Unmarshal(body, &document)
	if status < 200 || status > 299 {
		code, _ := document["error"].(string)
		switch {
		case code == "invalid_grant" && status >= 400 && status < 500:
			return tokenSet{}, tokenInvalidGrant
		case status >= 400 && status < 500 && status != http.StatusRequestTimeout && status != http.StatusTooManyRequests:
			return tokenSet{}, tokenRejected
		default:
			return tokenSet{}, tokenUnavailable
		}
	}
	access, _ := document["access_token"].(string)
	if access == "" || len(access) > 4096 {
		return tokenSet{}, tokenInvalid
	}
	if kind, ok := document["token_type"].(string); ok && !strings.EqualFold(kind, "bearer") {
		return tokenSet{}, tokenInvalid
	}
	refresh, _ := document["refresh_token"].(string)
	if len(refresh) > 4096 {
		return tokenSet{}, tokenInvalid
	}
	out := tokenSet{access: access, refresh: refresh}
	var seconds float64
	switch value := document["expires_in"].(type) {
	case float64:
		seconds = value
	case string:
		seconds, _ = strconv.ParseFloat(value, 64)
	}
	if seconds > 0 {
		at := now.Add(time.Duration(seconds) * time.Second).UTC()
		out.expiresAt = &at
	} else if text, ok := document["expires_at"].(string); ok {
		if at, err := time.Parse(time.RFC3339, text); err == nil {
			at = at.UTC()
			out.expiresAt = &at
		}
	}
	return out, ""
}

// oauthBearer returns a current access token for a request. It refreshes
// the token before it expires. One Server process refreshes one connection
// at a time: the refresh holds the connection's row lock, and a process that
// waited for the lock reads the token the other one stored.
func (s *Service) oauthBearer(ctx context.Context, connection resolvedConnection) (string, *FetchFailure) {
	row := connection.row
	status := OAuthNotConnected
	if row.oauth.status != nil {
		status = *row.oauth.status
	}
	switch {
	case status == OAuthReconnectRequired:
		return "", fetchFailure(CodeOAuthReconnectRequired)
	case status != OAuthConnected:
		return "", fetchFailure(CodeOAuthNotConnected)
	case row.oauth.fingerprint == nil || *row.oauth.fingerprint != connection.declaration.SecurityFingerprint():
		return "", fetchFailure(CodeOAuthReconnectRequired)
	}
	now := s.clock.Now()
	if row.oauth.accessExpiresAt == nil || row.oauth.accessExpiresAt.After(now.Add(oauthRefreshMargin)) {
		token, err := s.secrets.Read(ctx, s.db, connectionSecret(row, oauthAccessTokenKey))
		if err != nil {
			return "", fetchFailure(CodeOAuthReconnectRequired)
		}
		return token, nil
	}
	return s.refreshOAuth(ctx, connection)
}

// refreshOAuth renews the access token under the connection's row lock.
//
// A Server that stops after the provider answered and before the commit
// loses the answer. When the provider rotates refresh tokens, the stored
// refresh token may then be invalid. The next refresh gets invalid_grant
// and the connection lands in reconnect_required: it never loops, because
// invalid_grant deletes the tokens and nothing refreshes a connection that
// is not connected.
func (s *Service) refreshOAuth(ctx context.Context, connection resolvedConnection) (string, *FetchFailure) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", fetchFailure(CodeOAuthRefreshFailed)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	row, err := s.lockConnection(ctx, tx, connection.row.pluginID, connection.row.id)
	if err != nil {
		return "", fetchFailure(outbound.CodeConnectionUnavailable)
	}
	now := s.clock.Now()
	if row.oauth.status == nil || *row.oauth.status != OAuthConnected {
		return "", fetchFailure(CodeOAuthReconnectRequired)
	}
	if row.oauth.accessExpiresAt == nil || row.oauth.accessExpiresAt.After(now.Add(oauthRefreshMargin)) {
		// Another process refreshed while this one waited for the lock.
		token, err := s.secrets.Read(ctx, tx, connectionSecret(row, oauthAccessTokenKey))
		if err != nil {
			return "", fetchFailure(CodeOAuthReconnectRequired)
		}
		return token, nil
	}
	if row.oauth.lastErrorAt != nil && now.Before(row.oauth.lastErrorAt.Add(oauthRefreshBackoff)) {
		// A refresh failed a moment ago. Requests in the next seconds do not
		// ask the provider again; they use a token that is still valid.
		return s.unexpiredAccessToken(ctx, tx, row, now)
	}
	refresh, err := s.secrets.Read(ctx, tx, connectionSecret(row, oauthRefreshTokenKey))
	if errors.Is(err, pluginsecrets.ErrUnavailable) {
		// No refresh token, or one that cannot be decrypted: only a new
		// authorization can renew access.
		return s.finishRefreshFailure(ctx, tx, row, tokenInvalidGrant)
	}
	if err != nil {
		return "", fetchFailure(CodeOAuthRefreshFailed)
	}
	tokens, failure := s.tokenRequest(ctx, tx, row, connection.declaration, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}})
	if failure != "" {
		return s.finishRefreshFailure(ctx, tx, row, failure)
	}
	// The new access token and, when the provider rotates it, the new
	// refresh token are written in one transaction: a failure never pairs a
	// token of one response with a token of another. A provider that sends
	// no new refresh token keeps the old one valid.
	if err := s.secrets.WriteInTx(ctx, tx, connectionSecret(row, oauthAccessTokenKey), tokens.access, nil); err != nil {
		return "", fetchFailure(CodeOAuthRefreshFailed)
	}
	if tokens.refresh != "" {
		if err := s.secrets.WriteInTx(ctx, tx, connectionSecret(row, oauthRefreshTokenKey), tokens.refresh, nil); err != nil {
			return "", fetchFailure(CodeOAuthRefreshFailed)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET oauth_access_expires_at=$2,oauth_refreshed_at=$3,oauth_last_error=NULL,oauth_last_error_at=NULL WHERE id=$1`,
		row.id, tokens.expiresAt, now.UTC()); err != nil {
		return "", fetchFailure(CodeOAuthRefreshFailed)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fetchFailure(CodeOAuthRefreshFailed)
	}
	return tokens.access, nil
}

// unexpiredAccessToken returns the stored access token while it is still
// valid, and refresh_failed after it expires.
func (s *Service) unexpiredAccessToken(ctx context.Context, q queryer, row connectionRow, now time.Time) (string, *FetchFailure) {
	if row.oauth.accessExpiresAt != nil && row.oauth.accessExpiresAt.After(now) {
		if token, err := s.secrets.Read(ctx, q, connectionSecret(row, oauthAccessTokenKey)); err == nil {
			return token, nil
		}
	}
	return "", fetchFailure(CodeOAuthRefreshFailed)
}

// finishRefreshFailure records a refresh failure. A grant the provider
// rejects needs a new connection: the tokens are deleted and the status is
// reconnect_required, so the host does not retry invalid credentials. Any
// other failure keeps the tokens, records its code, and waits
// oauthRefreshBackoff before the next attempt; a token that has not expired
// yet is still used.
func (s *Service) finishRefreshFailure(ctx context.Context, tx pgx.Tx, row connectionRow, failure string) (string, *FetchFailure) {
	now := s.clock.Now().UTC()
	if failure == tokenInvalidGrant {
		for _, key := range []string{oauthAccessTokenKey, oauthRefreshTokenKey} {
			if _, err := s.secrets.DeleteInTx(ctx, tx, connectionSecret(row, key)); err != nil {
				return "", fetchFailure(CodeOAuthRefreshFailed)
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET oauth_status='reconnect_required',oauth_access_expires_at=NULL,
			oauth_last_error='invalid_grant',oauth_last_error_at=$2,revision=revision+1,updated_at=now() WHERE id=$1`, row.id, now); err != nil {
			return "", fetchFailure(CodeOAuthRefreshFailed)
		}
		if err := s.auditConnection(ctx, tx, "plugin.connection.oauth_reconnect_required", row.pluginID, row.id, row.name, uuid.Nil,
			map[string]any{"definition": row.definition}); err != nil {
			return "", fetchFailure(CodeOAuthRefreshFailed)
		}
		if err := tx.Commit(ctx); err != nil {
			return "", fetchFailure(CodeOAuthRefreshFailed)
		}
		return "", fetchFailure(CodeOAuthReconnectRequired)
	}
	if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET oauth_last_error=$2,oauth_last_error_at=$3 WHERE id=$1`, row.id, failure, now); err != nil {
		return "", fetchFailure(CodeOAuthRefreshFailed)
	}
	token, refusal := s.unexpiredAccessToken(ctx, tx, row, now)
	if err := tx.Commit(ctx); err != nil {
		return "", fetchFailure(CodeOAuthRefreshFailed)
	}
	return token, refusal
}

// DisconnectOAuth revokes and deletes a connection's tokens. It asks the
// provider to revoke the grant when the declaration has a revocation
// endpoint, and it deletes the local tokens whatever the answer: Tilecast
// never keeps an active token because a provider is unreachable. The record
// says whether the revocation was confirmed.
func (s *Service) DisconnectOAuth(ctx context.Context, pluginID string, id, userID uuid.UUID) (ConnectionDocument, error) {
	if _, err := s.hostedV3(pluginID); err != nil {
		return ConnectionDocument{}, err
	}
	if s.secrets == nil {
		return ConnectionDocument{}, &plugin.APIError{Status: 503, Code: "secrets_unavailable", Message: "Plugin secrets are unavailable on this server."}
	}
	row, err := scanConnection(s.db.QueryRow(ctx, `SELECT `+connectionColumns+` FROM plugin_connections WHERE id=$1 AND plugin_id=$2`, id, pluginID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ConnectionDocument{}, connectionNotFound()
	}
	if err != nil {
		return ConnectionDocument{}, err
	}
	_, declaration, err := s.oauthDeclaration(pluginID, row)
	if err != nil {
		return ConnectionDocument{}, err
	}
	revocation := "not_declared"
	if declaration.OAuth.RevocationEndpoint != "" {
		revocation = s.revoke(ctx, row, declaration)
	}
	if _, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		locked, err := s.lockConnection(ctx, tx, pluginID, id)
		if err != nil {
			return nil, err
		}
		for _, key := range []string{oauthAccessTokenKey, oauthRefreshTokenKey, oauthVerifierKey} {
			if _, err := s.secrets.DeleteInTx(ctx, tx, connectionSecret(locked, key)); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_oauth_transactions WHERE connection_id=$1`, id); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET oauth_status='not_connected',oauth_fingerprint=NULL,oauth_access_expires_at=NULL,
			oauth_last_error=NULL,oauth_last_error_at=NULL,oauth_revocation=$2,oauth_disconnected_at=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE id=$1`,
			id, revocation, s.clock.Now().UTC(), nullableUser(userID)); err != nil {
			return nil, err
		}
		return nil, s.auditConnection(ctx, tx, "plugin.connection.oauth_disconnected", pluginID, id, locked.name, userID,
			map[string]any{"definition": locked.definition, "revocation": revocation})
	}); err != nil {
		return ConnectionDocument{}, err
	}
	return s.GetConnection(ctx, pluginID, id)
}

// revoke asks the provider to revoke the grant (RFC 7009). It revokes the
// refresh token, which revokes the grant at most providers, or the access
// token when there is no refresh token.
func (s *Service) revoke(ctx context.Context, row connectionRow, declaration plugin.Connection) string {
	token, hint := "", ""
	if value, err := s.secrets.Read(ctx, s.db, connectionSecret(row, oauthRefreshTokenKey)); err == nil {
		token, hint = value, "refresh_token"
	} else if value, err := s.secrets.Read(ctx, s.db, connectionSecret(row, oauthAccessTokenKey)); err == nil {
		token, hint = value, "access_token"
	}
	if token == "" {
		return "confirmed"
	}
	form := url.Values{"token": {token}, "token_type_hint": {hint}}
	headers := []outbound.RequestHeader{{Name: "Content-Type", Value: "application/x-www-form-urlencoded"}}
	clientID := ""
	if row.oauth.clientID != nil {
		clientID = *row.oauth.clientID
	}
	switch declaration.OAuth.TokenEndpointAuthMethod {
	case plugin.ClientSecretBasic:
		secret, err := s.secrets.Read(ctx, s.db, connectionSecret(row, oauthClientSecretKey))
		if err != nil {
			return "failed"
		}
		credentials := url.QueryEscape(clientID) + ":" + url.QueryEscape(secret)
		headers = append(headers, outbound.RequestHeader{Name: "Authorization", Value: "Basic " + base64.StdEncoding.EncodeToString([]byte(credentials)), Sensitive: true})
	case plugin.ClientSecretPost:
		secret, err := s.secrets.Read(ctx, s.db, connectionSecret(row, oauthClientSecretKey))
		if err != nil {
			return "failed"
		}
		form.Set("client_id", clientID)
		form.Set("client_secret", secret)
	default:
		form.Set("client_id", clientID)
	}
	response, err := s.providerRequest(ctx, declaration.OAuth.RevocationEndpoint, headers, []byte(form.Encode()))
	// RFC 7009 section 2.2: a 200 answers both a revoked token and one that
	// was already invalid.
	if err != nil || response.Status != http.StatusOK {
		s.logger.Info("plugin oauth revocation not confirmed", "plugin", row.pluginID, "connection", row.id)
		return "failed"
	}
	return "confirmed"
}

// writeOAuthClient applies a client ID and client secret change inside an
// update. A new client ID deletes the tokens: they belong to the old client.
func (s *Service) writeOAuthClient(ctx context.Context, tx pgx.Tx, row connectionRow, declaration plugin.Connection, write ConnectionWrite, userID uuid.UUID) (map[string]any, error) {
	changes := map[string]any{}
	if write.ClientID != nil {
		clientID := strings.TrimSpace(*write.ClientID)
		var next *string
		if clientID != "" {
			if len(clientID) > maxClientIDLength || !printableASCII(clientID) {
				return nil, invalidConnection("A client ID has 1 to %d printable characters.", maxClientIDLength)
			}
			next = &clientID
		}
		if (next == nil) != (row.oauth.clientID == nil) || next != nil && *next != *row.oauth.clientID {
			if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET oauth_client_id=$2 WHERE id=$1`, row.id, next); err != nil {
				return nil, err
			}
			changes["clientIdChanged"] = true
			// An attempt in progress belongs to the old client.
			if _, err := tx.Exec(ctx, `DELETE FROM plugin_oauth_transactions WHERE connection_id=$1`, row.id); err != nil {
				return nil, err
			}
			if s.secrets != nil {
				if _, err := s.secrets.DeleteInTx(ctx, tx, connectionSecret(row, oauthVerifierKey)); err != nil {
					return nil, err
				}
			}
			if row.oauth.status != nil && *row.oauth.status != OAuthNotConnected {
				for _, key := range []string{oauthAccessTokenKey, oauthRefreshTokenKey} {
					if _, err := s.secrets.DeleteInTx(ctx, tx, connectionSecret(row, key)); err != nil {
						return nil, err
					}
				}
				if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET oauth_status='not_connected',oauth_fingerprint=NULL,oauth_access_expires_at=NULL,
				oauth_last_error=NULL,oauth_last_error_at=NULL WHERE id=$1`, row.id); err != nil {
					return nil, err
				}
				changes["tokensDeleted"] = true
			}
		}
	}
	if write.ClientSecret != nil || write.ClearClientSecret {
		if !declaration.OAuth.NeedsClientSecret() {
			return nil, invalidConnection("This provider takes no client secret.")
		}
		if s.secrets == nil {
			return nil, &plugin.APIError{Status: 503, Code: "secrets_unavailable", Message: "Plugin secrets are unavailable on this server."}
		}
		if write.ClientSecret != nil && write.ClearClientSecret {
			return nil, invalidConnection("A client secret cannot be set and cleared in one request.")
		}
		if write.ClearClientSecret {
			if _, err := s.secrets.DeleteInTx(ctx, tx, connectionSecret(row, oauthClientSecretKey)); err != nil {
				return nil, err
			}
		} else {
			secret := *write.ClientSecret
			if secret == "" || len(secret) > 4096 || !printableASCII(secret) {
				return nil, invalidConnection("A client secret has 1 to 4096 printable characters.")
			}
			if err := s.secrets.WriteInTx(ctx, tx, connectionSecret(row, oauthClientSecretKey), secret, nullableUser(userID)); err != nil {
				return nil, err
			}
		}
		changes["clientSecretChanged"] = true
	}
	return changes, nil
}

func printableASCII(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e {
			return false
		}
	}
	return true
}

// bearerHeader is the OAuth access token header of a request through an
// oauth2 connection. A plugin never sends its own Authorization header on
// one: the host refuses the request instead of choosing between two.
func (s *Service) bearerHeader(ctx context.Context, connection resolvedConnection, headers []ConnectionHeader) (outbound.RequestHeader, *FetchFailure) {
	for _, header := range headers {
		if strings.EqualFold(strings.TrimSpace(header.Name), "Authorization") {
			return outbound.RequestHeader{}, fetchFailure(CodeOAuthAuthorizationHeader)
		}
	}
	token, refusal := s.oauthBearer(ctx, connection)
	if refusal != nil {
		return outbound.RequestHeader{}, refusal
	}
	return outbound.RequestHeader{Name: "Authorization", Value: "Bearer " + token, Sensitive: true}, nil
}
