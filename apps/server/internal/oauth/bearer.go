package oauth

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// BearerKind names which user token family a presented secret belongs to.
// The prefix always reveals the kind: tca_ is an OAuth access token and
// tcp_ is a personal access token. Anything else — a device credential, an
// integration token, a refresh secret — is not a user Bearer [REDACTED]
type BearerKind string

const (
	BearerKindOAuth BearerKind = "oauth"
	BearerKindPAT   BearerKind = "pat"
)

// BearerGrant is the live grant behind one presented user token.
type BearerGrant struct {
	GrantID     uuid.UUID
	UserID      uuid.UUID
	Scopes      []string
	ClientID    string
	DisplayName string
	Kind        BearerKind
}

// LookupBearer resolves an OAuth access secret or PAT secret to its live
// grant. Expired tokens, revoked grants, and any secret without a user
// token prefix all resolve to an error, so an inert token behaves exactly
// like an unknown one. A successful lookup refreshes the grant's
// last-used timestamp, throttled to one write per five minutes so reads
// stay cheap.
//
// The grant kind alone never proves which program sent the request: an
// OAuth grant for tilecast-cli and a PAT both arrive as Bearer [REDACTED]
// Audit attribution maps OAuth client IDs to their surface and records
// every PAT as api; see auditSurfaceForGrant.
func (s *Service) LookupBearer(ctx context.Context, secret string) (BearerGrant, error) {
	var grant BearerGrant
	switch {
	case strings.HasPrefix(secret, AccessPrefix):
		grant.Kind = BearerKindOAuth
		var clientID *string
		err := s.db.QueryRow(ctx, `SELECT t.grant_id,g.user_id,g.scopes,g.client_id
			FROM oauth_access_tokens t
			JOIN api_grants g ON g.id=t.grant_id
			WHERE t.token_hash=$1 AND t.expires_at>now() AND g.kind='oauth' AND g.revoked_at IS NULL`,
			hashSecret(secret)).Scan(&grant.GrantID, &grant.UserID, &grant.Scopes, &clientID)
		if err != nil {
			return BearerGrant{}, ErrTokenExpired
		}
		if clientID != nil {
			grant.ClientID = *clientID
		}
		display, ok := DisplayNameForClient(grant.ClientID)
		if !ok {
			return BearerGrant{}, ErrTokenExpired
		}
		grant.DisplayName = display
	case strings.HasPrefix(secret, PATPrefix):
		grant.Kind = BearerKindPAT
		var name *string
		err := s.db.QueryRow(ctx, `SELECT t.grant_id,g.user_id,g.scopes,g.name
			FROM oauth_access_tokens t
			JOIN api_grants g ON g.id=t.grant_id
			WHERE t.token_hash=$1 AND t.expires_at>now() AND g.kind='pat' AND g.revoked_at IS NULL`,
			hashSecret(secret)).Scan(&grant.GrantID, &grant.UserID, &grant.Scopes, &name)
		if err != nil {
			return BearerGrant{}, ErrPATExpired
		}
		if name != nil {
			grant.DisplayName = *name
		}
	default:
		return BearerGrant{}, ErrTokenExpired
	}
	if _, err := s.db.Exec(ctx, `UPDATE api_grants SET last_used_at=now() WHERE id=$1
		AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`, grant.GrantID); err != nil {
		return BearerGrant{}, fmt.Errorf("touch grant: %w", err)
	}
	return grant, nil
}

// bearerKindString reports the auth method label for a Bearer [REDACTED]
func bearerKindString(kind BearerKind) string {
	if kind == BearerKindPAT {
		return "pat"
	}
	return "oauth"
}

// BearerAuthMethod reports the principal auth method for a Bearer [REDACTED]
func (grant BearerGrant) BearerAuthMethod() string {
	return bearerKindString(grant.Kind)
}
