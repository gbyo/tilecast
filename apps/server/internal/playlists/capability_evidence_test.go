package playlists

import (
	"context"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestWidgetCapabilityEvidenceUsesValidationTarget(t *testing.T) {
	component := &WidgetPresentation{SchemaVersion: 2, RequiredCapabilities: map[string]int{"widget.example": 2}}
	fallback := &WidgetPresentation{SchemaVersion: 1, RequiredCapabilities: map[string]int{"text.core": 1}}
	web := &WidgetPresentation{SchemaVersion: 1, RequiredCapabilities: map[string]int{"web.remote": 2}}
	for _, test := range []struct {
		name                     string
		component, fallback      *WidgetPresentation
		player                   playerPresentationCapabilities
		status, reason, renderer string
	}{
		{"component_preferred", component, fallback, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.example": 2, "text.core": 1}}, "supported", "reported_requirements_supported", "component"},
		{"newer_component", component, fallback, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.example": 3}}, "supported", "reported_requirements_supported", "component"},
		{"component_version_too_low", component, fallback, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.example": 1, "text.core": 1}}, "supported", "reported_requirements_supported", "compatibility"},
		{"component_schema_missing", component, fallback, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1}, Native: map[string]int{"widget.example": 2, "text.core": 1}}, "supported", "reported_requirements_supported", "compatibility"},
		{"both_unsupported", component, fallback, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}}, "blocked", "presentation_requirements_unsupported", ""},
		{"component_only_unsupported", component, nil, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{2}}, "blocked", "presentation_requirements_unsupported", ""},
		{"component_only_unknown", component, nil, playerPresentationCapabilities{}, "blocked", "component_capabilities_not_reported", ""},
		{"legacy_unknown", component, fallback, playerPresentationCapabilities{}, "unknown", "player_capabilities_not_reported", ""},
		{"fallback_only", nil, fallback, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1}, Native: map[string]int{"text.core": 1}}, "supported", "reported_requirements_supported", "compatibility"},
		{"web_runtime_supported", nil, web, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1}, WebRuntime: 2}, "supported", "reported_requirements_supported", "compatibility"},
		{"native_web_claim_ignored", nil, web, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1}, Native: map[string]int{"web.remote": 99}, WebRuntime: 1}, "blocked", "presentation_requirements_unsupported", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			requirement := presentationWidgetRequirement{AssetID: uuid.New(), Name: "Example", Component: test.component, Presentation: test.fallback}
			got := widgetCapabilityEvidence(requirement, test.player)
			if got.AssetID != requirement.AssetID || got.Name != requirement.Name || got.Status != test.status || got.Reason != test.reason || got.SelectedRenderer != test.renderer {
				t.Fatalf("evidence=%#v", got)
			}
			target, _ := widgetCompatibilityTarget(requirement, test.player)
			if got.Status == "supported" {
				// Supported evidence must also pass the actual assignment validator.
				if err := checkWidgetCompatibility(context.Background(), nil, uuid.New(), requirement, test.player); err != nil {
					t.Fatalf("evidence disagrees with validation: %v", err)
				}
				if supported, _ := presentationSupported(target, test.player); !supported {
					t.Fatal("selected renderer is unsupported")
				}
			}
		})
	}
}

func TestCapabilityEvidenceUnreportedProfileAndImmutability(t *testing.T) {
	component := &WidgetPresentation{SchemaVersion: 2, RequiredCapabilities: map[string]int{"widget.example": 2}}
	fallback := &WidgetPresentation{SchemaVersion: 1, RequiredCapabilities: map[string]int{"text.core": 1}}
	requirements := []presentationWidgetRequirement{{AssetID: uuid.New(), Name: "Example", Component: component, Presentation: fallback}}
	for _, test := range []struct {
		requiresV13    bool
		status, reason string
	}{{false, "unknown", "player_capabilities_not_reported"}, {true, "blocked", "manifest_v13_capabilities_not_reported"}} {
		report := capabilityEvidence(uuid.New(), requirements, test.requiresV13, playerPresentationCapabilities{})
		if report.Status != test.status || report.Reason != test.reason || report.Widgets[0].Status != "unknown" {
			t.Fatalf("unreported=%#v", report)
		}
	}
	player := playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{2, 1}, Native: map[string]int{"widget.example": 2, "text.core": 1}}
	report := capabilityEvidence(uuid.New(), requirements, false, player)
	if !reflect.DeepEqual(report.SchemaVersions, []int32{1, 2}) {
		t.Fatalf("schemas=%v", report.SchemaVersions)
	}
	report.SchemaVersions[0] = 99
	report.NativeCapabilities["widget.example"] = 99
	report.Widgets[0].Component.Capabilities["widget.example"] = 99
	if player.SchemaVersions[0] != 2 || player.Native["widget.example"] != 2 || component.RequiredCapabilities["widget.example"] != 2 {
		t.Fatal("evidence mutates authority inputs")
	}
	empty := capabilityEvidence(uuid.New(), nil, false, playerPresentationCapabilities{})
	if empty.Status != "not_applicable" || empty.Reason != "no_widget_presentation_requirements" || empty.Widgets == nil || empty.SchemaVersions == nil || empty.NativeCapabilities == nil {
		t.Fatalf("empty evidence=%#v", empty)
	}
}

func TestCapabilityEvidenceRejectsInvalidReferenceBeforeQuery(t *testing.T) {
	service := &Service{}
	for _, test := range []struct {
		screen, content uuid.UUID
		kind            string
	}{{uuid.Nil, uuid.New(), "playlist"}, {uuid.New(), uuid.Nil, "layout"}, {uuid.New(), uuid.New(), "command"}} {
		if _, err := service.PresentationCapabilityEvidenceInTx(context.Background(), nil, test.screen, test.kind, test.content); err == nil {
			t.Fatal("invalid reference accepted")
		}
	}
}
