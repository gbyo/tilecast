package oauth

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestPATLifecycle(t *testing.T) {
	service, owner := testService(t)
	ctx := context.Background()

	secret, pat, err := service.CreatePAT(ctx, owner, "ci-deploy", []string{"read", "write"}, 30)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(secret, PATPrefix) {
		t.Fatalf("PAT secret has wrong prefix: %q", secret)
	}
	for _, prefix := range []string{AccessPrefix, RefreshPrefix} {
		if strings.HasPrefix(secret, prefix) {
			t.Fatalf("PAT secret collides with another token prefix: %q", secret)
		}
	}
	if pat.Name != "ci-deploy" {
		t.Fatalf("PAT name = %q, want ci-deploy", pat.Name)
	}
	if until := time.Until(pat.ExpiresAt); until <= 29*24*time.Hour || until > 30*24*time.Hour {
		t.Fatalf("PAT lifetime off: expires in %v, want ~30d", until)
	}

	grantID, userID, scopes, err := service.LookupPAT(ctx, secret)
	if err != nil {
		t.Fatal(err)
	}
	if grantID != pat.ID || userID != owner {
		t.Fatal("PAT lookup resolved the wrong grant or user")
	}
	if len(scopes) != 2 || scopes[0] != "read" || scopes[1] != "write" {
		t.Fatalf("PAT scopes = %v, want [read write]", scopes)
	}

	listed, err := service.ListPATs(ctx, owner, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].ID != pat.ID || listed[0].Name != "ci-deploy" {
		t.Fatalf("PAT list = %+v, want the one created token", listed)
	}
	filtered, err := service.ListPATs(ctx, owner, "DEPLOY")
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 {
		t.Fatalf("case-insensitive search missed the PAT: %+v", filtered)
	}
	missed, err := service.ListPATs(ctx, owner, "no-such-token")
	if err != nil {
		t.Fatal(err)
	}
	if len(missed) != 0 {
		t.Fatalf("search for unknown name returned %+v", missed)
	}

	if err := service.RevokeGrant(ctx, owner, pat.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := service.LookupPAT(ctx, secret); err == nil {
		t.Fatal("revoked PAT still authenticates")
	}
	// Revoked PATs stay listed so the user can see what was revoked.
	listed, err = service.ListPATs(ctx, owner, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].RevokedAt == nil {
		t.Fatalf("revoked PAT vanished from the list: %+v", listed)
	}
}

func TestPATValidation(t *testing.T) {
	service, owner := testService(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name   string
		pat    string
		scopes []string
		days   int
		want   error
	}{
		{"empty name", "", []string{"read"}, 30, ErrBadPATName},
		{"blank name", "   ", []string{"read"}, 30, ErrBadPATName},
		{"bad scope", "x", []string{"superuser"}, 30, ErrBadScope},
		{"no scopes", "x", nil, 30, ErrBadScope},
		{"zero lifetime", "x", []string{"read"}, 0, ErrBadPATLifetime},
		{"permanent lifetime", "x", []string{"read"}, -1, ErrBadPATLifetime},
		{"unlisted lifetime", "x", []string{"read"}, 45, ErrBadPATLifetime},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := service.CreatePAT(ctx, owner, tc.pat, tc.scopes, tc.days); err == nil {
				t.Fatal("creation succeeded, want an error")
			}
		})
	}
}

func TestPATExpiryIsInertButVisible(t *testing.T) {
	service, owner := testService(t)
	ctx := context.Background()

	secret, pat, err := service.CreatePAT(ctx, owner, "short-lived", []string{"read"}, 7)
	if err != nil {
		t.Fatal(err)
	}
	// Force expiry directly: the service offers no renewal or extension.
	if _, err := service.db.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=now()-interval '1 minute' WHERE grant_id=$1`, pat.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := service.LookupPAT(ctx, secret); err == nil {
		t.Fatal("expired PAT still authenticates")
	}
	listed, err := service.ListPATs(ctx, owner, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || !listed[0].ExpiresAt.Before(time.Now()) {
		t.Fatalf("expired PAT vanished instead of staying visible: %+v", listed)
	}
}

func TestPATPrefixNeverAuthenticatesAsOAuth(t *testing.T) {
	service, owner := testService(t)
	ctx := context.Background()

	secret, _, err := service.CreatePAT(ctx, owner, "kind-check", []string{"read"}, 7)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.LookupAccess(ctx, secret); err == nil {
		t.Fatal("PAT secret resolved as an OAuth access token")
	}
}
