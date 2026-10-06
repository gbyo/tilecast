package web

import (
	"encoding/json"
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

const testSlot = "11111111-1111-4111-8111-111111111111"

func TestManagedSlotInstallsAndReopensItsOwnScreen(t *testing.T) {
	recorder := httptest.NewRecorder()
	PlayerHandler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/player/"+testSlot+"/manifest.webmanifest", nil))
	if recorder.Code != 200 || recorder.Header().Get("Content-Type") != "application/manifest+json" || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("slot manifest: %d %v", recorder.Code, recorder.Header())
	}
	var manifest struct {
		ID       string `json:"id"`
		StartURL string `json:"start_url"`
		Scope    string `json:"scope"`
		Display  string `json:"display"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &manifest); err != nil {
		t.Fatal(err)
	}
	want := "/player/" + testSlot + "/"
	if manifest.ID != want || manifest.Scope != want || manifest.StartURL != want || manifest.Display != "fullscreen" {
		t.Fatalf("install identity is not the managed slot route: %+v", manifest)
	}
	// The start URL is the stable slot route. A recovery capability lives only
	// in the one-time launch fragment and never in an installed identity.
	if strings.ContainsAny(manifest.StartURL, "#?") || strings.Contains(recorder.Body.String(), "recovery") {
		t.Fatalf("install manifest carries a recovery capability: %s", recorder.Body.String())
	}
	// The generic Player keeps its own identity.
	generic := httptest.NewRecorder()
	PlayerHandler().ServeHTTP(generic, httptest.NewRequest(http.MethodGet, "/player/manifest.webmanifest", nil))
	if generic.Code == 200 && strings.Contains(generic.Body.String(), testSlot) {
		t.Fatal("generic manifest was bound to a slot")
	}
	for _, target := range []string{"/player/not-a-slot/manifest.webmanifest", "/player/" + testSlot + "/other.webmanifest", "/player/" + testSlot + "/x/manifest.webmanifest"} {
		missing := httptest.NewRecorder()
		PlayerHandler().ServeHTTP(missing, httptest.NewRequest(http.MethodGet, target, nil))
		if missing.Code != 404 {
			t.Fatalf("%s must not resolve: %d", target, missing.Code)
		}
	}
}

func TestShellForSlotLinksOnlyThatSlotsManifest(t *testing.T) {
	shell := []byte(`<link rel="manifest" href="/player/manifest.webmanifest" />`)
	got := string(ShellForSlot(shell, testSlot))
	if !strings.Contains(got, `href="/player/`+testSlot+`/manifest.webmanifest"`) || strings.Contains(got, `href="/player/manifest.webmanifest"`) {
		t.Fatalf("slot shell links the wrong manifest: %s", got)
	}
	if string(ShellForSlot([]byte("<html></html>"), testSlot)) != "<html></html>" {
		t.Fatal("a shell without the generic link must be unchanged")
	}
}
