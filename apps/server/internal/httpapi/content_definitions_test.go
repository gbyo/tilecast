package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// The effective catalog is a Provider, which does not serialize. The route
// must answer the Provider's snapshot, or Studio sees an empty catalog and
// every Widget reads as an unavailable type.
func TestContentDefinitionsServesTheEffectiveCatalog(t *testing.T) {
	release := contentdefs.MustLoad()
	service := media.NewService(nil, nil, media.Config{})
	service.SetContentDefinitions(contentdefs.NewProvider(release))
	s := &server{media: service}

	response := httptest.NewRecorder()
	s.contentDefinitions(response, httptest.NewRequest(http.MethodGet, "/api/v1/content-definitions", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var served struct {
		Data struct {
			Widgets     []json.RawMessage `json:"widgets"`
			DataSources []json.RawMessage `json:"dataSources"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &served); err != nil {
		t.Fatal(err)
	}
	if len(served.Data.Widgets) != len(release.Widgets) || len(served.Data.Widgets) == 0 {
		t.Fatalf("served %d Widgets, release catalog has %d", len(served.Data.Widgets), len(release.Widgets))
	}
	if len(served.Data.DataSources) != len(release.DataSources) || len(served.Data.DataSources) == 0 {
		t.Fatalf("served %d Data Sources, release catalog has %d", len(served.Data.DataSources), len(release.DataSources))
	}
}
