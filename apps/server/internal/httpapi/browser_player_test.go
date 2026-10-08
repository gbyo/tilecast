package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

func TestBrowserOriginBoundary(t *testing.T) {
	s := &server{publicURL: "https://signage.example.org"}
	for _, test := range []struct {
		method, origin, site string
		allowed              bool
	}{
		{"POST", "https://signage.example.org", "same-origin", true},
		{"POST", "https://other.example.org", "cross-site", false},
		{"POST", "https://signage.example.org", "cross-site", false},
		{"POST", "", "same-origin", false},
		{"GET", "", "same-origin", true},
		{"GET", "", "same-site", false},
		{"GET", "", "", false},
		{"POST", "http://signage.example.org", "same-origin", false},
	} {
		r := httptest.NewRequest(test.method, "https://signage.example.org/api/v1/player/browser/session", nil)
		r.Header.Set("Origin", test.origin)
		r.Header.Set("Sec-Fetch-Site", test.site)
		if s.browserRequestAllowed(r) != test.allowed {
			t.Fatalf("incorrect origin decision for %s %s %s", test.method, test.origin, test.site)
		}
	}
	insecure := &server{}
	r := httptest.NewRequest("POST", "http://signage.example.org/api/v1/player/browser/recover", nil)
	r.Header.Set("Origin", "http://signage.example.org")
	if insecure.browserRequestAllowed(r) {
		t.Fatal("plain HTTP recovery accepted")
	}
}

func TestBrowserCookieAndNoSecretResponse(t *testing.T) {
	secret := "not-a-persisted-secret"
	w := httptest.NewRecorder()
	writeBrowserSession(w, devices.BrowserSession{SessionSecret: secret, ExpiresAt: time.Now().Add(time.Hour)}, http.StatusCreated)
	if strings.Contains(w.Body.String(), secret) {
		t.Fatal("cookie material entered response body")
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != browserPlayerCookie+"_"+uuid.Nil.String() || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/" {
		t.Fatal("Browser Player cookie attributes regressed")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("session response may be cached")
	}
}

func TestBrowserCookiesAreSelectedBySlot(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	r := httptest.NewRequest("GET", "https://signage.example.org/api/v1/player/manifest", nil)
	r.AddCookie(&http.Cookie{Name: browserPlayerCookie + "_" + a.String(), Value: "session-a"})
	r.AddCookie(&http.Cookie{Name: browserPlayerCookie + "_" + b.String(), Value: "session-b"})
	r.Header.Set("X-Tilecast-Player-Slot", a.String())
	cookie, err := browserCookieOf(r)
	if err != nil || cookie.Value != "session-a" {
		t.Fatal("slot A did not select its own cookie")
	}
	r.Header.Set("X-Tilecast-Player-Slot", b.String())
	cookie, err = browserCookieOf(r)
	if err != nil || cookie.Value != "session-b" {
		t.Fatal("slot B did not select its own cookie")
	}
	r.Header.Del("X-Tilecast-Player-Slot")
	if _, err := browserCookieOf(r); err == nil {
		t.Fatal("cookie selected without slot context")
	}
}

func TestBrowserSessionsCannotEnterPlatformOrAdminRoutes(t *testing.T) {
	for _, path := range []string{
		"/api/v1/screens", "/api/v1/auth/status", "/api/v1/player/presentation-network",
		"/api/v1/player/updates/release/artifact", "/api/v1/player/live-stream-session",
	} {
		if browserPlayerRoute(path) {
			t.Fatalf("browser cookie permitted privileged route %s", path)
		}
	}
	for _, path := range []string{"/api/v1/player/manifest", "/api/v1/player/activity-events", "/api/v1/player/assets/a/variants/v"} {
		if !browserPlayerRoute(path) {
			t.Fatalf("browser cookie rejected shared route %s", path)
		}
	}
	for _, path := range []string{
		"/api/v1/player/packages/acme.athletics/widgets/scoreboard",
		"/api/v1/player/packages/acme.athletics/widgets/scoreboard/frame",
	} {
		if !browserPlayerRoute(path) {
			t.Fatalf("browser cookie rejected package route %s", path)
		}
	}
}

func TestBrowserChallengeAndRecoveryRateLimits(t *testing.T) {
	for _, path := range []string{"/challenge", "/renew", "/recover", "/enroll"} {
		s := &server{publicURL: "https://signage.example.org", authLimiter: newRateLimiter(2, time.Minute), pairingLimiter: newRateLimiter(2, time.Minute)}
		router := chi.NewRouter()
		s.mountBrowserPlayer(router)
		for attempt := 0; attempt < 3; attempt++ {
			r := httptest.NewRequest("POST", "https://signage.example.org/player/browser"+path, strings.NewReader(`{"unsupported":true}`))
			r.Header.Set("Origin", "https://signage.example.org")
			r.Header.Set("Sec-Fetch-Site", "same-origin")
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			want := http.StatusBadRequest
			if attempt == 2 {
				want = http.StatusTooManyRequests
			}
			if w.Code != want {
				t.Fatalf("%s attempt %d status %d, want %d", path, attempt, w.Code, want)
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("recovery endpoint may be cached")
			}
		}
	}
}
