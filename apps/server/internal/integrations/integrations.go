// Package integrations lets another system write into Tilecast, and lets
// existing monitoring read fleet health, without a Studio password.
//
// Every capability here is enumerable. There is deliberately no scope that
// reaches general administration, creates or deletes content, or touches
// screens: the same restraint as the fixed player command set. An integration
// that needs more than these scopes should be a feature, not a token.
package integrations

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/credential"
)

// Scopes a token may carry.
const (
	// ScopeDataSourceWrite replaces the rows of a Manual Table Data Source.
	// It cannot create one, delete one, or change its columns.
	ScopeDataSourceWrite = "data_source:write"
	// ScopeActivityRead reads bounded fleet health counts.
	ScopeActivityRead = "activity:read"
)

// TokenPrefix identifies a Tilecast integration token in a log or a
// configuration file, so a leaked string is recognisable as one.
const TokenPrefix = "tci_"

var (
	// ErrUnauthenticated covers every authentication failure. The reason is
	// deliberately not reported to the caller: a token that is revoked, expired,
	// unknown, or wrong must be indistinguishable from outside.
	ErrUnauthenticated = errors.New("integration token is not valid")
	// ErrForbidden means the token authenticated but lacks the scope.
	ErrForbidden = errors.New("integration token does not have that scope")
	// ErrNotFound is returned for an unknown token.
	ErrNotFound = errors.New("not found")
	// ErrValidation marks a bad request.
	ErrValidation = errors.New("integration token request is not valid")
)

// Service manages and authenticates integration tokens.
type Service struct{ db *pgxpool.Pool }

// NewService builds the integrations service.
func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

// Token is the API view of a token. It never carries the secret.
type Token struct {
	ID            uuid.UUID   `json:"id"`
	Name          string      `json:"name"`
	PublicID      string      `json:"publicId"`
	Scopes        []string    `json:"scopes"`
	DataSourceIDs []uuid.UUID `json:"dataSourceIds"`
	CreatedAt     time.Time   `json:"createdAt"`
	CreatedBy     *uuid.UUID  `json:"createdBy,omitempty"`
	ExpiresAt     *time.Time  `json:"expiresAt,omitempty"`
	LastUsedAt    *time.Time  `json:"lastUsedAt,omitempty"`
	RevokedAt     *time.Time  `json:"revokedAt,omitempty"`
}

// Active reports whether this token would authenticate now.
func (t Token) Active() bool {
	if t.RevokedAt != nil {
		return false
	}
	return t.ExpiresAt == nil || t.ExpiresAt.After(time.Now())
}

// Principal is an authenticated token.
type Principal struct {
	TokenID uuid.UUID
	Name    string
	Scopes  []string
	// DataSourceIDs is empty when the token may write any Manual Table source.
	DataSourceIDs []uuid.UUID
	// ActingUser is the account that created the token. Everything the token
	// does is attributed to it, so a change always has a person behind it.
	ActingUser uuid.UUID
}

// HasScope reports whether the token carries a scope.
func (p Principal) HasScope(scope string) bool {
	for _, held := range p.Scopes {
		if held == scope {
			return true
		}
	}
	return false
}

// MayWrite reports whether this token may write the given Data Source.
func (p Principal) MayWrite(id uuid.UUID) bool {
	if !p.HasScope(ScopeDataSourceWrite) {
		return false
	}
	if len(p.DataSourceIDs) == 0 {
		return true
	}
	for _, allowed := range p.DataSourceIDs {
		if allowed == id {
			return true
		}
	}
	return false
}

