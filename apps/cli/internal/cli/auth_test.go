package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
	"github.com/tilecast/tilecast/apps/cli/internal/secret"
)

type cliFixture struct {
	env     *environment
	revoked []string
	server  *httptest.Server
}

func newFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := &cliFixture{env: &environment{
		config:  config.NewStore(filepath.Join(t.TempDir(), "config.json")),
		secrets: secret.NewMemoryStore(),
	}}
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, data any) {
		raw, _ := json.Marshal(map[string]any{"data": data})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}
	mux.HandleFunc("/api/v1/system/identity", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"product": "tilecast", "installationId": "123e4567-e89b-12d3-a456-426614174000", "organizationName": "Test Org", "apiVersion": "v1"})
	})
	mux.HandleFunc("/api/v1/auth/status", func(w http.ResponseWriter, r *http.Request) {
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if bearer == "tca_a1" || bearer == "tca_a2" || strings.HasPrefix(bearer, "tcp_") {
			write(w, map[string]any{"setupRequired": false, "authenticated": true,
				"user": map[string]any{"username": "op", "name": "Op", "role": "owner"}, "authMethod": "oauth"})
			return
		}
		write(w, map[string]any{"setupRequired": false, "authenticated": false})
	})
	mux.HandleFunc("/api/v1/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case body["grant_type"] == "authorization_code" && strings.HasPrefix(body["code"], "code-"):
			write(w, map[string]any{"access_token": "tca_a1", "refresh_token": "tcr_r1", "token_type": "Bearer", "expires_at": time.Now().Add(time.Hour).UTC()})
		case body["grant_type"] == "refresh_token" && body["refresh_token"] == "tcr_r1":
			write(w, map[string]any{"access_token": "tca_a2", "refresh_token": "tcr_r2", "token_type": "Bearer", "expires_at": time.Now().Add(time.Hour).UTC()})
		default:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_grant","message":"no"}}`))
		}
	})
	mux.HandleFunc("/api/v1/oauth/revoke", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.revoked = append(f.revoked, body["token"])
		w.WriteHeader(http.StatusNoContent)
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *cliFixture) execute(t *testing.T, stdin string, args ...string) (string, error) {
	t.Helper()
	root := NewRootCommandWithEnv(f.env)
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	if stdin != "" {
		root.SetIn(strings.NewReader(stdin))
	}
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func TestContextCommands(t *testing.T) {
	f := newFixture(t)
	if out, err := f.execute(t, "", "context", "current"); err == nil || !strings.Contains(err.Error(), "no current context") {
		t.Fatalf("current empty = %q, %v", out, err)
	}
	for _, ctx := range []config.Context{
		{Name: "b", ServerURL: "https://b.example"},
		{Name: "a", ServerURL: "https://a.example"},
	} {
		if err := f.env.config.Upsert(ctx, false); err != nil {
			t.Fatal(err)
		}
	}
	out, err := f.execute(t, "", "context", "list")
	if err != nil || !strings.Contains(out, "a") || !strings.Contains(out, "b") {
		t.Fatalf("list = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "use", "a"); err != nil || !strings.Contains(out, `"a"`) {
		t.Fatalf("use = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "current"); err != nil || strings.TrimSpace(out) != "a" {
		t.Fatalf("current = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "context", "use", "missing"); err == nil {
		t.Fatal("use missing succeeded")
	}
	if out, err := f.execute(t, "", "context", "rename", "a", "home"); err != nil || !strings.Contains(out, `"home"`) {
		t.Fatalf("rename = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "remove", "home"); err != nil {
		t.Fatalf("remove = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "current"); err != nil || strings.TrimSpace(out) != "b" {
		t.Fatalf("current after remove = %q, %v", out, err)
	}
}

func TestWhoamiPrecedence(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	// Explicit flag beats a bad environment value.
	t.Setenv("TILECAST_TOKEN", "tcp_env")
	out, err := f.execute(t, "", "whoami", "--token", "tcp_flag")
	if err != nil || !strings.Contains(out, "op (owner)") {
		t.Fatalf("flag whoami = %q, %v", out, err)
	}
	// Environment beats the store (which is empty here).
	out, err = f.execute(t, "", "whoami")
	if err != nil || !strings.Contains(out, f.server.URL) {
		t.Fatalf("env whoami = %q, %v", out, err)
	}
	// Nothing anywhere fails with guidance, not a stack trace.
	t.Setenv("TILECAST_TOKEN", "")
	if _, err := f.execute(t, "", "whoami"); err == nil {
		t.Fatal("whoami without credential succeeded")
	}
}

func TestWhoamiRotatesStoredPair(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	stale, _ := json.Marshal(storedCredential{Kind: credentialOAuth, AccessToken: "tca_old", RefreshToken: "tcr_r1", ExpiresAt: time.Now().Add(-time.Hour)})
	if err := f.env.secrets.Set(credentialAccount("home"), string(stale)); err != nil {
		t.Fatal(err)
	}
	out, err := f.execute(t, "", "whoami")
	if err != nil || !strings.Contains(out, "op (owner)") {
		t.Fatalf("rotating whoami = %q, %v", out, err)
	}
	stored, err := readStored(f.env, "home")
	if err != nil || stored.AccessToken != "tca_a2" || stored.RefreshToken != "tcr_r2" {
		t.Fatalf("pair not persisted: %+v, %v", stored, err)
	}
}

func TestTokenStdinLogin(t *testing.T) {
	f := newFixture(t)
	out, err := f.execute(t, "tcp_setup-token\n", "auth", "login", f.server.URL, "--token-stdin", "--context-name", "ci")
	if err != nil || !strings.Contains(out, `Context "ci" is current`) {
		t.Fatalf("stdin login = %q, %v", out, err)
	}
	stored, err := readStored(f.env, "ci")
	if err != nil || stored.Kind != credentialPAT || stored.AccessToken != "tcp_setup-token" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	current, err := f.env.config.Current()
	if err != nil || current.InstallationID != "123e4567-e89b-12d3-a456-426614174000" || current.ServerURL != f.server.URL {
		t.Fatalf("context = %+v, %v", current, err)
	}
	// Re-login under the same name against a different installation refuses.
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"product":"tilecast","installationId":"inst-2","organizationName":"Other","apiVersion":"v1"}}`))
	}))
	defer other.Close()
	if _, err := f.execute(t, "tcp_other\n", "auth", "login", other.URL, "--token-stdin", "--context-name", "ci"); err == nil {
		t.Fatal("installation change accepted")
	}
	// A non-PAT on stdin is refused before any network verification.
	if _, err := f.execute(t, "tca_oauth-token\n", "auth", "login", f.server.URL, "--token-stdin"); err == nil {
		t.Fatal("non-PAT stdin accepted")
	}
}

func TestBrowserLoginLoop(t *testing.T) {
	f := newFixture(t)
	previous := openBrowserFunc
	openBrowserFunc = func(approvalURL string) error {
		parsed, err := url.Parse(approvalURL)
		if err != nil {
			return err
		}
		query := parsed.Query()
		if query.Get("client_id") != "tilecast-cli" || query.Get("code_challenge_method") != "S256" || query.Get("scope") != "read write" {
			t.Errorf("approval URL = %q", approvalURL)
		}
		redirect, err := url.Parse(query.Get("redirect_uri"))
		if err != nil {
			return err
		}
		redirect.RawQuery = url.Values{"code": {"code-9"}, "state": {query.Get("state")}}.Encode()
		response, err := http.Get(redirect.String()) //nolint:gosec,noctx
		if err != nil {
			return err
		}
		response.Body.Close()
		return nil
	}
	t.Cleanup(func() { openBrowserFunc = previous })
	out, err := f.execute(t, "", "auth", "login", f.server.URL)
	if err != nil || !strings.Contains(out, "Signed in to Test Org") {
		t.Fatalf("browser login = %q, %v", out, err)
	}
	stored, err := readStored(f.env, "127.0.0.1")
	if err != nil || stored.Kind != credentialOAuth || stored.AccessToken != "tca_a1" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
}

func TestAuthLogoutRevokesAndForgets(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	pair, _ := json.Marshal(storedCredential{Kind: credentialOAuth, AccessToken: "tca_a1", RefreshToken: "tcr_r1", ExpiresAt: time.Now().Add(time.Hour)})
	if err := f.env.secrets.Set(credentialAccount("home"), string(pair)); err != nil {
		t.Fatal(err)
	}
	out, err := f.execute(t, "", "auth", "logout")
	if err != nil || !strings.Contains(out, "Logged out") {
		t.Fatalf("logout = %q, %v", out, err)
	}
	if len(f.revoked) != 1 || f.revoked[0] != "tcr_r1" {
		t.Fatalf("revoked = %v", f.revoked)
	}
	if _, err := readStored(f.env, "home"); err == nil {
		t.Fatal("credential survived logout")
	}
}

func TestAuthStatusStates(t *testing.T) {
	f := newFixture(t)
	if _, err := f.execute(t, "", "auth", "status"); err == nil {
		t.Fatal("status without context succeeded")
	}
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	out, err := f.execute(t, "", "auth", "status")
	if err != nil || !strings.Contains(out, "none (run") {
		t.Fatalf("status = %q, %v", out, err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_x")
	out, err = f.execute(t, "", "auth", "status")
	if err != nil || !strings.Contains(out, "explicit bearer") {
		t.Fatalf("env status = %q, %v", out, err)
	}
}

func TestLoginRefusesBadServers(t *testing.T) {
	f := newFixture(t)
	if _, err := f.execute(t, "", "auth", "login", "http://example.com"); err == nil {
		t.Fatal("public HTTP accepted")
	}
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"product":"other"}}`))
	}))
	defer foreign.Close()
	if _, err := f.execute(t, "", "auth", "login", foreign.URL); err == nil {
		t.Fatal("foreign product accepted")
	}
	if _, err := f.execute(t, "", "auth", "login", f.server.URL, "--scopes", "superuser"); err == nil {
		t.Fatal("bad scope accepted")
	}
}
