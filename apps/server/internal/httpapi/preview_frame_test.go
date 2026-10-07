package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestPreviewWidgetFrameRejectsInvalidIDs(t *testing.T) {
	handler := &server{}
	for _, ref := range [][2]string{
		{"not-a-package", "scoreboard"},
		{"tilecast.clock", "scoreboard"},
		{"acme.athletics", ""},
		{"acme.athletics", "with.dot"},
		{"acme.athletics", "../escape"},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/packages/"+ref[0]+"/widgets/"+ref[1]+"/frame", nil)
		route := chi.NewRouteContext()
		route.URLParams.Add("packageId", ref[0])
		route.URLParams.Add("widgetId", ref[1])
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
		response := httptest.NewRecorder()
		handler.previewWidgetFrame(response, request)
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

func TestWritePreviewFrame(t *testing.T) {
	definition := `globalThis.__tilecastWidgetDefinition={type:"acme.scoreboard",version:1};`
	response := httptest.NewRecorder()
	// The global middleware runs first; the frame replaces its policy.
	response.Header().Set("Content-Security-Policy", dashboardContentSecurityPolicy)
	response.Header().Set("X-Frame-Options", "DENY")
	writePreviewFrame(response, definition)
	result := response.Result()
	defer result.Body.Close()
	if result.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", result.StatusCode)
	}
	if got := result.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := result.Header.Get("Content-Security-Policy"); got != previewFramePolicy {
		t.Fatalf("Content-Security-Policy = %q", got)
	}
	if got := result.Header.Get("X-Frame-Options"); got != "SAMEORIGIN" {
		t.Fatalf("X-Frame-Options = %q", got)
	}
	if got := result.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	body := response.Body.String()
	if !strings.Contains(body, "tilecast.widget.bridge/1") {
		t.Fatal("frame document is missing the bridge bootstrap")
	}
	if !strings.Contains(body, definition) {
		t.Fatal("frame document is missing the bundle")
	}
	if values := result.Header.Values("Content-Security-Policy"); len(values) != 1 {
		t.Fatalf("Content-Security-Policy has %d values, want exactly the frame policy", len(values))
	}
}

func TestWritePreviewFrameEscapesBreakouts(t *testing.T) {
	hostile := `</script><script>fetch("https://evil.example")</script>`
	response := httptest.NewRecorder()
	writePreviewFrame(response, hostile)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := strings.Count(response.Body.String(), `</script>`); got != 2 {
		t.Fatalf("frame document holds %d script closers, want 2", got)
	}
}
