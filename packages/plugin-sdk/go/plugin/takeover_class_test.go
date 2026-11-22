package plugin

import (
	"strings"
	"testing"
)

type ceilingPlugin struct {
	Bundle
	class TakeoverClass
}

func (p ceilingPlugin) MaximumTakeoverClass() TakeoverClass { return p.class }

func TestCheckDeclarationsTakeoverClassCeiling(t *testing.T) {
	bundle := NewBundle([]byte(studioOnlyV2), nil)
	for _, class := range []TakeoverClass{TakeoverEmergency, TakeoverOperator, TakeoverAutomation} {
		if err := CheckDeclarations(ceilingPlugin{Bundle: bundle, class: class}); err != nil {
			t.Fatalf("ceiling %q: %v", class, err)
		}
	}
	for class, want := range map[TakeoverClass]string{
		TakeoverLifeSafety: "life_safety",
		"":                 "unknown maximum Takeover class",
		"critical":         "unknown maximum Takeover class",
	} {
		err := CheckDeclarations(ceilingPlugin{Bundle: bundle, class: class})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("ceiling %q err=%v, want %q", class, err, want)
		}
	}
}
