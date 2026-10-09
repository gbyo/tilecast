package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestPlayerFramePolicyIsTheSharedContractPolicy(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/player-contracts/fixtures/widget-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Constants struct {
			ResponsePolicy string `json:"responsePolicy"`
		} `json:"constants"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if playerFramePolicy != fixture.Constants.ResponsePolicy {
		t.Fatalf("player frame policy = %q, want the contract policy %q", playerFramePolicy, fixture.Constants.ResponsePolicy)
	}
}

// Passive loads must never reach the open web: a Widget could encode
// its granted data into an attacker-owned image, media, or font URL
// even while connect-src blocks fetch.
func TestPlayerFramePolicyBlocksPassiveExfiltration(t *testing.T) {
	for _, directive := range []string{"img-src", "media-src", "font-src"} {
		var sources string
		for _, part := range strings.Split(playerFramePolicy, "; ") {
			if rest, ok := strings.CutPrefix(part, directive); ok {
				sources = rest
			}
		}
		if sources == "" {
			t.Fatalf("%s is missing from %q", directive, playerFramePolicy)
		}
		for _, source := range strings.Fields(sources) {
			if source != "data:" && source != "tcmedia:" {
				t.Fatalf("%s grants %q; passive loads may reach only data: and tcmedia:", directive, source)
			}
		}
	}
}

// The document's own meta policy is broader than the response header (it
// must admit the Browser and Edge media routes only the serving host can
// name). It must still admit everything the header does, or the header
// would be narrowed by a policy the untrusted bytes choose.
func TestPlayerFrameMetaPolicyAdmitsTheHeaderSources(t *testing.T) {
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
	for _, directive := range []string{"img-src", "media-src", "font-src"} {
		for _, source := range []string{"data:", "tcmedia:"} {
			found := false
			for _, part := range strings.Split(meta, "; ") {
				if rest, ok := strings.CutPrefix(part, directive); ok && strings.Contains(" "+rest+" ", " "+source+" ") {
					found = true
				}
			}
			if !found {
				t.Fatalf("meta policy %q does not admit %s %s", meta, directive, source)
			}
		}
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
