package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gen "github.com/tilecast/tilecast/packages/api-client/internal/generated"
)

func fakeTilecast(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, data any) {
		raw, _ := json.Marshal(map[string]any{"data": data})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}
	fail := func(w http.ResponseWriter, status int, code, message string) {
		w.WriteHeader(status)
		raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": message}})
		_, _ = w.Write(raw)
	}
	mux.HandleFunc("/api/v1/system/identity", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Request-ID") == "" || !strings.HasPrefix(r.Header.Get("User-Agent"), "tilecast") {
			t.Error("identity call misses transport headers")
		}
		write(w, map[string]any{"product": "tilecast", "installationId": "123e4567-e89b-12d3-a456-426614174000", "organizationName": "Test", "apiVersion": "v1"})
	})
	mux.HandleFunc("/api/v1/auth/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer tca_live" {
			write(w, map[string]any{"setupRequired": false, "authenticated": true,
				"user": map[string]any{"username": "op", "role": "owner"}})
			return
		}
		write(w, map[string]any{"setupRequired": false, "authenticated": false})
	})
	mux.HandleFunc("/api/v1/screens", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tca_live" {
			fail(w, http.StatusUnauthorized, "authentication_required", "no")
			return
		}
		write(w, map[string]any{"screens": []any{map[string]any{"id": "s1"}}})
	})
	mux.HandleFunc("/api/v1/settings", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "revision_conflict", "message": "stale"},
			"data": map[string]any{"expectedRevision": 3, "currentRevision": 5}})
		_, _ = w.Write(raw)
	})
	mux.HandleFunc("/api/v1/blob", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		write(w, map[string]any{"bytes": len(body)})
	})
	return httptest.NewServer(mux)
}

func TestProbeAnonymousAndBearer(t *testing.T) {
	server := fakeTilecast(t)
	defer server.Close()
	anon, err := New(server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	caps, err := anon.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if caps.InstallationID != "123e4567-e89b-12d3-a456-426614174000" || caps.Authenticated {
		t.Fatalf("anon caps = %+v", caps)
	}
	if err := caps.RequireAPIVersion("v1"); err != nil {
		t.Fatal(err)
	}
	if err := caps.RequireAPIVersion("v9"); err == nil {
		t.Fatal("wrong API version accepted")
	}
	authed, err := New(server.URL, func(ctx context.Context) (string, error) { return "tca_live", nil })
	if err != nil {
		t.Fatal(err)
	}
	caps, err = authed.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !caps.Authenticated || caps.Username != "op" || caps.Role != "owner" {
		t.Fatalf("authed caps = %+v", caps)
	}
}

func TestListScreensThroughGenerated(t *testing.T) {
	server := fakeTilecast(t)
	defer server.Close()
	c, err := New(server.URL, func(ctx context.Context) (string, error) { return "tca_live", nil })
	if err != nil {
		t.Fatal(err)
	}
	editor, err := c.editor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	response, err := c.inner.ListScreensWithResponse(context.Background(), editor)
	if err != nil {
		t.Fatal(err)
	}
	var screens []map[string]any
	if err := DecodeData(response.StatusCode(), response.Body, "screens", &screens); err != nil {
		t.Fatal(err)
	}
	if len(screens) != 1 || screens[0]["id"] != "s1" {
		t.Fatalf("screens = %v", screens)
	}
}

func TestTypedErrors(t *testing.T) {
	server := fakeTilecast(t)
	defer server.Close()
	c, err := New(server.URL, func(ctx context.Context) (string, error) { return "tcp_bad", nil })
	if err != nil {
		t.Fatal(err)
	}
	editor, err := c.editor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	response, err := c.inner.ListScreensWithResponse(context.Background(), editor)
	if err != nil {
		t.Fatal(err)
	}
	var screens []map[string]any
	err = DecodeData(response.StatusCode(), response.Body, "screens", &screens)
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != http.StatusUnauthorized || apiErr.Code != "authentication_required" {
		t.Fatalf("error = %v", err)
	}
}

func TestConflictCarriesRevisions(t *testing.T) {
	server := fakeTilecast(t)
	defer server.Close()
	c, err := New(server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	editor, err := c.editor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	response, err := c.inner.UpdateSettingsWithResponse(context.Background(), nil, gen.SettingsUpdate{}, editor)
	if err != nil {
		t.Fatal(err)
	}
	err = DecodeBody(response.StatusCode(), response.Body, nil)
	conflict, ok := err.(*ConflictError)
	if !ok || conflict.Code != "revision_conflict" {
		t.Fatalf("error = %v", err)
	}
}

func TestDownloadUploadRoundTrip(t *testing.T) {
	server := fakeTilecast(t)
	defer server.Close()
	c, err := New(server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		Bytes int `json:"bytes"`
	}
	if err := c.Upload(context.Background(), "/api/v1/blob", "application/octet-stream", strings.NewReader("hello"), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Bytes != 5 {
		t.Fatalf("upload answer = %+v", answer)
	}
	key1, err := NewIdempotencyKey()
	if err != nil {
		t.Fatal(err)
	}
	key2, err := NewIdempotencyKey()
	if err != nil {
		t.Fatal(err)
	}
	if key1 == key2 || len(key1) != 32 {
		t.Fatalf("idempotency keys = %q %q", key1, key2)
	}
}

func TestRawCallIsLimitedToPluginAutomation(t *testing.T) {
	client, err := New("https://tilecast.example", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/v1/screens", "/api/v1/plugins/../screens", "/api/v1/plugins/%2e%2e/screens",
		"https://other.example/api/v1/plugins/x", "/api/v1/plugins//x",
	} {
		if _, _, err := client.Call(context.Background(), http.MethodGet, path, nil); err == nil {
			t.Fatalf("raw call accepted %q", path)
		}
	}
}
