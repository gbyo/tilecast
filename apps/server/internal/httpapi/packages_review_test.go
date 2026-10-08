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
			APIVersion:     3,
			PackageID:      "acme.athletics",
			PackageVersion: "3.0.0",
			Runtime:        &packagemanifest.Runtime{Module: "./runtime/plugin.wasm"},
			Capabilities: &packagemanifest.Capabilities{
				Network:    &packagemanifest.NetworkCapability{Hosts: []string{"api.example.com"}},
				Background: &packagemanifest.BackgroundCapability{Jobs: []packagemanifest.BackgroundJob{{ID: "refresh", IntervalMinutes: 60}}},
				Storage:    &storage,
				StudioUI:   &packagemanifest.StudioUICapability{Entry: "./studio/index.html"},
				Services:   []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}, {ID: "takeovers.manage", Version: 1}},
			},
		},
		Compatible: true,
	}
	review, err := renderReview(resolution, installer.InstalledPackage{}, false, nil)
	if err != nil {
		t.Fatalf("render review: %v", err)
	}
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
			Services []struct {
				ID         string `json:"id"`
				Version    int    `json:"version"`
				Name       string `json:"name"`
				Category   string `json:"category"`
				Operations []struct {
					Name     string `json:"name"`
					Mutating bool   `json:"mutating"`
				} `json:"operations"`
			} `json:"services"`
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
	if len(decoded.Capabilities.Services) != 2 {
		t.Fatalf("services = %+v, want two resolved grants", decoded.Capabilities.Services)
	}
	if decoded.Capabilities.Services[0].ID != "screens.read" || decoded.Capabilities.Services[0].Name == "" || decoded.Capabilities.Services[0].Category != "read" {
		t.Fatalf("screens grant = %+v", decoded.Capabilities.Services[0])
	}
	if len(decoded.Capabilities.Services[0].Operations) == 0 || decoded.Capabilities.Services[0].Operations[0].Mutating {
		t.Fatalf("screens operations = %+v", decoded.Capabilities.Services[0].Operations)
	}
	if decoded.Capabilities.Services[1].ID != "takeovers.manage" || decoded.Capabilities.Services[1].Category != "manage" {
		t.Fatalf("takeover grant = %+v", decoded.Capabilities.Services[1])
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
	review, err := renderReview(resolution, installer.InstalledPackage{}, false, nil)
	if err != nil {
		t.Fatalf("render review: %v", err)
	}
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

func TestRenderReviewRefusesUnknownServiceGrant(t *testing.T) {
	resolution := pipeline.Resolution{
		Manifest: packagemanifest.Manifest{
			APIVersion:     3,
			PackageID:      "acme.athletics",
			PackageVersion: "3.0.0",
			Runtime:        &packagemanifest.Runtime{Module: "./runtime/plugin.wasm"},
			Capabilities: &packagemanifest.Capabilities{
				Services: []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 99}},
			},
		},
		Compatible: true,
	}
	if _, err := renderReview(resolution, installer.InstalledPackage{}, false, nil); err == nil {
		t.Fatal("renderReview rendered an unknown service grant")
	}
}
