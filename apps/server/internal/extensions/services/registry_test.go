package services

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/playercaps"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

func TestRegistryIsInternallyConsistent(t *testing.T) {
	seenCapabilities := map[string]bool{}
	seenOperations := map[string]bool{}
	for _, capability := range All() {
		key := fmt.Sprintf("%s@%d", capability.ID, capability.Version)
		if capability.ID == "" || capability.Version < 1 || capability.Name == "" || capability.Description == "" {
			t.Fatalf("capability %q is missing metadata", capability.ID)
		}
		switch capability.Category {
		case CategoryRead, CategoryDirectory, CategoryManage, CategoryAudit:
		default:
			t.Fatalf("capability %q has invalid category %q", capability.ID, capability.Category)
		}
		if len(capability.Operations) == 0 {
			t.Fatalf("capability %q owns no operations", capability.ID)
		}
		if seenCapabilities[key] {
			t.Fatalf("duplicate capability %q", key)
		}
		seenCapabilities[key] = true
		for _, context := range capability.Contexts {
			switch context {
			case ContextStudio, ContextBackground, ContextSystem:
			default:
				t.Fatalf("capability %q allows invalid context %q", capability.ID, context)
			}
		}
		for _, operation := range capability.Operations {
			if !strings.HasPrefix(operation.Name, capability.ID+"@") {
				t.Fatalf("operation %q does not belong to %q", operation.Name, capability.ID)
			}
			if operation.CapabilityID != capability.ID || operation.CapabilityVersion != capability.Version {
				t.Fatalf("operation %q misnames its capability", operation.Name)
			}
			if operation.Title == "" || operation.Description == "" || len(operation.Contexts) == 0 {
				t.Fatalf("operation %q is missing metadata", operation.Name)
			}
			if seenOperations[operation.Name] {
				t.Fatalf("duplicate operation %q", operation.Name)
			}
			seenOperations[operation.Name] = true
		}
	}
	if len(seenOperations) == 0 {
		t.Fatal("registry owns no operations")
	}
}

func TestOperationLookupAndGrantChecks(t *testing.T) {
	operation, capability, ok := LookupOperation("screens.read@1/list")
	if !ok || capability.ID != "screens.read" || operation.Mutating {
		t.Fatal("screens list lookup failed")
	}
	if !AllowsContext(operation, ContextStudio) || !AllowsContext(operation, ContextBackground) || AllowsContext(operation, ContextSystem) {
		t.Fatal("screens list contexts are wrong")
	}
	grants := []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}
	if !Granted(grants, operation) {
		t.Fatal("exact grant does not authorize its operation")
	}
	if Granted([]packagemanifest.ServiceGrant{{ID: "screens.read", Version: 2}}, operation) {
		t.Fatal("wrong version authorizes the operation")
	}
	if _, _, ok := LookupOperation("screens.read@1/drop"); ok {
		t.Fatal("unknown operation resolves")
	}
}

func TestValidateAndDetailsRejectUnknownServices(t *testing.T) {
	grants := []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}
	if err := ValidateGrants(grants); err != nil {
		t.Fatalf("ValidateGrants: %v", err)
	}
	details, err := Details(grants)
	if err != nil || len(details) != 1 || details[0].Name == "" || len(details[0].Operations) == 0 {
		t.Fatalf("Details = %+v, %v", details, err)
	}
	unknown := []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 99}}
	if err := ValidateGrants(unknown); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("ValidateGrants = %v, want unknown service", err)
	}
	if _, err := Details(unknown); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("Details = %v, want unknown service", err)
	}
}

// TestPlayerOperationsMirrorPlayerCaps pins the players.display-control
// methods to the Player Capability registry: one method per operation,
// with the same titles and descriptions the canonical file carries.
func TestPlayerOperationsMirrorPlayerCaps(t *testing.T) {
	capability, ok := Find("players.display-control", 1)
	if !ok {
		t.Fatal("players.display-control@1 is not registered")
	}
	mirrored := playercaps.Operations()
	if len(capability.Operations) != len(mirrored) {
		t.Fatalf("operations = %d, registry carries %d", len(capability.Operations), len(mirrored))
	}
	for i, operation := range capability.Operations {
		want := mirrored[i]
		if operation.Name != "players.display-control@1/"+want.Operation {
			t.Fatalf("operation = %q, want %q", operation.Name, want.Operation)
		}
		if operation.Title != want.Title || operation.Description != want.Description {
			t.Fatalf("operation %q metadata drifted", operation.Name)
		}
		if !operation.Mutating {
			t.Fatalf("operation %q is not marked mutating", operation.Name)
		}
	}
}
