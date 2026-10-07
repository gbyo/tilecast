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
