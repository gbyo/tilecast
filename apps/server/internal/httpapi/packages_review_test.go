package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/pipeline"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

func TestRenderReviewIncludesRuntimeCapabilities(t *testing.T) {
	storage := true
	resolution := pipeline.Resolution{
		Manifest: packagemanifest.Manifest{
			APIVersion:     2,
			PackageID:      "acme.athletics",
			PackageVersion: "2.4.1",
			Runtime:        &packagemanifest.Runtime{Module: "./runtime/plugin.wasm"},
			Capabilities: &packagemanifest.Capabilities{
				Network:    &packagemanifest.NetworkCapability{Hosts: []string{"api.example.com"}},
				Background: &packagemanifest.BackgroundCapability{Jobs: []packagemanifest.BackgroundJob{{ID: "refresh", IntervalMinutes: 60}}},
				Storage:    &storage,
				StudioUI:   &packagemanifest.StudioUICapability{Entry: "./studio/index.html"},
			},
		},
		Compatible: true,
	}
	review := renderReview(resolution, installer.InstalledPackage{}, false)
	raw, err := json.Marshal(review)
	if err != nil {
		t.Fatalf("marshal review: %v", err)
	}
	var decoded struct {
		Runtime struct {
			Module string `json:"module"`
		} `json:"runtime"`
		Capabilities struct {
			Network struct {
				Hosts []string `json:"hosts"`
			} `json:"network"`
			Background struct {
				Jobs []struct {
					ID              string `json:"id"`
					IntervalMinutes int    `json:"intervalMinutes"`
				} `json:"jobs"`
			} `json:"background"`
			Storage  bool `json:"storage"`
			StudioUI struct {
				Entry string `json:"entry"`
			} `json:"studioUI"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal review: %v", err)
	}
	if decoded.Runtime.Module != "./runtime/plugin.wasm" {
		t.Fatalf("runtime module = %q", decoded.Runtime.Module)
	}
	if len(decoded.Capabilities.Network.Hosts) != 1 || decoded.Capabilities.Network.Hosts[0] != "api.example.com" {
		t.Fatalf("network hosts = %v", decoded.Capabilities.Network.Hosts)
	}
	if len(decoded.Capabilities.Background.Jobs) != 1 || decoded.Capabilities.Background.Jobs[0].ID != "refresh" || decoded.Capabilities.Background.Jobs[0].IntervalMinutes != 60 {
		t.Fatalf("background jobs = %+v", decoded.Capabilities.Background.Jobs)
	}
	if !decoded.Capabilities.Storage {
		t.Fatal("storage capability missing from review")
	}
	if decoded.Capabilities.StudioUI.Entry != "./studio/index.html" {
		t.Fatalf("studio entry = %q", decoded.Capabilities.StudioUI.Entry)
	}
}

func TestRenderReviewOmitsAbsentRuntime(t *testing.T) {
	resolution := pipeline.Resolution{
		Manifest: packagemanifest.Manifest{
			APIVersion:     1,
			PackageID:      "acme.legacy",
			PackageVersion: "1.0.0",
		},
		Compatible: true,
	}
	review := renderReview(resolution, installer.InstalledPackage{}, false)
	raw, err := json.Marshal(review)
	if err != nil {
		t.Fatalf("marshal review: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal review: %v", err)
	}
	if _, ok := decoded["runtime"]; ok {
		t.Fatal("version 1 review carries a runtime key")
	}
	if _, ok := decoded["capabilities"]; ok {
		t.Fatal("version 1 review carries a capabilities key")
	}
}
