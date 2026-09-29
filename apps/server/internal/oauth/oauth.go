// Package oauth is the narrow built-in authorization server for a
// Tilecast installation. It exists so the tilecast CLI and other loopback
// operators can act as the signed-in user without ever seeing a password
// or a session cookie.
//
// The scope is deliberately small: authorization code flow with PKCE S256
// only, fixed callbacks for first-party clients, explicit per-grant user
// approval, opaque short-lived access tokens, and rotating refresh tokens
// with reuse detection. This installation acts as authorization server only
// for itself and its own clients; Tilecast is not a general OAuth or OIDC
// provider, and there is no client registration of any kind.
//
// First-party OAuth client IDs are stable
// protocol constants, not database rows: the protocol sends
// client_id=tilecast-cli and the server validates that exact string.
// Display names are constants in code. Personal access tokens ride the
// same generic api_grants table directly, with no synthetic OAuth client.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// AccessPrefix marks opaque OAuth access tokens for operators.
	AccessPrefix = "tca_"
	// RefreshPrefix marks opaque OAuth refresh tokens for operators.
	RefreshPrefix = "tcr_"

	codeLifetime    = 10 * time.Minute
	accessLifetime  = 15 * time.Minute
	refreshLifetime = 30 * 24 * time.Hour
)

// Scopes is the small fixed vocabulary a grant may carry. Grants inherit
// the user's current role and screen scope at use time; scopes bound what
// the grant may ask for, never more.
var Scopes = map[string]string{
	"read":  "View screens, settings, schedules, content, and status.",
	"write": "Change screens, content, schedules, playlists, and settings.",
	"admin": "Manage users, tokens, grants, and security settings.",
}

// First-party OAuth client IDs. These strings are the OAuth client_id
// values on the wire; the CLI and MCP use the loopback model with no
// secret. There is no registration, no randomness, and no lookup table.
const (
	ClientCLI = "tilecast-cli"
	ClientMCP = "tilecast-mcp"
	ClientIOS = "tilecast-ios"
)

// Display names for first-party clients. The client_id is the identity;
// the display name is presentation only.
const (
	ClientCLIDisplayName = "Tilecast CLI"
	ClientMCPDisplayName = "Tilecast MCP"
	ClientIOSDisplayName = "Tilecast for iOS"
)

// DisplayNameForClient returns the presentation name for a first-party
// OAuth client ID, or false for anything else.
func DisplayNameForClient(clientID string) (string, bool) {
	switch clientID {
	case ClientCLI:
		return ClientCLIDisplayName, true
	case ClientMCP:
		return ClientMCPDisplayName, true
	case ClientIOS:
		return ClientIOSDisplayName, true
	}
	return "", false
}

// GrantKind names which credential family a generic API grant belongs to.
type GrantKind string

const (
	// GrantKindOAuth is an OAuth authorization (authorization code flow).
	GrantKindOAuth GrantKind = "oauth"
	// GrantKindPAT is a personal access token.
	GrantKindPAT GrantKind = "pat"
)

var (
	ErrUnknownClient    = errors.New("unknown OAuth client")
	ErrBadRedirect      = errors.New("redirect URI is not allowed for this client")
	ErrBadScope         = errors.New("unknown or empty scope")
	ErrBadChallenge     = errors.New("code challenge must use S256")
	ErrCodeExpired      = errors.New("authorization code expired or used")
	ErrTokenExpired     = errors.New("token expired or unknown")
	ErrGrantRevoked     = errors.New("grant revoked")
	ErrReuseDetected    = errors.New("refresh token reuse detected; grant revoked")
	ErrPKCEFailed       = errors.New("PKCE verification failed")
	ErrGrantNotFound    = errors.New("grant not found")
	ErrClientMismatch   = errors.New("authorization code was issued to a different client")
	ErrRedirectMismatch = errors.New("redirect URI does not match the authorization request")
)

