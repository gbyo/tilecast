package playercaps

import (
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

func TestSanitizeReport(t *testing.T) {
	clean, err := SanitizeReport(map[string]Reported{
		DisplayPower:      {Version: 1, Provider: displaycontrol.ProviderDDCCI},
		"display.shell":   {Version: 1, Provider: displaycontrol.ProviderNetwork},
		DisplayVolume:     {Version: 2, Provider: displaycontrol.ProviderHDMICEC},
		DisplayMute:       {Version: 1, Provider: "telepathy"},
		DisplayBrightness: {Version: 1, Provider: displaycontrol.ProviderUnsupported},
	})
	if err != nil {
		t.Fatalf("SanitizeReport: %v", err)
	}
	if len(clean) != 1 {
		t.Fatalf("clean = %v, want only display.power", clean)
	}
	if clean[DisplayPower].Provider != displaycontrol.ProviderDDCCI {
		t.Fatalf("clean = %v", clean)
	}
}

func TestSanitizeReportRefusesOversized(t *testing.T) {
	report := make(map[string]Reported, MaxReportedCapabilities+1)
	for i := 0; i <= MaxReportedCapabilities; i++ {
		report[string(rune('a'+i%26))+string(rune(i))] = Reported{Version: 1, Provider: displaycontrol.ProviderNetwork}
	}
	if _, err := SanitizeReport(report); err == nil {
		t.Fatal("oversized report was accepted")
	}
}

func TestResolve(t *testing.T) {
	cases := []struct {
		operation string
		input     map[string]any
		command   string
		payload   map[string]any
	}{
		{DisplayPower, map[string]any{"state": "on"}, displaycontrol.CommandPowerOn, map[string]any{}},
		{DisplayPower, map[string]any{"state": "off"}, displaycontrol.CommandPowerOff, map[string]any{}},
		{DisplayInput, map[string]any{"input": "1.0.0.0"}, displaycontrol.CommandSetInput, map[string]any{"input": "1.0.0.0"}},
		{DisplayVolume, map[string]any{"volume": float64(50)}, displaycontrol.CommandSetVolume, map[string]any{"volume": float64(50)}},
		{DisplayMute, map[string]any{"muted": true}, displaycontrol.CommandMute, map[string]any{}},
		{DisplayMute, map[string]any{"muted": false}, displaycontrol.CommandUnmute, map[string]any{}},
		{DisplayBrightness, map[string]any{"brightness": float64(75)}, displaycontrol.CommandSetBrightness, map[string]any{"brightness": float64(75)}},
	}
	for _, tc := range cases {
		resolved, err := Resolve(tc.operation, tc.input)
		if err != nil {
			t.Fatalf("%s %v: %v", tc.operation, tc.input, err)
		}
		if resolved.Command != tc.command {
			t.Fatalf("%s %v command = %s, want %s", tc.operation, tc.input, resolved.Command, tc.command)
		}
		if len(resolved.Payload) != len(tc.payload) {
			t.Fatalf("%s %v payload = %v, want %v", tc.operation, tc.input, resolved.Payload, tc.payload)
		}
		for key, want := range tc.payload {
			if resolved.Payload[key] != want {
				t.Fatalf("%s %v payload = %v, want %v", tc.operation, tc.input, resolved.Payload, tc.payload)
			}
		}
	}
}

func TestResolveRejects(t *testing.T) {
	cases := []struct {
		name      string
		operation string
		input     map[string]any
	}{
		{"unknown operation", "display.eject", map[string]any{}},
		{"empty operation", "", map[string]any{"state": "on"}},
		{"power missing state", DisplayPower, map[string]any{}},
		{"power bad state", DisplayPower, map[string]any{"state": "dim"}},
		{"power extra field", DisplayPower, map[string]any{"state": "on", "volume": float64(1)}},
		{"power mistyped", DisplayPower, map[string]any{"state": true}},
		{"input missing", DisplayInput, map[string]any{}},
		{"input unsafe", DisplayInput, map[string]any{"input": "1; reboot"}},
		{"input too long", DisplayInput, map[string]any{"input": "0123456789abcdef0123456789abcdef0"}},
		{"input mistyped", DisplayInput, map[string]any{"input": float64(1)}},
		{"volume missing", DisplayVolume, map[string]any{}},
		{"volume high", DisplayVolume, map[string]any{"volume": float64(101)}},
		{"volume low", DisplayVolume, map[string]any{"volume": float64(-1)}},
		{"volume fractional", DisplayVolume, map[string]any{"volume": 1.5}},
		{"volume mistyped", DisplayVolume, map[string]any{"volume": "loud"}},
		{"mute missing", DisplayMute, map[string]any{}},
		{"mute mistyped", DisplayMute, map[string]any{"muted": "yes"}},
		{"brightness missing", DisplayBrightness, map[string]any{}},
		{"brightness high", DisplayBrightness, map[string]any{"brightness": float64(101)}},
		{"brightness fractional", DisplayBrightness, map[string]any{"brightness": 2.5}},
		{"nil input", DisplayPower, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Resolve(tc.operation, tc.input); err == nil {
				t.Fatalf("%s was accepted", tc.name)
			}
		})
	}
}

func TestCapabilityFor(t *testing.T) {
	for legacy, want := range map[string]string{
		displaycontrol.CapabilityPower: DisplayPower, displaycontrol.CapabilityInput: DisplayInput,
		displaycontrol.CapabilityVolume: DisplayVolume, displaycontrol.CapabilityMute: DisplayMute,
		displaycontrol.CapabilityBrightness: DisplayBrightness,
	} {
		got, ok := CapabilityFor(legacy)
		if !ok || got != want {
			t.Fatalf("CapabilityFor(%q) = %q, %v", legacy, got, ok)
		}
	}
	if _, ok := CapabilityFor(displaycontrol.CapabilityProbe); ok {
		t.Fatal("probe is not a registry capability")
	}
	if _, ok := CapabilityFor("shell"); ok {
		t.Fatal("unknown legacy capability mapped")
	}
	for _, id := range []string{DisplayPower, DisplayInput, DisplayVolume, DisplayMute, DisplayBrightness} {
		legacy, ok := DisplayControlName(id)
		if !ok {
			t.Fatalf("DisplayControlName(%q) missing", id)
		}
		round, ok := CapabilityFor(legacy)
		if !ok || round != id {
			t.Fatalf("DisplayControlName(%q) = %q, round trip %q", id, legacy, round)
		}
	}
	if _, ok := DisplayControlName("display.shell"); ok {
		t.Fatal("unknown registry ID mapped to legacy")
	}
}
