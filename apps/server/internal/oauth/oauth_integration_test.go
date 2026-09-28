package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func testService(t *testing.T) (*Service, uuid.UUID) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) }) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := pool.Exec(ctx, `TRUNCATE oauth_refresh_tokens,oauth_access_tokens,oauth_authorization_codes,api_grants,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{
		OrganizationName: "OAuth Test",
		OwnerName:        "Owner",
		Username:         "oauth-owner",
		Password:         "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewService(pool), owner.User.ID
}

func pkce(t *testing.T) (verifier, challenge string) {
	t.Helper()
	verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	digest := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(digest[:])
}

func TestFirstPartyClientIDsAreStableProtocolConstants(t *testing.T) {
	// The protocol client_id is the identity: no rows, no randomness, no
	// lookup table. The wire value tilecast-cli is validated as-is.
	for _, id := range []string{ClientCLI, ClientMCP} {
		display, ok := DisplayNameForClient(id)
		if !ok || display == "" || display == id {
			t.Fatalf("client %q has no display name", id)
		}
	}
	if _, ok := DisplayNameForClient("partner-x"); ok {
		t.Fatal("unknown client accepted, want rejection")
	}
	if _, ok := DisplayNameForClient("tilecast-pat"); ok {
		t.Fatal("PAT pseudo-client accepted, want rejection: PATs are not OAuth clients")
	}
}

func TestAuthorizeValidation(t *testing.T) {
	service, _ := testService(t)
	ctx := context.Background()
	verifier, challenge := pkce(t)
	valid := func() (string, string, string, string, string, string) {
		return ClientCLI, "http://127.0.0.1:8471/callback", "read write", "state-1", challenge, "S256"
	}
	c0, r0, s0, st0, ch0, m0 := valid()
	if _, err := service.ValidateAuthorize(ctx, c0, r0, s0, st0, ch0, m0); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	if _, err := service.ValidateAuthorize(ctx, c0, "http://[::1]:8471/callback", s0, st0, ch0, m0); err != nil {
		t.Fatalf("IPv6 loopback rejected: %v", err)
	}
	cases := map[string]func() (string, string, string, string, string, string){
		"unknown client": func() (string, string, string, string, string, string) {
			_, r, s, st, ch, m := valid()
			return "partner-x", r, s, st, ch, m
		},
		"public redirect": func() (string, string, string, string, string, string) {
			c, _, s, st, ch, m := valid()
			return c, "https://example.com/callback", s, st, ch, m
		},
		"localhost hostname": func() (string, string, string, string, string, string) {
			c, _, s, st, ch, m := valid()
			return c, "http://localhost:8471/callback", s, st, ch, m
		},
		"bad scope": func() (string, string, string, string, string, string) {
			c, r, _, st, ch, m := valid()
			return c, r, "root", st, ch, m
		},
		"empty scope": func() (string, string, string, string, string, string) {
			c, r, _, st, ch, m := valid()
			return c, r, "", st, ch, m
		},
		"plain challenge": func() (string, string, string, string, string, string) {
			c, r, s, st, _, _ := valid()
			return c, r, s, st, verifier, "plain"
		},
		"missing challenge": func() (string, string, string, string, string, string) {
			c, r, s, st, _, m := valid()
			return c, r, s, st, "", m
		},
	}
	for name, build := range cases {
		c, r, s, st, ch, m := build()
		if _, err := service.ValidateAuthorize(ctx, c, r, s, st, ch, m); err == nil {
			t.Fatalf("%s accepted, want an error", name)
		}
	}
}

func TestApproveExchangeRefreshReuseRevoke(t *testing.T) {
	service, userID := testService(t)
	ctx := context.Background()
	verifier, challenge := pkce(t)
	req, err := service.ValidateAuthorize(ctx, ClientCLI, "http://127.0.0.1:8471/callback", "read", "s", challenge, "S256")
	if err != nil {
		t.Fatal(err)
	}
	code, err := service.Approve(ctx, userID, req)
	if err != nil {
		t.Fatal(err)
	}
	tokens, grantID, err := service.Exchange(ctx, ClientCLI, code, "http://127.0.0.1:8471/callback", verifier)
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if _, _, err := service.Exchange(ctx, ClientCLI, code, "http://127.0.0.1:8471/callback", verifier); err == nil {
		t.Fatal("code reused, want an error")
	}
	if _, _, err := service.Exchange(ctx, ClientCLI, code, "http://127.0.0.1:8471/callback", "wrong-verifier"); err == nil {
		t.Fatal("wrong verifier accepted, want an error")
	}
	if _, _, err := service.LookupAccess(ctx, tokens.AccessToken); err != nil {
		t.Fatalf("fresh access token unknown: %v", err)
	}
	rotated, rotatedGrant, reused, err := service.Refresh(ctx, tokens.RefreshToken)
	if err != nil || reused || rotatedGrant != grantID {
		t.Fatalf("refresh = %v reused=%v err=%v", rotatedGrant, reused, err)
	}
	if _, _, err := service.LookupAccess(ctx, tokens.AccessToken); err != nil {
		t.Fatalf("old access token died on rotation: %v", err)
	}
	if _, _, reused, err := service.Refresh(ctx, tokens.RefreshToken); !reused || err == nil {
		t.Fatalf("reused refresh accepted: reused=%v err=%v", reused, err)
	}
	if _, _, err := service.LookupAccess(ctx, rotated.AccessToken); err == nil {
		t.Fatal("grant survived reuse detection, want revocation")
	}
	grants, err := service.ListGrants(ctx, userID)
	if err != nil || len(grants) != 1 || grants[0].RevokedAt == nil {
		t.Fatalf("grants = %+v err=%v", grants, err)
	}
	if _, err := service.RevokeCredential(ctx, rotated.RefreshToken); err != nil {
		t.Fatalf("revoke after reuse: %v", err)
	}
}

// TestConcurrentRefreshConsumesOnce proves a refresh secret cannot mint two
// token pairs: concurrent rotations serialize on the row lock, exactly one
// wins, and every loser takes the reuse path and revokes the grant.
func TestConcurrentRefreshConsumesOnce(t *testing.T) {
	service, userID := testService(t)
	ctx := context.Background()
	verifier, challenge := pkce(t)
	req, err := service.ValidateAuthorize(ctx, ClientCLI, "http://127.0.0.1:8471/callback", "read", "s", challenge, "S256")
	if err != nil {
		t.Fatal(err)
	}
	code, err := service.Approve(ctx, userID, req)
	if err != nil {
		t.Fatal(err)
	}
	tokens, grantID, err := service.Exchange(ctx, ClientCLI, code, "http://127.0.0.1:8471/callback", verifier)
	if err != nil {
		t.Fatal(err)
	}
	const racers = 8
	type outcome struct {
		access  string
		refresh string
		reused  bool
		err     error
	}
	results := make(chan outcome, racers)
	for i := 0; i < racers; i++ {
		go func() {
			rotated, _, reused, err := service.Refresh(ctx, tokens.RefreshToken)
			results <- outcome{access: rotated.AccessToken, refresh: rotated.RefreshToken, reused: reused, err: err}
		}()
	}
	var winners []outcome
	losers := 0
	for i := 0; i < racers; i++ {
		result := <-results
		if result.err == nil && !result.reused {
			winners = append(winners, result)
			continue
		}
		if result.reused {
			losers++
			continue
		}
		t.Fatalf("unexpected refresh outcome: reused=%v err=%v", result.reused, result.err)
	}
	if losers != racers-1 {
		t.Fatalf("losers = %d, want %d", losers, racers-1)
	}
	if len(winners) != 1 {
		t.Fatalf("winners = %d, want exactly 1", len(winners))
	}
	winner := winners[0]
	if winner.access == "" || winner.refresh == "" {
		t.Fatal("winner has empty tokens")
	}
	if winner.access == tokens.AccessToken || winner.refresh == tokens.RefreshToken {
		t.Fatal("winner reused the consumed secrets: rotation issued nothing new")
	}
	// The losers take the reuse path, which revokes the whole grant — so
	// the winner's access token is dead by assertion time. Revocation of
	// the grant is the proof the losers observed the winner's consume.
	grant, err := service.GrantByID(ctx, grantID)
	if err != nil {
		t.Fatal(err)
	}
	if grant.RevokedAt == nil {
		t.Fatal("grant survived concurrent reuse, want revocation")
	}
}

func TestRevokeGrantKillsTokens(t *testing.T) {
	service, userID := testService(t)
	ctx := context.Background()
	verifier, challenge := pkce(t)
	req, err := service.ValidateAuthorize(ctx, ClientMCP, "http://127.0.0.1:9000/cb", "read write", "", challenge, "S256")
	if err != nil {
		t.Fatal(err)
	}
	code, err := service.Approve(ctx, userID, req)
	if err != nil {
		t.Fatal(err)
	}
	tokens, grantID, err := service.Exchange(ctx, ClientMCP, code, "http://127.0.0.1:9000/cb", verifier)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeGrant(ctx, userID, grantID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.LookupAccess(ctx, tokens.AccessToken); err == nil {
		t.Fatal("access token lives after revocation")
	}
	if _, _, _, err := service.Refresh(ctx, tokens.RefreshToken); err == nil {
		t.Fatal("refresh token lives after revocation")
	}
	if err := service.RevokeGrant(ctx, userID, grantID); err == nil {
		t.Fatal("double revoke succeeded, want not-found")
	}
	other := uuid.New()
	if err := service.RevokeGrant(ctx, other, grantID); err == nil {
		t.Fatal("foreign revoke succeeded, want not-found")
	}
}
