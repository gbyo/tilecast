package authflow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestChallengeVector(t *testing.T) {
	// RFC 7636 Appendix B.
	if got := Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatalf("challenge = %q", got)
	}
	verifier, err := NewVerifier()
	if err != nil || verifier == "" {
		t.Fatal(err)
	}
	state, err := NewState()
	if err != nil || state == "" {
		t.Fatal(err)
	}
}

func TestAuthorizeURLUsesStudioApprovalRoute(t *testing.T) {
	got := AuthorizeURL(
		"https://tilecast.example.com/",
		"http://127.0.0.1:56723/callback",
		"read write",
		"state-1",
		"challenge-1",
	)
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/oauth/approve" {
		t.Fatalf("approval path = %q, want /oauth/approve", parsed.Path)
	}
	query := parsed.Query()
	want := map[string]string{
		"client_id":             ClientID,
		"redirect_uri":          "http://127.0.0.1:56723/callback",
		"scope":                 "read write",
		"state":                 "state-1",
		"code_challenge":        "challenge-1",
		"code_challenge_method": "S256",
	}
	for key, value := range want {
		if query.Get(key) != value {
			t.Fatalf("%s = %q, want %q", key, query.Get(key), value)
		}
	}
}

func fakeServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, data any) {
		raw, _ := json.Marshal(map[string]any{"data": data})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}
	mux.HandleFunc("/api/v1/system/identity", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"product": "tilecast", "installationId": "inst-1", "organizationName": "Test", "apiVersion": "v1"})
	})
	mux.HandleFunc("/api/v1/auth/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer tca_live" {
			write(w, map[string]any{"setupRequired": false, "authenticated": true,
				"user": map[string]any{"username": "op", "name": "Op", "role": "owner"}, "authMethod": "oauth"})
			return
		}
		write(w, map[string]any{"setupRequired": false, "authenticated": false})
	})
	mux.HandleFunc("/api/v1/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["grant_type"] == "authorization_code" && body["code"] == "code-1" && body["code_verifier"] != "" {
			write(w, map[string]any{"access_token": "tca_a1", "refresh_token": "tcr_r1", "token_type": "Bearer", "expires_at": time.Now().Add(time.Hour).UTC()})
			return
		}
		if body["grant_type"] == "refresh_token" && body["refresh_token"] == "tcr_r1" {
			write(w, map[string]any{"access_token": "tca_a2", "refresh_token": "tcr_r2", "token_type": "Bearer", "expires_at": time.Now().Add(time.Hour).UTC()})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"code":"invalid_grant","message":"no"}}`))
	})
	mux.HandleFunc("/api/v1/oauth/revoke", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		_, _ = w.Write([]byte(`{"data":{}}`))
	})
	return httptest.NewServer(mux)
}

func TestFetchIdentity(t *testing.T) {
	server := fakeServer(t)
	defer server.Close()
	identity, err := FetchIdentity(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if identity.InstallationID != "inst-1" || identity.Product != "tilecast" {
		t.Fatalf("identity = %+v", identity)
	}
}

func TestFetchIdentityRejectsForeignProduct(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"product":"other"}}`))
	}))
	defer server.Close()
	if _, err := FetchIdentity(context.Background(), server.URL); err == nil {
		t.Fatal("foreign product accepted")
	}
}

func TestExchangeAndRotate(t *testing.T) {
	server := fakeServer(t)
	defer server.Close()
	ctx := context.Background()
	tokens, err := Exchange(ctx, server.URL, "code-1", "http://127.0.0.1:9/callback", "verifier")
	if err != nil {
		t.Fatal(err)
	}
	if tokens.AccessToken != "tca_a1" || tokens.RefreshToken != "tcr_r1" || tokens.Expired() {
		t.Fatalf("tokens = %+v", tokens)
	}
	rotated, err := Rotate(ctx, server.URL, tokens.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.AccessToken != "tca_a2" || rotated.RefreshToken != "tcr_r2" {
		t.Fatalf("rotated = %+v", rotated)
	}
	if err := Revoke(ctx, server.URL, rotated.RefreshToken); err != nil {
		t.Fatal(err)
	}
	if _, err := Exchange(ctx, server.URL, "bad", "http://127.0.0.1:9/callback", "v"); err == nil {
		t.Fatal("bad code accepted")
	}
}

func TestWaitForCode(t *testing.T) {
	listener, err := Listen()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	var code string
	var waitErr error
	go func() {
		defer close(done)
		code, waitErr = WaitForCode(ctx, listener, "state-1")
	}()
	url := RedirectURI(listener) + "?code=code-1&state=state-1"
	response, err := http.Get(url) //nolint:gosec,noctx
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	<-done
	if waitErr != nil || code != "code-1" {
		t.Fatalf("code = %q, err = %v", code, waitErr)
	}
}

func TestWaitForCodeRefusesMismatchAndDenial(t *testing.T) {
	for _, target := range []string{"?code=code-1&state=other", "?error=access_denied&state=state-1", "?state=state-1"} {
		listener, err := Listen()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		done := make(chan error, 1)
		go func() {
			_, err := WaitForCode(ctx, listener, "state-1")
			done <- err
		}()
		response, err := http.Get(RedirectURI(listener) + target) //nolint:gosec,noctx
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		response.Body.Close()
		if err := <-done; err == nil {
			t.Fatalf("target %q accepted", target)
		}
		cancel()
	}
}

func TestFetchStatusWhoami(t *testing.T) {
	server := fakeServer(t)
	defer server.Close()
	anon, err := FetchStatus(context.Background(), server.URL, "")
	if err != nil || anon.Authenticated {
		t.Fatalf("anon = %+v, %v", anon, err)
	}
	who, err := FetchStatus(context.Background(), server.URL, "tca_live")
	if err != nil || !who.Authenticated || who.User.Username != "op" || who.User.Role != "owner" {
		t.Fatalf("whoami = %+v, %v", who, err)
	}
}
