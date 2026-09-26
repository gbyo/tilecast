package plugins

import (
	"strings"
	"testing"
)

func TestRegistryIsValid(t *testing.T) {
	if err := validateRegistry(registry); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, d := range Definitions() {
		if seen[d.ID] {
			t.Fatalf("duplicate plugin id %q", d.ID)
		}
		seen[d.ID] = true
		if !strings.HasPrefix(d.ManagementPath, "/plugins/") {
			t.Fatalf("%s management path %q is not a Studio plugin route", d.ID, d.ManagementPath)
		}
		if !d.Installable {
			t.Fatalf("%s should be installable", d.ID)
		}
	}
	for _, id := range []string{"countdown_bar", EmergencyAlertsID, FormsID} {
		if !seen[id] {
			t.Fatalf("registry is missing %s", id)
		}
	}
	// Dependency Graph is a Studio system tool: no installation, no instances,
	// nothing projected to a Player.
	if _, found := Lookup("dependency_graph"); found {
		t.Fatal("dependency_graph must not be a plugin definition")
	}
}

func TestRegistryValidationRejectsBadDefinitions(t *testing.T) {
	valid := registry[0]
	cases := map[string]func(*Definition){
		"id":         func(d *Definition) { d.ID = "Bad-ID" },
		"version":    func(d *Definition) { d.Version = 0 },
		"name":       func(d *Definition) { d.Name = " " },
		"category":   func(d *Definition) { d.Category = "Marketplace" },
		"icon":       func(d *Definition) { d.Icon = "<svg>" },
		"path":       func(d *Definition) { d.ManagementPath = "https://example.com/plugin" },
		"doubleSlsh": func(d *Definition) { d.ManagementPath = "/plugins//x" },
		"noun":       func(d *Definition) { d.InstanceNounPlural = "" },
		"requirement": func(d *Definition) {
			d.Requirements = []Requirement{{Kind: "script", Label: "Runs a check"}}
		},
	}
	for name, mutate := range cases {
		d := valid
		d.Requirements = append([]Requirement{}, valid.Requirements...)
		mutate(&d)
		if err := validateRegistry([]Definition{d}); err == nil {
			t.Fatalf("%s: invalid definition accepted", name)
		}
	}
	if err := validateRegistry([]Definition{valid, valid}); err == nil {
		t.Fatal("duplicate ids accepted")
	}
}

func TestLookupUnknownPlugin(t *testing.T) {
	if _, found := Lookup("some_future_plugin"); found {
		t.Fatal("unknown plugin reported as known")
	}
	if definition, found := Lookup(FormsID); !found || definition.Category != CategoryWorkflow {
		t.Fatalf("Lookup(forms) = %+v, %v", definition, found)
	}
	// Retired plugins are no longer part of the release.
	for id := range retiredPlugins {
		if _, found := Lookup(id); found {
			t.Fatalf("retired plugin %s is still in the registry", id)
		}
	}
}
