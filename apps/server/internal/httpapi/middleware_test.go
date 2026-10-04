package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSecurityHeadersContentSecurityPolicy(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	handler := (&server{}).securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	handler.ServeHTTP(recorder, request)
	policy := recorder.Header().Get("Content-Security-Policy")
	if policy != dashboardContentSecurityPolicy {
		t.Fatalf("unexpected content security policy: %q", policy)
	}
	if strings.Contains(policy, "script-src 'self' 'unsafe-inline'") {
		t.Fatal("script-src must not allow unsafe inline scripts")
	}
	if !strings.Contains(policy, "connect-src 'self' https://tiles.openfreemap.org") {
		t.Fatal("connect-src must allow the OpenFreeMap style and tile origin")
	}
	if !strings.Contains(policy, "img-src 'self' data: https://images.unsplash.com https://tiles.openfreemap.org") {
		t.Fatal("img-src must allow OpenFreeMap raster and sprite resources")
	}
	if strings.Contains(policy, "connect-src *") || strings.Contains(policy, "connect-src 'self' https:") {
		t.Fatal("connect-src must remain scoped to explicit trusted origins")
	}
}

func TestRateLimiter(t *testing.T) {
	limiter := newRateLimiter(2, time.Minute)
	now := time.Now()
	if !limiter.allow("client", now) || !limiter.allow("client", now) {
		t.Fatal("expected first two requests to pass")
	}
	if limiter.allow("client", now) {
		t.Fatal("expected third request to be limited")
	}
	if !limiter.allow("client", now.Add(2*time.Minute)) {
		t.Fatal("expected request after reset to pass")
	}
	if !limiter.allow("client", now.Add(2*time.Minute)) {
		t.Fatal("expected second request after reset to pass")
	}
	if limiter.allow("client", now.Add(2*time.Minute)) {
		t.Fatal("expected limit to apply to the new window")
	}

	boundary := newRateLimiter(1, time.Minute)
	if !boundary.allow("exact", now) || !boundary.allow("exact", now.Add(time.Minute)) {
		t.Fatal("expected an exact expiry boundary to start a new window")
	}

	cleanup := newRateLimiter(1, time.Minute)
	cleanup.allow("expired", now)
	cleanup.allow("expired-too", now)
	cleanup.allow("fresh", now.Add(time.Minute))
	if len(cleanup.entries) != 1 {
		t.Fatalf("expected expired entries to be evicted, got %d", len(cleanup.entries))
	}
}
