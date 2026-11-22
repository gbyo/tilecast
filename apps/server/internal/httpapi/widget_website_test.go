package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

func TestCreateWebsiteWidgetRequiresDataSourceRead(t *testing.T) {
	s := &server{media: &media.Service{}}
	principal := auth.Principal{User: auth.User{Role: auth.RoleOwner}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/widgets", strings.NewReader(`{
		"provider": " Website ",
		"name": "Website",
		"configuration": {
			"url": "https://example.org/?room={data.room}",
			"dataSourceId": "4f589a71-6e9d-4db9-b91d-a244c6a9c351",
			"urlTemplatesEnabled": true
		}
	}`))
	response := httptest.NewRecorder()
	s.createWidget(response, request.WithContext(auth.WithPrincipal(request.Context(), principal)))
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "Reading Data Sources") {
		t.Fatalf("expected a Data Source capability denial, got %d: %s", response.Code, response.Body.String())
	}
}
