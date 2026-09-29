package contentdefs

import (
	"encoding/json"
	"os"
	"testing"
)

type catalogDecision struct {
	Provider  string `json:"provider"`
	Fate      string `json:"fate"`
	Component string `json:"component"`
	Canonical string `json:"canonical"`
	Creation  bool   `json:"creation"`
	PR        string `json:"pr"`
	Status    string `json:"status"`
}

// TestCatalogDecisions keeps docs/widgets-v2-catalog.json true: every Widget
// provider in the release catalog has exactly one recorded fate, and every
// fate marked done agrees with the provider's definition.
func TestCatalogDecisions(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/widgets-v2-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Providers []catalogDecision `json:"providers"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	catalog := MustLoad()
	decisions := map[string]catalogDecision{}
	for _, decision := range table.Providers {
		if _, duplicate := decisions[decision.Provider]; duplicate {
			t.Errorf("%s has more than one decision", decision.Provider)
		}
		decisions[decision.Provider] = decision
	}
	for _, definition := range catalog.Widgets {
		// Plugin-owned Widgets follow their plugin, not the release table.
		if definition.Source.Normalized().Kind != SourceKindCore {
			continue
		}
		if _, ok := decisions[definition.ID]; !ok {
			t.Errorf("Widget provider %s has no decision in docs/widgets-v2-catalog.json", definition.ID)
		}
	}
	for _, decision := range table.Providers {
		if decision.Status != "done" {
			t.Errorf("%s is still %q; the final catalog cannot ship with planned entries", decision.Provider, decision.Status)
		}
		definition, ok := catalog.Widget(decision.Provider)
		if !ok {
			t.Errorf("%s is done but not in the catalog", decision.Provider)
			continue
		}
		if decision.Creation == definition.Deprecation.Deprecated {
			t.Errorf("%s: creation %v disagrees with deprecation %v", decision.Provider, decision.Creation, definition.Deprecation.Deprecated)
		}
		switch decision.Fate {
		case "web":
			if definition.Runtime != "web" || definition.Component != nil {
				t.Errorf("%s is a Web Integration but has runtime %q and component %v", decision.Provider, definition.Runtime, definition.Component)
			}
		case "v2", "collapse", "style", "compat":
			if definition.Component == nil || definition.Component.Type != decision.Component {
				t.Errorf("%s must map into %s, got %+v", decision.Provider, decision.Component, definition.Component)
			}
			if decision.Canonical != "" {
				canonical, ok := catalog.Widget(decision.Canonical)
				if !ok || canonical.Component == nil || canonical.Component.Type != decision.Component || canonical.Deprecation.Deprecated {
					t.Errorf("%s: canonical %s must be a creatable %s", decision.Provider, decision.Canonical, decision.Component)
				}
				if definition.Deprecation.Replacement != "" && definition.Deprecation.Replacement != decision.Canonical {
					t.Errorf("%s: deprecation replacement %s is not the canonical %s", decision.Provider, definition.Deprecation.Replacement, decision.Canonical)
				}
				if !definition.Deprecation.Deprecated {
					t.Errorf("%s is an alias but is not marked deprecated", decision.Provider)
				}
				if !definition.HasFallback() {
					t.Errorf("%s must keep a compatibility presentation", decision.Provider)
				}
				if decision.PR == "C" && (definition.Compatibility == nil || definition.Compatibility.Fallback != "template") {
					t.Errorf("%s must keep a compiled template fallback", decision.Provider)
				}
			} else if decision.Fate == "v2" && definition.Deprecation.Deprecated {
				t.Errorf("%s is canonical but marked deprecated", decision.Provider)
			}
		default:
			t.Errorf("%s has unknown fate %q", decision.Provider, decision.Fate)
		}
	}
}