// Create issues a token and returns the secret exactly once.
func (s *Service) Create(ctx context.Context, user uuid.UUID, name string, scopes []string, dataSourceIDs []uuid.UUID, expiresAt *time.Time) (Token, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Token{}, "", fmt.Errorf("%w: a name is required", ErrValidation)
	}
	normalized, err := normalizeScopes(scopes)
	if err != nil {
		return Token{}, "", err
	}
	if expiresAt != nil && !expiresAt.After(time.Now()) {
		return Token{}, "", fmt.Errorf("%w: the expiry must be in the future", ErrValidation)
	}
	if len(dataSourceIDs) > 0 && !containsScope(normalized, ScopeDataSourceWrite) {
		return Token{}, "", fmt.Errorf("%w: naming Data Sources only applies to a write token", ErrValidation)
	}

	// A nil slice reaches PostgreSQL as NULL, and the column is NOT NULL with an
	// empty-array default. Without this, creating a token that is not narrowed to
	// specific Data Sources -- the common case -- fails outright.
	if dataSourceIDs == nil {
		dataSourceIDs = []uuid.UUID{}
	}

	publicID, secret, err := newCredential()
	if err != nil {
		return Token{}, "", err
	}
	hash := credential.Digest(secret)

	var org uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		return Token{}, "", err
	}
	id := uuid.New()
	if _, err := s.db.Exec(ctx, `
		INSERT INTO integration_tokens(
			id,organization_id,name,public_id,secret_hash,scopes,data_source_ids,created_by,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		id, org, name, publicID, hash, normalized, dataSourceIDs, user, expiresAt); err != nil {
		return Token{}, "", err
	}
	token, err := s.get(ctx, id)
	if err != nil {
		return Token{}, "", err
	}
	// The full token is returned here and nowhere else. There is no endpoint
	// that reads it back, and it is never logged.
	return token, credential.Format(TokenPrefix, publicID, secret), nil
}

// List returns the tokens, newest first, without secrets.
func (s *Service) List(ctx context.Context) ([]Token, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id,name,public_id,scopes,data_source_ids,created_at,created_by,
		       expires_at,last_used_at,revoked_at
		FROM integration_tokens ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Token{}
	for rows.Next() {
		token, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, token)
	}
	return out, rows.Err()
}

// Revoke permanently disables a token. There is no un-revoke: a token that
// might have leaked is replaced, not re-enabled.
func (s *Service) Revoke(ctx context.Context, id uuid.UUID) error {
	tag, err := s.db.Exec(ctx,
		`UPDATE integration_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Authenticate resolves an Authorization header value to a principal.
//
// The public id selects the row and the secret is compared against its stored
// hash in constant time, so a wrong secret costs the same as a right one. Every
// failure returns the same error.
func (s *Service) Authenticate(ctx context.Context, header string) (Principal, error) {
	publicID, secret, ok := parseAuthorization(header)
	if !ok {
		return Principal{}, ErrUnauthenticated
	}

	var (
		id            uuid.UUID
		name          string
		storedHash    []byte
		scopes        []string
		dataSourceIDs []uuid.UUID
		createdBy     *uuid.UUID
		expiresAt     *time.Time
		revokedAt     *time.Time
	)
	err := s.db.QueryRow(ctx, `
		SELECT id,name,secret_hash,scopes,data_source_ids,created_by,expires_at,revoked_at
		FROM integration_tokens WHERE public_id=$1`, publicID).
		Scan(&id, &name, &storedHash, &scopes, &dataSourceIDs, &createdBy, &expiresAt, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrUnauthenticated
	}
	if err != nil {
		return Principal{}, err
	}

	if !credential.Matches(secret, storedHash) {
		return Principal{}, ErrUnauthenticated
	}
	if revokedAt != nil || (expiresAt != nil && !expiresAt.After(time.Now())) {
		return Principal{}, ErrUnauthenticated
	}
	// A token is attributed to the account that created it. Without one there is
	// nobody to attribute a change to, so the token stops working.
	if createdBy == nil {
		return Principal{}, ErrUnauthenticated
	}

	// Best effort: a failed timestamp update must not fail the request.
	_, _ = s.db.Exec(ctx, `UPDATE integration_tokens SET last_used_at=now() WHERE id=$1`, id)

	return Principal{
		TokenID: id, Name: name, Scopes: scopes,
		DataSourceIDs: dataSourceIDs, ActingUser: *createdBy,
	}, nil
}

// parseAuthorization splits an Authorization header into the public id and the
// secret. It does no lookup, so a malformed header costs nothing.
func parseAuthorization(header string) (string, string, bool) {
	return credential.ParseBearer(header, TokenPrefix)
}

func (s *Service) get(ctx context.Context, id uuid.UUID) (Token, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id,name,public_id,scopes,data_source_ids,created_at,created_by,
		       expires_at,last_used_at,revoked_at
		FROM integration_tokens WHERE id=$1`, id)
	if err != nil {
		return Token{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Token{}, ErrNotFound
	}
	return scanToken(rows)
}

func scanToken(rows pgx.Rows) (Token, error) {
	var token Token
	err := rows.Scan(&token.ID, &token.Name, &token.PublicID, &token.Scopes,
		&token.DataSourceIDs, &token.CreatedAt, &token.CreatedBy,
		&token.ExpiresAt, &token.LastUsedAt, &token.RevokedAt)
	return token, err
}

// newCredential generates the public id and the secret.
func newCredential() (string, string, error) { return credential.New() }

func normalizeScopes(scopes []string) ([]string, error) {
	if len(scopes) == 0 {
		return nil, fmt.Errorf("%w: choose at least one capability", ErrValidation)
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		switch scope {
		case ScopeDataSourceWrite, ScopeActivityRead:
		default:
			return nil, fmt.Errorf("%w: unknown capability %q", ErrValidation, scope)
		}
		if !seen[scope] {
			seen[scope] = true
			out = append(out, scope)
		}
	}
	return out, nil
}

func containsScope(scopes []string, scope string) bool {
	for _, held := range scopes {
		if held == scope {
			return true
		}
	}
	return false
}
