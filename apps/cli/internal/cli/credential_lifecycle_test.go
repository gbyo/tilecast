package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/cli/internal/authflow"
	"github.com/tilecast/tilecast/apps/cli/internal/config"
	"github.com/tilecast/tilecast/apps/cli/internal/secret"
)

func mustUpsertHome(t *testing.T, f *cliFixture) {
	t.Helper()
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
}

func mustStorePAT(t *testing.T, f *cliFixture, token string) {
	t.Helper()
	raw, _ := json.Marshal(storedCredential{Kind: credentialPAT, AccessToken: token})
	if err := f.env.secrets.Set(credentialAccount("home"), string(raw)); err != nil {
		t.Fatal(err)
	}
}

func TestStoredCredentialBoundToSavedServer(t *testing.T) {
	f := newFixture(t)
	mustUpsertHome(t, f)
	mustStorePAT(t, f, "tcp_home")
	t.Setenv("TILECAST_TOKEN", "")
	t.Setenv("TILECAST_URL", "")

	r := Resolver{ServerFlag: "https://other.example", Store: f.env.config, Secrets: f.env.secrets}
	if _, err := r.Resolve(true); err == nil || !strings.Contains(err.Error(), "TILECAST_TOKEN") {
		t.Fatalf("override resolve = %v, want explicit-token error", err)
	}
	t.Setenv("TILECAST_URL", "https://other.example")
	r = Resolver{Store: f.env.config, Secrets: f.env.secrets}
	if _, err := r.Resolve(true); err == nil || !strings.Contains(err.Error(), "TILECAST_TOKEN") {
		t.Fatalf("env override resolve = %v, want explicit-token error", err)
	}
	t.Setenv("TILECAST_URL", "")

	t.Setenv("TILECAST_TOKEN", "tcp_explicit")
	r = Resolver{ServerFlag: "https://other.example", Store: f.env.config, Secrets: f.env.secrets}
	resolved, err := r.Resolve(true)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ServerURL != "https://other.example" {
		t.Fatalf("server = %q", resolved.ServerURL)
	}
	t.Setenv("TILECAST_TOKEN", "")

	r = Resolver{ServerFlag: f.server.URL, Store: f.env.config, Secrets: f.env.secrets}
	resolved, err = r.Resolve(true)
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.FromStore {
		t.Fatalf("expected stored credential, got %+v", resolved)
	}
}

func TestExplicitServerAndTokenNeedNoSavedContext(t *testing.T) {
	f := newFixture(t)
	t.Setenv("TILECAST_CONTEXT", "")
	t.Setenv("TILECAST_URL", "https://signage.example.org")
	t.Setenv("TILECAST_TOKEN", "tcp_ci")
	r := Resolver{Store: f.env.config, Secrets: f.env.secrets}
	resolved, err := r.Resolve(true)
	if err != nil {
		t.Fatalf("env-only resolve = %v, want success", err)
	}
	if resolved.ServerURL != "https://signage.example.org" || resolved.Bearer != "tcp_ci" || resolved.FromStore {
		t.Fatalf("resolved = %+v", resolved)
	}

	t.Setenv("TILECAST_URL", "")
	r = Resolver{ServerFlag: "https://signage.example.org", Store: f.env.config, Secrets: f.env.secrets}
	if _, err := r.Resolve(true); err != nil {
		t.Fatalf("flag-only resolve = %v, want success", err)
	}

	// Without a token, a missing context still reports the login hint
	// instead of an empty stored-credential error.
	t.Setenv("TILECAST_TOKEN", "")
	if _, err := r.Resolve(true); !errors.Is(err, config.ErrNoCurrentContext) {
		t.Fatalf("no-token resolve = %v, want ErrNoCurrentContext", err)
	}
	// Anonymous calls such as status need only the server address.
	if _, err := r.Resolve(false); err != nil {
		t.Fatalf("anonymous resolve = %v, want success", err)
	}
	// No server and no context is still an error.
	r = Resolver{Store: f.env.config, Secrets: f.env.secrets}
	if _, err := r.Resolve(false); !errors.Is(err, config.ErrNoCurrentContext) {
		t.Fatalf("empty resolve = %v, want ErrNoCurrentContext", err)
	}
}

func TestServerURLPolicyEnforcedCentrally(t *testing.T) {
	f := newFixture(t)
	mustUpsertHome(t, f)
	mustStorePAT(t, f, "tcp_home")
	t.Setenv("TILECAST_TOKEN", "")
	t.Setenv("TILECAST_URL", "")

	for _, raw := range []string{"http://public.example", "http://public.example:8080/path"} {
		r := Resolver{ServerFlag: raw, Store: f.env.config, Secrets: f.env.secrets}
		if _, err := r.Resolve(false); err == nil || !strings.Contains(err.Error(), "plain HTTP") {
			t.Fatalf("server %q resolve = %v, want public-HTTP refusal", raw, err)
		}
	}
	t.Setenv("TILECAST_URL", "http://public.example")
	if _, err := (Resolver{Store: f.env.config, Secrets: f.env.secrets}).Resolve(false); err == nil {
		t.Fatal("TILECAST_URL public HTTP accepted")
	}
	t.Setenv("TILECAST_URL", "")

	if err := f.env.config.Upsert(config.Context{Name: "plain", ServerURL: "http://public.example"}, false); err != nil {
		t.Fatal(err)
	}
	r := Resolver{ContextFlag: "plain", Store: f.env.config, Secrets: f.env.secrets}
	if _, err := r.Resolve(false); err == nil {
		t.Fatal("context public HTTP accepted")
	}

	for _, raw := range []string{"https://public.example", "http://127.0.0.1:8080", "http://192.168.1.10", "http://10.0.0.5", "http://printer.local"} {
		r := Resolver{ServerFlag: raw, Store: f.env.config, Secrets: f.env.secrets}
		if _, err := r.Resolve(false); err != nil {
			t.Fatalf("server %q rejected: %v", raw, err)
		}
	}
}

