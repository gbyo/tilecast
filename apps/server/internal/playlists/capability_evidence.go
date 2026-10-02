package playlists

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type PresentationRequirementEvidence struct {
	SchemaVersion int            `json:"schemaVersion"`
	Capabilities  map[string]int `json:"capabilities"`
	Supported     bool           `json:"supported"`
}

type WidgetCapabilityEvidence struct {
	AssetID          uuid.UUID                        `json:"assetId"`
	Name             string                           `json:"name"`
	Status           string                           `json:"status"`
	Reason           string                           `json:"reason"`
	SelectedRenderer string                           `json:"selectedRenderer,omitempty"`
	Component        *PresentationRequirementEvidence `json:"component,omitempty"`
	Compatibility    *PresentationRequirementEvidence `json:"compatibility,omitempty"`
}

// CapabilityEvidence describes reported presentation support, not content
// readiness, device decoder behavior, or proof that the Player rendered it.
type CapabilityEvidence struct {
	ScreenID            uuid.UUID                  `json:"screenId"`
	Status              string                     `json:"status"`
	Reason              string                     `json:"reason"`
	Reported            bool                       `json:"reported"`
	SchemaVersions      []int32                    `json:"schemaVersions"`
	NativeCapabilities  map[string]int             `json:"nativeCapabilities"`
	WebRuntimeVersion   int                        `json:"webRuntimeVersion"`
	RequiresManifestV13 bool                       `json:"requiresManifestV13"`
	Widgets             []WidgetCapabilityEvidence `json:"widgets"`
}

// PresentationCapabilityEvidenceInTx shares the assignment validator's graph,
// compilation, renderer choice, and capability comparison. The caller owns the
// transaction and must authorize Screen/content access before exposing evidence.
func (s *Service) PresentationCapabilityEvidenceInTx(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, contentType string, contentID uuid.UUID) (CapabilityEvidence, error) {
	if screenID == uuid.Nil || contentID == uuid.Nil {
		return CapabilityEvidence{}, errors.New("Screen and content are required")
	}
	var playlistID, layoutID, assetID *uuid.UUID
	var rootQuery string
	switch contentType {
	case "playlist":
		playlistID = &contentID
		rootQuery = `SELECT EXISTS(SELECT 1 FROM playlists WHERE id=$1 AND deleted_at IS NULL)`
	case "layout":
		layoutID = &contentID
		rootQuery = `SELECT EXISTS(SELECT 1 FROM layouts WHERE id=$1 AND deleted_at IS NULL)`
	case "asset":
		assetID = &contentID
		rootQuery = `SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND deleted_at IS NULL)`
	default:
		return CapabilityEvidence{}, errors.New("unsupported presentation type")
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens WHERE id=$1 AND deleted_at IS NULL)`, screenID).Scan(&exists); err != nil {
		return CapabilityEvidence{}, err
	}
	if !exists {
		return CapabilityEvidence{}, ErrNotFound
	}
	if err := tx.QueryRow(ctx, rootQuery, contentID).Scan(&exists); err != nil {
		return CapabilityEvidence{}, err
	}
	if !exists {
		return CapabilityEvidence{}, ErrNotFound
	}
	if contentType == "layout" {
		var published bool
		if err := tx.QueryRow(ctx, `SELECT published_revision_id IS NOT NULL FROM layouts WHERE id=$1`, contentID).Scan(&published); err != nil {
			return CapabilityEvidence{}, err
		}
		if !published {
			return CapabilityEvidence{}, fmt.Errorf("%w: Layout is not published", ErrConflict)
		}
	}
	requirements, blocker, err := s.presentationRequirementsForRoot(ctx, tx, playlistID, layoutID, assetID)
	if err != nil {
		return CapabilityEvidence{}, err
	}
	player, err := readPlayerPresentationCapabilities(ctx, tx, screenID)
	if err != nil {
		return CapabilityEvidence{}, err
	}
	return capabilityEvidence(screenID, requirements, blocker != "", player), nil
}

func capabilityEvidence(screenID uuid.UUID, requirements []presentationWidgetRequirement, requiresV13 bool, player playerPresentationCapabilities) CapabilityEvidence {
	report := CapabilityEvidence{ScreenID: screenID, Status: "supported", Reason: "reported_requirements_supported", Reported: player.Reported, SchemaVersions: slices.Clone(player.SchemaVersions), NativeCapabilities: maps.Clone(player.Native), WebRuntimeVersion: player.WebRuntime, RequiresManifestV13: requiresV13, Widgets: []WidgetCapabilityEvidence{}}
	if report.SchemaVersions == nil {
		report.SchemaVersions = []int32{}
	}
	slices.Sort(report.SchemaVersions)
	if report.NativeCapabilities == nil {
		report.NativeCapabilities = map[string]int{}
	}
	if !player.Reported {
		report.Status = "unknown"
		report.Reason = "player_capabilities_not_reported"
	}
	if len(requirements) == 0 && !requiresV13 {
		report.Status = "not_applicable"
		report.Reason = "no_widget_presentation_requirements"
	}
	if requiresV13 && !player.Reported {
		report.Status = "blocked"
		report.Reason = "manifest_v13_capabilities_not_reported"
	}
	for _, requirement := range requirements {
		widget := widgetCapabilityEvidence(requirement, player)
		report.Widgets = append(report.Widgets, widget)
		if widget.Status == "blocked" && report.Status != "blocked" {
			report.Status = "blocked"
			report.Reason = "widget_requirements_unsupported"
		}
	}
	return report
}

func widgetCapabilityEvidence(requirement presentationWidgetRequirement, player playerPresentationCapabilities) WidgetCapabilityEvidence {
	evidence := WidgetCapabilityEvidence{AssetID: requirement.AssetID, Name: requirement.Name, Component: requirementEvidence(requirement.Component, player), Compatibility: requirementEvidence(requirement.Presentation, player)}
	target, renderer := widgetCompatibilityTarget(requirement, player)
	if !player.Reported {
		evidence.Status = "unknown"
		evidence.Reason = "player_capabilities_not_reported"
		// Existing assignment validation permits the legacy path only when a
		// compatibility presentation exists and no v13 dependency blocks it.
		if requirement.Presentation == nil && requirement.Component != nil {
			evidence.Status = "blocked"
			evidence.Reason = "component_capabilities_not_reported"
		}
		return evidence
	}
	if target == nil {
		evidence.Status = "supported"
		evidence.Reason = "no_presentation_requirements"
		return evidence
	}
	supported, _ := presentationSupported(target, player)
	if !supported {
		evidence.Status = "blocked"
		evidence.Reason = "presentation_requirements_unsupported"
		return evidence
	}
	evidence.Status = "supported"
	evidence.Reason = "reported_requirements_supported"
	evidence.SelectedRenderer = renderer
	return evidence
}

func requirementEvidence(presentation *WidgetPresentation, player playerPresentationCapabilities) *PresentationRequirementEvidence {
	if presentation == nil {
		return nil
	}
	supported, _ := presentationSupported(presentation, player)
	capabilities := maps.Clone(presentation.RequiredCapabilities)
	if capabilities == nil {
		capabilities = map[string]int{}
	}
	return &PresentationRequirementEvidence{SchemaVersion: presentation.SchemaVersion, Capabilities: capabilities, Supported: supported}
}
