package media

import (
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestValidateContentAdaptersAcceptsReleaseCatalog(t *testing.T) {
	if err := ValidateContentAdapters(contentdefs.MustLoad()); err != nil {
		t.Fatalf("release catalog rejected: %v", err)
	}
}

func TestValidateContentAdaptersRequiresAdapterOutputKind(t *testing.T) {
	builtin := contentdefs.MustLoad()
	cases := []struct {
		name    string
		adapter string
		kind    string
		wantErr bool
	}{
		{"http_records object", "http_records", "object", true},
		{"http_records list", "http_records", "list", true},
		{"manual_records object", "manual_records", "object", true},
		{"manual_object records", "manual_object", "records", true},
		{"manual_object object", "manual_object", "object", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source := contentdefs.DataSourceDefinition{
				ID: "kind-probe", Version: 1, Name: "Kind Probe", Category: "Test",
				AdapterID:            tc.adapter,
				RequiresManifestV13:  true,
				DefaultConfiguration: map[string]any{},
				OutputSchema: contentdefs.OutputSchema{Kind: tc.kind, Fields: []contentdefs.OutputField{
					{Key: "title", Label: "Title", Type: "text"},
				}},
			}
			if tc.adapter == "http_records" {
				source.Fetch = &contentdefs.FetchSpec{
					URLTemplate: "https://example.org/items",
					Format:      "json",
					Mapping:     map[string]string{"title": "title"},
				}
			}
			dataSources := append(append([]contentdefs.DataSourceDefinition(nil), builtin.DataSources...), source)
			catalog, err := contentdefs.New(builtin.Widgets, dataSources)
			if err != nil {
				t.Fatalf("build catalog: %v", err)
			}
			err = ValidateContentAdapters(catalog)
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), "kind-probe") {
					t.Fatalf("ValidateContentAdapters = %v, want kind mismatch for kind-probe", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ValidateContentAdapters = %v, want nil", err)
			}
		})
	}
}
