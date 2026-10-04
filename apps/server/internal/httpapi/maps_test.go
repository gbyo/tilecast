package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestProxyOpenFreeMapForwardsPublicMapResponse(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/planet/latest/7/34/51.pbf" {
			t.Fatalf("unexpected upstream path: %s", r.URL.Path)
		}
		if r.URL.RawQuery != "foo=bar" {
			t.Fatalf("unexpected upstream query: %s", r.URL.RawQuery)
		}
		if got := r.Header.Get("If-None-Match"); got != `"tile-v1"` {
			t.Fatalf("If-None-Match = %q", got)
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("ETag", `"tile-v2"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte{1, 2, 3, 4})
	}))
	defer upstream.Close()

	base, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	router.Get("/api/v1/maps/openfreemap/*", func(w http.ResponseWriter, r *http.Request) {
		if err := proxyOpenFreeMap(w, r, upstream.Client(), base); err != nil {
			t.Fatalf("proxyOpenFreeMap: %v", err)
		}
	})

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/maps/openfreemap/planet/latest/7/34/51.pbf?foo=bar",
		nil,
	)
	request.Header.Set("If-None-Match", `"tile-v1"`)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/x-protobuf" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=3600" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := response.Header().Get("ETag"); got != `"tile-v2"` {
		t.Fatalf("ETag = %q", got)
	}
	if got := response.Body.Bytes(); len(got) != 4 || got[0] != 1 || got[3] != 4 {
		t.Fatalf("unexpected body: %v", got)
	}
}

func TestProxyOpenFreeMapPreservesUpstreamStatus(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "upstream failure", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	base, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	router.Get("/api/v1/maps/openfreemap/*", func(w http.ResponseWriter, r *http.Request) {
		if err := proxyOpenFreeMap(w, r, upstream.Client(), base); err != nil {
			t.Fatalf("proxyOpenFreeMap: %v", err)
		}
	})

	response := httptest.NewRecorder()
	router.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/api/v1/maps/openfreemap/styles/liberty", nil),
	)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", response.Code)
	}
	body, err := io.ReadAll(response.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "upstream failure\n" {
		t.Fatalf("body = %q", string(body))
	}
}
