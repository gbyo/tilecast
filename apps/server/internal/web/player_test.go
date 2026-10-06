package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlayerShellBoundary(t *testing.T) {
	for _, target := range []string{"/player", "/player/", "/player/11111111-1111-4111-8111-111111111111"} {
		recorder := httptest.NewRecorder()
		PlayerHandler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), "Tilecast Browser Player") {
			t.Fatalf("%s: %d %s", target, recorder.Code, recorder.Body.String())
		}
		if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatal("provisioning shell must not leak or cache navigation")
		}
		csp := recorder.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "script-src 'self'") || strings.Contains(csp, "cloudflare") || strings.Contains(csp, "unsafe-eval") {
			t.Fatalf("invalid Player policy: %s", csp)
		}
	}
	for _, target := range []string{"/player/not-a-slot", "/player/media/1/11111111-1111-4111-8111-111111111111", "/player/../static/index.html", "/api/v1/player/heartbeat", "/player/missing.js"} {
		recorder := httptest.NewRecorder()
		PlayerHandler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		if recorder.Code != 404 {
			t.Fatalf("%s must not fall back to Player or Studio: %d", target, recorder.Code)
		}
	}
}
