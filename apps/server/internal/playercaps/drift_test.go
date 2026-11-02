package playercaps

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

// The canonical registry is the single source of truth. This test replays
// it against the Go mirror: identity, versions, providers, operations,
// and the command tables Resolve implements. Change the JSON first, then
// this test tells you exactly where the mirror fell behind.
type registryFile struct {
	RegistryVersion int `json:"registryVersion"`
	Capabilities    []struct {
		ID          string   `json:"id"`
		Version     int      `json:"version"`
		Title       string   `json:"title"`
		Description string   `json:"description"`
		Providers   []string `json:"providers"`
		Operations  []struct {
			Operation string `json:"operation"`
			Title     string `json:"title"`
			Commands  []struct {
				When    map[string]any `json:"when"`
				Command string         `json:"command"`
			} `json:"commands"`
		} `json:"operations"`
	} `json:"capabilities"`
}

func loadRegistry(t *testing.T) registryFile {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the test file")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "packages", "player-contracts", "player-capabilities.json"))
	if err != nil {
		t.Fatal(err)
	}
	var registry registryFile
	if err := json.Unmarshal(raw, &registry); err != nil {
		t.Fatal(err)
	}
	return registry
}

func TestRegistryDrift(t *testing.T) {
	registry := loadRegistry(t)
	if registry.RegistryVersion != 1 {
		t.Fatalf("registryVersion = %d", registry.RegistryVersion)
	}
	seen := map[string]bool{}
	for _, capability := range registry.Capabilities {
		if seen[capability.ID] {
			t.Fatalf("duplicate capability %q", capability.ID)
		}
		seen[capability.ID] = true
		if !Known(capability.ID, capability.Version) {
			t.Fatalf("registry carries %s@%d, the mirror does not", capability.ID, capability.Version)
		}
		if capability.Title == "" || capability.Description == "" {
			t.Fatalf("%s is missing metadata", capability.ID)
		}
		for _, provider := range capability.Providers {
			if !KnownProvider(provider) {
				t.Fatalf("%s lists unknown provider %q", capability.ID, provider)
			}
		}
		if len(capability.Providers) != len(providers) {
			t.Fatalf("%s providers = %v, want the full vocabulary", capability.ID, capability.Providers)
		}
	}
	for id, versions := range capabilities {
		for version := range versions {
			if !seen[id] {
				t.Fatalf("mirror carries %s@%d, the registry does not", id, version)
			}
		}
	}
	if len(Operations()) != len(registry.Capabilities) {
		t.Fatalf("operations = %d, registry carries %d capabilities", len(Operations()), len(registry.Capabilities))
	}
	byOperation := map[string]Operation{}
	for _, operation := range Operations() {
		byOperation[operation.Operation] = operation
	}
	for _, capability := range registry.Capabilities {
		for _, expected := range capability.Operations {
			actual, ok := byOperation[expected.Operation]
			if !ok {
				t.Fatalf("registry operation %q has no mirror", expected.Operation)
			}
			if actual.Title != expected.Title || actual.CapabilityID != capability.ID || actual.Version != capability.Version {
				t.Fatalf("operation %q metadata drifted: %+v", expected.Operation, actual)
			}
		}
	}
}

// TestRegistryCommandTables replays every command table in the canonical
// file through Resolve: each `when` clause must select its command, and
// the payload must be the input minus the discriminator fields.
func TestRegistryCommandTables(t *testing.T) {
	registry := loadRegistry(t)
	for _, capability := range registry.Capabilities {
		for _, expected := range capability.Operations {
			for _, row := range expected.Commands {
				if !displaycontrol.IsCommand(row.Command) {
					t.Fatalf("%s names unknown command %q", expected.Operation, row.Command)
				}
				input := map[string]any{}
				for key, value := range row.When {
					input[key] = value
				}
				fillValidInput(t, expected.Operation, input)
				resolved, err := Resolve(expected.Operation, input)
				if err != nil {
					t.Fatalf("%s %v: %v", expected.Operation, input, err)
				}
				if resolved.Command != row.Command {
					t.Fatalf("%s %v command = %s, want %s", expected.Operation, input, resolved.Command, row.Command)
				}
				for key := range row.When {
					if _, kept := resolved.Payload[key]; kept {
						t.Fatalf("%s %v kept discriminator %q in %v", expected.Operation, input, key, resolved.Payload)
					}
				}
			}
		}
	}
}

// fillValidInput completes a `when` clause to a fully valid operation
// input. Empty clauses need their required field; the power and mute
// clauses are already complete.
func fillValidInput(t *testing.T, operation string, input map[string]any) {
	t.Helper()
	switch operation {
	case DisplayInput:
		input["input"] = "1.0.0.0"
	case DisplayVolume:
		input["volume"] = float64(50)
	case DisplayBrightness:
		input["brightness"] = float64(75)
	case DisplayPower, DisplayMute:
	default:
		t.Fatalf("unknown operation %q", operation)
	}
}