// Grant is one user authorization: an OAuth grant carrying a first-party
// client ID, or a PAT carrying a name.
type Grant struct {
	ID         uuid.UUID
	UserID     uuid.UUID
	Kind       GrantKind
	ClientID   string
	Name       string
	Scopes     []string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// DisplayName renders the grant for operators: the client display name
// for OAuth grants, the token name for PATs.
func (g Grant) DisplayName() string {
	if g.Kind == GrantKindPAT {
		return g.Name
	}
	if display, ok := DisplayNameForClient(g.ClientID); ok {
		return display
	}
	return g.ClientID
}

// AuthorizeRequest is the validated approval payload.
type AuthorizeRequest struct {
	ClientID    string
	DisplayName string
	RedirectURI string
	Scopes      []string
	State       string
	Challenge   string
}

// Tokens is one issuance: opaque access and refresh secrets plus expiry.
// Only hashes reach PostgreSQL; the secrets here cross into the HTTP
// response once and are never stored or logged.
type Tokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

// Service owns grants, codes, and tokens.
type Service struct {
	db *pgxpool.Pool
}

// NewService wires the OAuth service.
func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

func randomSecret(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// ValidateScopes parses and validates a space-separated scope list.
func ValidateScopes(raw string) ([]string, error) {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return nil, ErrBadScope
	}
	seen := map[string]bool{}
	for _, scope := range fields {
		if Scopes[scope] == "" || seen[scope] {
			return nil, fmt.Errorf("%w: %q", ErrBadScope, scope)
		}
		seen[scope] = true
	}
	return fields, nil
}

// isLoopback reports whether a redirect URI targets this machine over
// plain HTTP via a loopback IP literal (127.0.0.1 or ::1). Hostnames such
// as localhost are deliberately not accepted: DNS resolution could steer
// the code somewhere else, and the native flow already binds 127.0.0.1.
func isLoopback(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.Fragment != "" {
		return false
	}
	ip := net.ParseIP(parsed.Hostname())
	return ip != nil && ip.IsLoopback()
}

const IOSRedirectURI = "tilecast-ios://oauth/callback"

// ValidateAuthorize checks an authorization request without storing
// anything. Approval and denial happen against the same validation. The
// client ID must be a known first-party value; it is the protocol string,
// not a database lookup.
func (s *Service) ValidateAuthorize(ctx context.Context, clientID, redirectURI, scope, state, challenge, method string) (AuthorizeRequest, error) {
	display, ok := DisplayNameForClient(clientID)
	if !ok {
		return AuthorizeRequest{}, ErrUnknownClient
	}
	if (clientID == ClientIOS && redirectURI != IOSRedirectURI) || (clientID != ClientIOS && !isLoopback(redirectURI)) {
		return AuthorizeRequest{}, fmt.Errorf("%w: invalid first-party callback", ErrBadRedirect)
	}
	scopes, err := ValidateScopes(scope)
	if err != nil {
		return AuthorizeRequest{}, err
	}
	if method != "" && method != "S256" {
		return AuthorizeRequest{}, ErrBadChallenge
	}
	if strings.TrimSpace(challenge) == "" {
		return AuthorizeRequest{}, ErrBadChallenge
	}
	return AuthorizeRequest{ClientID: clientID, DisplayName: display, RedirectURI: redirectURI, Scopes: scopes, State: state, Challenge: challenge}, nil
}

// Approve records the grant and mints a single-use authorization code.
// The code crosses into the redirect once and is never stored.
func (s *Service) Approve(ctx context.Context, userID uuid.UUID, req AuthorizeRequest) (code string, err error) {
	raw, err := randomSecret(32)
	if err != nil {
		return "", err
	}
	grantID := uuid.New()
	expires := time.Now().UTC().Add(codeLifetime)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin approval: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `INSERT INTO api_grants(id,user_id,kind,client_id,scopes) VALUES($1,$2,'oauth',$3,$4)`,
		grantID, userID, req.ClientID, req.Scopes); err != nil {
		return "", fmt.Errorf("record grant: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO oauth_authorization_codes(code_hash,grant_id,redirect_uri,code_challenge,expires_at)
		VALUES($1,$2,$3,$4,$5)`, hashSecret(raw), grantID, req.RedirectURI, req.Challenge, expires); err != nil {
		return "", fmt.Errorf("record code: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit approval: %w", err)
	}
	return raw, nil
}

// Exchange swaps a single-use code plus PKCE verifier for tokens. The
// DELETE ... RETURNING consumes the code atomically, so a concurrent
// replay cannot redeem the same code twice.
func (s *Service) Exchange(ctx context.Context, clientID, code, redirectURI, verifier string) (Tokens, uuid.UUID, error) {
	if _, ok := DisplayNameForClient(clientID); !ok {
		return Tokens{}, uuid.Nil, ErrUnknownClient
	}
	var grantID uuid.UUID
	var storedChallenge, storedRedirect string
	var storedClientID string
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Tokens{}, uuid.Nil, fmt.Errorf("begin exchange: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	err = tx.QueryRow(ctx, `DELETE FROM oauth_authorization_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()
		RETURNING grant_id,redirect_uri,code_challenge`, hashSecret(code)).Scan(&grantID, &storedRedirect, &storedChallenge)
	if err != nil {
		return Tokens{}, uuid.Nil, ErrCodeExpired
	}
	if err := tx.QueryRow(ctx, `SELECT client_id FROM api_grants WHERE id=$1 AND kind='oauth' AND revoked_at IS NULL`, grantID).Scan(&storedClientID); err != nil {
		return Tokens{}, uuid.Nil, ErrGrantRevoked
	}
	if storedClientID != clientID {
		return Tokens{}, uuid.Nil, ErrClientMismatch
	}
	if storedRedirect != redirectURI {
		return Tokens{}, uuid.Nil, ErrRedirectMismatch
	}
	if !verifyChallenge(verifier, storedChallenge) {
		return Tokens{}, uuid.Nil, ErrPKCEFailed
	}
	tokens, _, err := s.issueTokens(ctx, tx, grantID)
	if err != nil {
		return Tokens{}, uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Tokens{}, uuid.Nil, fmt.Errorf("commit exchange: %w", err)
	}
	return tokens, grantID, nil
}

// verifyChallenge checks a PKCE S256 verifier against its challenge.
func verifyChallenge(verifier, challenge string) bool {
	if verifier == "" || challenge == "" {
		return false
	}
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:]) == challenge
}

// issueTokens mints one access and refresh pair, returning the tokens with
// the stored refresh hash so rotation can link the chain.
func (s *Service) issueTokens(ctx context.Context, tx pgx.Tx, grantID uuid.UUID) (Tokens, []byte, error) {
	access, err := randomSecret(32)
	if err != nil {
		return Tokens{}, nil, err
	}
	refresh, err := randomSecret(32)
	if err != nil {
		return Tokens{}, nil, err
	}
	now := time.Now().UTC()
	expires := now.Add(accessLifetime)
	accessSecret := AccessPrefix + access
	refreshSecret := RefreshPrefix + refresh
	refreshHash := hashSecret(refreshSecret)
	if _, err := tx.Exec(ctx, `INSERT INTO oauth_access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,$3)`,
		hashSecret(accessSecret), grantID, expires); err != nil {
		return Tokens{}, nil, fmt.Errorf("record access token: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO oauth_refresh_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,$3)`,
		refreshHash, grantID, now.Add(refreshLifetime)); err != nil {
		return Tokens{}, nil, fmt.Errorf("record refresh token: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE api_grants SET last_used_at=now() WHERE id=$1`, grantID); err != nil {
		return Tokens{}, nil, fmt.Errorf("touch grant: %w", err)
	}
	return Tokens{AccessToken: accessSecret, RefreshToken: refreshSecret, ExpiresAt: expires}, refreshHash, nil
}

// Refresh rotates a refresh token: the presented secret dies, a new pair
// is issued, and any reuse of an already-rotated secret revokes the whole
// grant and reports reuse. The row lock (FOR UPDATE) makes the consume
// atomic: two concurrent refreshes serialize, the loser observes used_at
// and takes the reuse path, so one secret can never mint two pairs.
func (s *Service) Refresh(ctx context.Context, refreshSecret string) (Tokens, uuid.UUID, bool, error) {
	if !strings.HasPrefix(refreshSecret, RefreshPrefix) {
		return Tokens{}, uuid.Nil, false, ErrTokenExpired
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Tokens{}, uuid.Nil, false, fmt.Errorf("begin refresh: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var grantID uuid.UUID
	var usedAt *time.Time
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT grant_id,used_at,expires_at FROM oauth_refresh_tokens WHERE token_hash=$1 FOR UPDATE`, hashSecret(refreshSecret)).Scan(&grantID, &usedAt, &expiresAt)
	if err != nil {
		return Tokens{}, uuid.Nil, false, ErrTokenExpired
	}
	if usedAt != nil {
		if _, err := tx.Exec(ctx, `UPDATE api_grants SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, grantID); err != nil {
			return Tokens{}, uuid.Nil, false, fmt.Errorf("revoke reused grant: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE oauth_refresh_tokens SET reuse_detected_at=now() WHERE token_hash=$1`, hashSecret(refreshSecret)); err != nil {
			return Tokens{}, uuid.Nil, false, fmt.Errorf("mark reuse: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return Tokens{}, uuid.Nil, false, fmt.Errorf("commit reuse: %w", err)
		}
		return Tokens{}, grantID, true, ErrReuseDetected
	}
	if time.Now().UTC().After(expiresAt) {
		return Tokens{}, uuid.Nil, false, ErrTokenExpired
	}
	var revoked *time.Time
	if err := tx.QueryRow(ctx, `SELECT revoked_at FROM api_grants WHERE id=$1`, grantID).Scan(&revoked); err != nil {
		return Tokens{}, uuid.Nil, false, fmt.Errorf("read grant: %w", err)
	}
	if revoked != nil {
		return Tokens{}, uuid.Nil, false, ErrGrantRevoked
	}
	tokens, refreshHash, err := s.issueTokens(ctx, tx, grantID)
	if err != nil {
		return Tokens{}, uuid.Nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE oauth_refresh_tokens SET used_at=now(),replaced_by=$1 WHERE token_hash=$2`,
		refreshHash, hashSecret(refreshSecret)); err != nil {
		return Tokens{}, uuid.Nil, false, fmt.Errorf("retire refresh token: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Tokens{}, uuid.Nil, false, fmt.Errorf("commit refresh: %w", err)
	}
	return tokens, grantID, false, nil
}

// RevokeGrant revokes one of the user's grants — OAuth or PAT — and every
// token under it. Personal access tokens are revoked through this same
// endpoint; there is no separate PAT revocation path.
func (s *Service) RevokeGrant(ctx context.Context, userID, grantID uuid.UUID) error {
	result, err := s.db.Exec(ctx, `UPDATE api_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, grantID, userID)
	if err != nil {
		return fmt.Errorf("revoke grant: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrGrantNotFound
	}
	return nil
}

// GrantByID loads one grant row for attribution and administration.
func (s *Service) GrantByID(ctx context.Context, grantID uuid.UUID) (Grant, error) {
	var grant Grant
	var clientID, name *string
	err := s.db.QueryRow(ctx, `SELECT id,user_id,kind,client_id,name,scopes,created_at,last_used_at,revoked_at
		FROM api_grants WHERE id=$1`, grantID).Scan(
		&grant.ID, &grant.UserID, &grant.Kind, &clientID, &name,
		&grant.Scopes, &grant.CreatedAt, &grant.LastUsedAt, &grant.RevokedAt)
	if err != nil {
		return Grant{}, fmt.Errorf("read grant: %w", err)
	}
	if clientID != nil {
		grant.ClientID = *clientID
	}
	if name != nil {
		grant.Name = *name
	}
	return grant, nil
}

// BearerKind maps a stored grant onto the presented-credential family for
// audit attribution.
func (g Grant) BearerKind() BearerKind {
	if g.Kind == GrantKindPAT {
		return BearerKindPAT
	}
	return BearerKindOAuth
}

// RevokeCredential revokes the grant behind a presented access or refresh
// secret, whichever it is, returning the revoked grant for attribution.
func (s *Service) RevokeCredential(ctx context.Context, secret string) (Grant, error) {
	hash := hashSecret(secret)
	var grantID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT grant_id FROM oauth_access_tokens WHERE token_hash=$1`, hash).Scan(&grantID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = s.db.QueryRow(ctx, `SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=$1`, hash).Scan(&grantID)
	}
	if err != nil {
		return Grant{}, ErrTokenExpired
	}
	grant, err := s.GrantByID(ctx, grantID)
	if err != nil {
		return Grant{}, err
	}
	if _, err := s.db.Exec(ctx, `UPDATE api_grants SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, grantID); err != nil {
		return Grant{}, fmt.Errorf("revoke grant: %w", err)
	}
	return grant, nil
}

// ListGrants returns the user's OAuth grants newest first, revoked
// included. PATs are listed through ListPATs instead.
func (s *Service) ListGrants(ctx context.Context, userID uuid.UUID) ([]Grant, error) {
	rows, err := s.db.Query(ctx, `SELECT id,user_id,kind,client_id,name,scopes,created_at,last_used_at,revoked_at
		FROM api_grants WHERE user_id=$1 AND kind='oauth' ORDER BY created_at DESC,id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list grants: %w", err)
	}
	defer rows.Close()
	var grants []Grant
	for rows.Next() {
		var grant Grant
		var clientID, name *string
		if err := rows.Scan(&grant.ID, &grant.UserID, &grant.Kind, &clientID, &name, &grant.Scopes, &grant.CreatedAt, &grant.LastUsedAt, &grant.RevokedAt); err != nil {
			return nil, fmt.Errorf("scan grant: %w", err)
		}
		if clientID != nil {
			grant.ClientID = *clientID
		}
		if name != nil {
			grant.Name = *name
		}
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}

// LookupAccess resolves an access secret to its live grant.
func (s *Service) LookupAccess(ctx context.Context, secret string) (grantID, userID uuid.UUID, err error) {
	if !strings.HasPrefix(secret, AccessPrefix) {
		return uuid.Nil, uuid.Nil, ErrTokenExpired
	}
	err = s.db.QueryRow(ctx, `SELECT t.grant_id,g.user_id FROM oauth_access_tokens t
		JOIN api_grants g ON g.id=t.grant_id
		WHERE t.token_hash=$1 AND t.expires_at>now() AND g.revoked_at IS NULL`, hashSecret(secret)).Scan(&grantID, &userID)
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrTokenExpired
	}
	return grantID, userID, nil
}
