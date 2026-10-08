package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
)

func TestValidNestedWidgetID(t *testing.T) {
	valid := []string{"scoreboard", "a", "s2", "my_widget", "my-widget", strings.Repeat("a", 80)}
	for _, id := range valid {
		if !validNestedWidgetID(id) {
			t.Errorf("%q should validate", id)
		}
	}
	invalid := []string{"", "A", "1abc", "a.b", "a/b", "a b", "../x", "é", strings.Repeat("a", 81)}
	for _, id := range invalid {
		if validNestedWidgetID(id) {
			t.Errorf("%q should not validate", id)
		}
	}
}

func TestPlayerFramePolicyIsolatesExternalCode(t *testing.T) {
	for _, directive := range []string{
		"sandbox allow-scripts",
		"connect-src 'none'",
		"worker-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"tcmedia:",
	} {
		if !strings.Contains(playerFramePolicy, directive) {
			t.Fatalf("player frame policy is missing %q: %q", directive, playerFramePolicy)
		}
	}
	for _, token := range []string{
		"allow-same-origin",
		"allow-forms",
		"allow-popups",
		"allow-top-navigation",
		"allow-downloads",
		"allow-modals",
	} {
		if strings.Contains(playerFramePolicy, token) {
			t.Fatalf("player frame policy grants %q: %q", token, playerFramePolicy)
		}
	}
}

func TestPlayerFramePolicyMatchesDocumentMetaPolicy(t *testing.T) {
	document, err := sandbox.Assemble("globalThis.__tilecastWidgetDefinition={};")
	if err != nil {
		t.Fatalf("Assemble returned error: %v", err)
	}
	const prefix = `<meta http-equiv="Content-Security-Policy" content="`
	start := strings.Index(document, prefix)
	if start == -1 {
		t.Fatal("assembled frame holds no policy meta tag")
	}
	rest := document[start+len(prefix):]
	end := strings.Index(rest, `">`)
	if end == -1 {
		t.Fatal("policy meta tag is unterminated")
	}
	meta := rest[:end]
	// The response header adds exactly the sandbox directive, which
	// meta tags cannot set; every other directive is identical, so a
	// headerless (blob) embedding enforces the same policy.
	if want := "sandbox allow-scripts; " + meta; playerFramePolicy != want {
		t.Fatalf("player frame policy = %q, want %q", playerFramePolicy, want)
	}
}

func TestPlayerPackageWidgetFrameRejectsInvalidIDs(t *testing.T) {
	handler := &server{}
	for _, ref := range [][2]string{
		{"not-a-package", "scoreboard"},
		{"acme.athletics", "with.dot"},
		{"acme.athletics", "../escape"},
	} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			request := httptest.NewRequest(method, "/api/v1/player/packages/"+ref[0]+"/widgets/"+ref[1]+"/frame", nil)
			route := chi.NewRouteContext()
			route.URLParams.Add("packageId", ref[0])
			route.URLParams.Add("widgetId", ref[1])
			request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
			response := httptest.NewRecorder()
			handler.playerPackageWidgetFrame(response, request)
			if response.Code != http.StatusNotFound {
				t.Fatalf("%s %v: status = %d", method, ref, response.Code)
			}
		}
	}
}

func TestPlayerPackageWidgetRejectsInvalidIDs(t *testing.T) {
	handler := &server{}
	for _, ref := range [][2]string{
		{"not-a-package", "scoreboard"},
		{"tilecast.clock", "scoreboard"},
		{"acme.athletics", ""},
		{"acme.athletics", "with.dot"},
		{"acme.athletics", "../escape"},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/player/packages/"+ref[0]+"/widgets/"+ref[1], nil)
		route := chi.NewRouteContext()
		route.URLParams.Add("packageId", ref[0])
		route.URLParams.Add("widgetId", ref[1])
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
		response := httptest.NewRecorder()
		handler.playerPackageWidget(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%v: status = %d", ref, response.Code)
		}
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Error.Code != "package_widget_unavailable" {
			t.Fatalf("%v: body = %q", ref, response.Body.String())
		}
	}
}