func TestConcurrentRefreshRedeemsOnce(t *testing.T) {
	f := newFixture(t)
	mustUpsertHome(t, f)
	stale, _ := json.Marshal(storedCredential{Kind: credentialOAuth, AccessToken: "tca_old", RefreshToken: "tcr_r1", ExpiresAt: time.Now().Add(-time.Hour)})
	if err := f.env.secrets.Set(credentialAccount("home"), string(stale)); err != nil {
		t.Fatal(err)
	}
	old := rotateTokens
	t.Cleanup(func() { rotateTokens = old })
	var calls atomic.Int32
	rotateTokens = func(ctx context.Context, serverURL, refresh string) (authflow.Tokens, error) {
		calls.Add(1)
		time.Sleep(200 * time.Millisecond)
		if refresh != "tcr_r1" {
			return authflow.Tokens{}, fmt.Errorf("reused refresh token")
		}
		return authflow.Tokens{AccessToken: "tca_new", RefreshToken: "tcr_r2", ExpiresAt: time.Now().Add(time.Hour)}, nil
	}
	provider := lockedProvider(f.env.config, f.env.secrets, "home", f.server.URL, "tca_old")
	var wg sync.WaitGroup
	results := make([]string, 2)
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			token, err := provider(context.Background())
			results[i] = token
			errs[i] = err
		}(i)
	}
	wg.Wait()
	for i := range errs {
		if errs[i] != nil {
			t.Fatalf("provider %d: %v", i, errs[i])
		}
		if results[i] != "tca_new" {
			t.Fatalf("provider %d = %q, want tca_new", i, results[i])
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("rotate called %d times, want 1", calls.Load())
	}
}

func TestProviderRotatesForLongLivedCaller(t *testing.T) {
	f := newFixture(t)
	mustUpsertHome(t, f)
	stale, _ := json.Marshal(storedCredential{Kind: credentialOAuth, AccessToken: "tca_old", RefreshToken: "tcr_r1", ExpiresAt: time.Now().Add(-time.Hour)})
	if err := f.env.secrets.Set(credentialAccount("home"), string(stale)); err != nil {
		t.Fatal(err)
	}
	old := rotateTokens
	t.Cleanup(func() { rotateTokens = old })
	var calls atomic.Int32
	rotateTokens = func(ctx context.Context, serverURL, refresh string) (authflow.Tokens, error) {
		calls.Add(1)
		return authflow.Tokens{AccessToken: "tca_fresh", RefreshToken: "tcr_r2", ExpiresAt: time.Now().Add(time.Hour)}, nil
	}
	t.Setenv("TILECAST_TOKEN", "")
	t.Setenv("TILECAST_URL", "")
	r := Resolver{Store: f.env.config, Secrets: f.env.secrets}
	resolved, err := r.Resolve(true)
	if err != nil {
		t.Fatal(err)
	}
	first, err := resolved.BearerFunc()(context.Background())
	if err != nil || first != "tca_fresh" {
		t.Fatalf("first = %q, %v", first, err)
	}
	second, err := resolved.BearerFunc()(context.Background())
	if err != nil || second != "tca_fresh" {
		t.Fatalf("second = %q, %v", second, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("rotate called %d times, want 1", calls.Load())
	}
}

func TestNoArgvSecretFlag(t *testing.T) {
	f := newFixture(t)
	root := NewRootCommandWithEnv(f.env)
	if flag := root.PersistentFlags().Lookup("token"); flag != nil {
		t.Fatalf("--token flag still present")
	}
}

type failingSecretStore struct {
	getErr error
	delErr error
}

func (s failingSecretStore) Set(account, sec string) error { return s.getErr }
func (s failingSecretStore) Get(account string) (string, error) {
	if s.getErr != nil {
		return "", s.getErr
	}
	return "", errors.New("unexpected")
}
func (s failingSecretStore) Delete(account string) error { return s.delErr }
func (s failingSecretStore) Check() error                { return nil }

func TestContextRenameRefusesOnKeyringFailure(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: "https://a.example"}, true); err != nil {
		t.Fatal(err)
	}
	f.env.secrets = failingSecretStore{getErr: errors.New("keyring down: boom")}
	if _, err := f.execute(t, "", "context", "rename", "home", "away"); err == nil {
		t.Fatal("rename succeeded despite keyring failure")
	}
	if _, err := f.env.config.Get("home"); err != nil {
		t.Fatalf("original context lost: %v", err)
	}
	if _, err := f.env.config.Get("away"); err == nil {
		t.Fatal("renamed context created despite keyring failure")
	}
}

func TestContextRemoveReportsCredentialFailure(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: "https://a.example"}, true); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(storedCredential{Kind: credentialPAT, AccessToken: "tcp_x"})
	mem := secret.NewMemoryStore()
	if err := mem.Set(credentialAccount("home"), string(raw)); err != nil {
		t.Fatal(err)
	}
	f.env.secrets = deleteFailStore{Store: mem}
	if _, err := f.execute(t, "", "context", "remove", "home"); err == nil {
		t.Fatal("remove succeeded despite credential deletion failure")
	}
	if _, err := f.env.config.Get("home"); err != nil {
		t.Fatalf("config removed despite credential failure: %v", err)
	}
}

type deleteFailStore struct {
	secret.Store
}

func (s deleteFailStore) Delete(account string) error {
	return errors.New("keyring down: delete boom")
}
