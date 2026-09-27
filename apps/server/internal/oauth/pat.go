// Personal access tokens ride the same grant model as OAuth grants and
// inherit the same live role and scope rules at use time: a request that
// presents a PAT is authorized as the owning user, who must still be
// active, with the grant's scopes as the ceiling. PATs differ only in
// shape and lifespan: they carry their own prefix so a token always
// reveals what it is, they expire (there is no permanent PAT), and they
// are created directly by the signed-in user rather than through a
// client-mediated approval.
//
// Only SHA-256 hashes reach PostgreSQL. The plaintext secret is returned
// to the caller exactly once at creation and is never stored or logged.
package oauth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	// PATPrefix marks personal access tokens for operators. PATs are the
	// only token type with this prefix; OAuth access and refresh tokens
	// use AccessPrefix and RefreshPrefix, and authorize codes use the
	// integration prefix, so a secret is never ambiguous about its kind.
	PATPrefix = "tcp_"

	// ClientPAT is the synthetic first-party client that owns PAT grants.
	// There is no approval or redirect flow behind it; the row exists so
	// PAT grants join the same client, scope, and revocation machinery.
	ClientPAT = "tilecast-pat"
)

// PATLifetimes lists the only lifespans a PAT may be created with, in
// days. Permanence is deliberately not an option: the picker makes a
// bounded lifetime the normal choice, and there is no renewal — a token
// that needs to live longer is replaced by creating a new one.
var PATLifetimes = []int{7, 30, 90, 365}

// PAT is one personal access token grant with its display metadata. The
// secret itself is never returned here; it exists only in the creation
// response.
type PAT struct {
	ID        uuid.UUID
	Name      string
	Scopes    []string
	CreatedAt time.Time
	// ExpiresAt is the token expiry. An expired PAT is inert for
	// authentication but stays listed until it is explicitly revoked.
	ExpiresAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

var (
	ErrBadPATName     = errors.New("PAT name must be 1-100 characters")
	ErrBadPATLifetime = errors.New("PAT lifetime must be one of 7, 30, 90, or 365 days")
	ErrPATExpired     = errors.New("personal access token expired or unknown")
)

// CreatePAT stores a new named PAT grant and returns the plaintext secret
// exactly once along with the grant record.
func (s *Service) CreatePAT(ctx context.Context, userID uuid.UUID, name string, scopes []string, lifetimeDays int) (secret string, pat PAT, err error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 100 {
		return "", PAT{}, ErrBadPATName
	}
	allowed := false
	for _, days := range PATLifetimes {
		if days == lifetimeDays {
			allowed = true
		}
	}
	if !allowed {
		return "", PAT{}, ErrBadPATLifetime
	}
	scopes, err = ValidateScopes(strings.Join(scopes, " "))
	if err != nil {
		return "", PAT{}, err
	}
	client, err := s.EnsureFirstParty(ctx, ClientPAT)
	if err != nil {
		return "", PAT{}, err
	}
	raw, err := randomSecret(32)
	if err != nil {
		return "", PAT{}, err
	}
	secret = PATPrefix + raw
	now := time.Now().UTC()
	pat = PAT{
		ID:        uuid.New(),
		Name:      name,
		Scopes:    scopes,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Duration(lifetimeDays) * 24 * time.Hour),
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", PAT{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,scopes,name) VALUES($1,$2,$3,$4,$5)`,
		pat.ID, userID, client.ID, scopes, name); err != nil {
		return "", PAT{}, fmt.Errorf("record PAT grant: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO oauth_access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,$3)`,
		hashSecret(secret), pat.ID, pat.ExpiresAt); err != nil {
		return "", PAT{}, fmt.Errorf("record PAT token: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", PAT{}, err
	}
	return secret, pat, nil
}

// ListPATs returns the user's PAT grants newest first with display
// metadata only. Expired and revoked PATs stay listed until revoked or,
// for expired ones, until explicitly revoked — expiry never deletes the
// record. An optional case-insensitive name filter backs the management
// search box.
func (s *Service) ListPATs(ctx context.Context, userID uuid.UUID, search string) ([]PAT, error) {
	search = strings.TrimSpace(search)
	rows, err := s.db.Query(ctx, `SELECT g.id,g.name,g.scopes,g.created_at,
		(SELECT max(t.expires_at) FROM oauth_access_tokens t WHERE t.grant_id=g.id),
		g.last_used_at,g.revoked_at
		FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id
		WHERE g.user_id=$1 AND c.name=$2 AND ($3='' OR g.name ILIKE '%'||$3||'%')
		ORDER BY g.created_at DESC,g.id DESC`, userID, ClientPAT, search)
	if err != nil {
		return nil, fmt.Errorf("list PATs: %w", err)
	}
	defer rows.Close()
	var pats []PAT
	for rows.Next() {
		var pat PAT
		var expires *time.Time
		if err := rows.Scan(&pat.ID, &pat.Name, &pat.Scopes, &pat.CreatedAt, &expires, &pat.LastUsedAt, &pat.RevokedAt); err != nil {
			return nil, fmt.Errorf("scan PAT: %w", err)
		}
		if expires != nil {
			pat.ExpiresAt = *expires
		}
		pats = append(pats, pat)
	}
	return pats, rows.Err()
}

// LookupPAT resolves a PAT secret to its live grant and user. Expired
// tokens and revoked grants are inert: they resolve to ErrPATExpired all
// the same, so an expired token behaves exactly like an unknown one.
func (s *Service) LookupPAT(ctx context.Context, secret string) (grantID, userID uuid.UUID, scopes []string, err error) {
	if !strings.HasPrefix(secret, PATPrefix) {
		return uuid.Nil, uuid.Nil, nil, ErrPATExpired
	}
	err = s.db.QueryRow(ctx, `SELECT t.grant_id,g.user_id,g.scopes FROM oauth_access_tokens t
		JOIN oauth_grants g ON g.id=t.grant_id
		JOIN oauth_clients c ON c.id=g.client_id AND c.name=$2
		WHERE t.token_hash=$1 AND t.expires_at>now() AND g.revoked_at IS NULL`, hashSecret(secret), ClientPAT).Scan(&grantID, &userID, &scopes)
	if err != nil {
		return uuid.Nil, uuid.Nil, nil, ErrPATExpired
	}
	return grantID, userID, scopes, nil
}
