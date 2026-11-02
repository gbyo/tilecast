// Package playercaps mirrors the versioned Player Capability registry
// in typed Go. The canonical definitions live in
// packages/player-contracts/player-capabilities.json; the drift test
// replays that file against this package, so the JSON stays the single
// source of truth without a runtime file dependency.
//
// Hosts report what they actually support: a generic capability status
// maps capability IDs to a version and a diagnostic provider. Packages
// invoke typed operations; Resolve maps an operation and its validated
// input to one persistent Player command. Nothing here branches on a
// platform name: unknown capabilities, versions, and providers fail
// closed wherever they appear.
package playercaps

import (
	"errors"
	"fmt"

	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

// Capability IDs and the single shipped version. New capabilities and
// versions extend the registry file first; this mirror follows.
const (
	DisplayPower      = "display.power"
	DisplayInput      = "display.input"
	DisplayVolume     = "display.volume"
	DisplayMute       = "display.mute"
	DisplayBrightness = "display.brightness"

	Version1 = 1
)

// MaxReportedCapabilities bounds one player's generic status: the
// registry is small, and anything larger is a misbehaving reporter.
const MaxReportedCapabilities = 32

// Reported is one player's claim for one capability: the registry
// version it implements and the provider that serves it. Provider is
// diagnostic and selection metadata, never behavior.
type Reported struct {
	Version  int
	Provider string
}

// Operation describes one invokable registry operation for review
// surfaces. Guests invoke the Operation token with a JSON input.
type Operation struct {
	Operation    string
	Title        string
	Description  string
	CapabilityID string
	Version      int
}

// capabilities is the registry mirror: ID to version to operations.
var capabilities = map[string]map[int][]Operation{
	DisplayPower: {Version1: {{
		Operation: DisplayPower, Title: "Set display power",
		Description:  "Turn the attached display on or off through the reporting provider.",
		CapabilityID: DisplayPower, Version: Version1,
	}}},
	DisplayInput: {Version1: {{
		Operation: DisplayInput, Title: "Set display input",
		Description:  "Select the active input on the attached display.",
		CapabilityID: DisplayInput, Version: Version1,
	}}},
	DisplayVolume: {Version1: {{
		Operation: DisplayVolume, Title: "Set display volume",
		Description:  "Set the attached display volume from 0 to 100.",
		CapabilityID: DisplayVolume, Version: Version1,
	}}},
	DisplayMute: {Version1: {{
		Operation: DisplayMute, Title: "Set display mute",
		Description:  "Mute or unmute the attached display.",
		CapabilityID: DisplayMute, Version: Version1,
	}}},
	DisplayBrightness: {Version1: {{
		Operation: DisplayBrightness, Title: "Set display brightness",
		Description:  "Set the attached display brightness from 0 to 100.",
		CapabilityID: DisplayBrightness, Version: Version1,
	}}},
}

// providers mirrors the registry's closed provider vocabulary. The
// display-control "unsupported" marker is not a provider: a host that
// supports nothing reports nothing.
var providers = map[string]bool{
	displaycontrol.ProviderHDMICEC: true,
	displaycontrol.ProviderDDCCI:   true,
	displaycontrol.ProviderNetwork: true,
	displaycontrol.ProviderRS232:   true,
}

// Operations lists every invokable registry operation in stable order.
func Operations() []Operation {
	return []Operation{
		capabilities[DisplayPower][Version1][0],
		capabilities[DisplayInput][Version1][0],
		capabilities[DisplayVolume][Version1][0],
		capabilities[DisplayMute][Version1][0],
		capabilities[DisplayBrightness][Version1][0],
	}
}

// Known reports whether the registry carries the capability version.
func Known(id string, version int) bool {
	versions, ok := capabilities[id]
	if !ok {
		return false
	}
	_, ok = versions[version]
	return ok
}

// KnownProvider reports whether the provider belongs to the closed
// registry vocabulary.
func KnownProvider(provider string) bool { return providers[provider] }

// SanitizeReport drops every entry the registry does not know: unknown
// capabilities, wrong versions, and unknown providers. Unsupported
// capabilities are absent, never negated. An oversized report is
// refused whole, because truncation would silently rewrite the truth.
func SanitizeReport(report map[string]Reported) (map[string]Reported, error) {
	if len(report) > MaxReportedCapabilities {
		return nil, fmt.Errorf("player capabilities exceed %d entries", MaxReportedCapabilities)
	}
	clean := make(map[string]Reported, len(report))
	for id, entry := range report {
		if !Known(id, entry.Version) || !KnownProvider(entry.Provider) {
			continue
		}
		clean[id] = entry
	}
	return clean, nil
}

// Resolved is one operation mapped to the persistent command system.
type Resolved struct {
	// Command is the Player command type to queue.
	Command string
	// Payload is the command payload: the operation input with the
	// matched discriminator fields removed.
	Payload map[string]any
}

// Resolve maps an operation and its JSON input to one Player command.
// Unknown operations, mistyped inputs, extra fields, and unmatched
// discriminators fail closed. The resulting payload always passes the
// command's own validation before it returns.
func Resolve(operation string, input map[string]any) (Resolved, error) {
	var resolved Resolved
	switch operation {
	case DisplayPower:
		state, err := stringField(input, "state", "display power state")
		if err != nil {
			return resolved, err
		}
		switch state {
		case "on":
			resolved.Command = displaycontrol.CommandPowerOn
		case "off":
			resolved.Command = displaycontrol.CommandPowerOff
		default:
			return resolved, errors.New("display power state must be on or off")
		}
		resolved.Payload = without(input, "state")
	case DisplayInput:
		if _, err := stringField(input, "input", "display input"); err != nil {
			return resolved, err
		}
		resolved.Command = displaycontrol.CommandSetInput
		resolved.Payload = without(input)
	case DisplayVolume:
		if _, err := intField(input, "volume", "display volume"); err != nil {
			return resolved, err
		}
		resolved.Command = displaycontrol.CommandSetVolume
		resolved.Payload = without(input)
	case DisplayMute:
		muted, err := boolField(input, "muted", "display mute")
		if err != nil {
			return resolved, err
		}
		if muted {
			resolved.Command = displaycontrol.CommandMute
		} else {
			resolved.Command = displaycontrol.CommandUnmute
		}
		resolved.Payload = without(input, "muted")
	case DisplayBrightness:
		if _, err := intField(input, "brightness", "display brightness"); err != nil {
			return resolved, err
		}
		resolved.Command = displaycontrol.CommandSetBrightness
		resolved.Payload = without(input)
	default:
		return resolved, fmt.Errorf("unknown player operation %q", operation)
	}
	if err := displaycontrol.ValidateCommandPayload(resolved.Command, resolved.Payload); err != nil {
		return Resolved{}, err
	}
	return resolved, nil
}

// DisplayControlName maps a registry ID back to the legacy
// display-control capability name, so capability checks accept screens
// whose players predate the generic report. Unknown IDs have no legacy
// name.
func DisplayControlName(id string) (string, bool) {
	switch id {
	case DisplayPower:
		return displaycontrol.CapabilityPower, true
	case DisplayInput:
		return displaycontrol.CapabilityInput, true
	case DisplayVolume:
		return displaycontrol.CapabilityVolume, true
	case DisplayMute:
		return displaycontrol.CapabilityMute, true
	case DisplayBrightness:
		return displaycontrol.CapabilityBrightness, true
	default:
		return "", false
	}
}

// CapabilityFor maps a legacy display-control capability name to its
// registry ID, so reporters populate the generic status from the same
// probe that feeds the legacy fields. Unknown names are not registry
// capabilities.
func CapabilityFor(legacy string) (string, bool) {
	switch legacy {
	case displaycontrol.CapabilityPower:
		return DisplayPower, true
	case displaycontrol.CapabilityInput:
		return DisplayInput, true
	case displaycontrol.CapabilityVolume:
		return DisplayVolume, true
	case displaycontrol.CapabilityMute:
		return DisplayMute, true
	case displaycontrol.CapabilityBrightness:
		return DisplayBrightness, true
	default:
		return "", false
	}
}

func stringField(input map[string]any, key, what string) (string, error) {
	value, ok := input[key].(string)
	if !ok || value == "" {
		return "", fmt.Errorf("%s must be a non-empty string", what)
	}
	if len(input) != 1 {
		return "", fmt.Errorf("%s takes no other fields", what)
	}
	return value, nil
}

func boolField(input map[string]any, key, what string) (bool, error) {
	value, ok := input[key].(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean", what)
	}
	if len(input) != 1 {
		return false, fmt.Errorf("%s takes no other fields", what)
	}
	return value, nil
}

func intField(input map[string]any, key, what string) (int, error) {
	raw, ok := input[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", what)
	}
	var value int
	switch number := raw.(type) {
	case float64:
		if number != float64(int(number)) {
			return 0, fmt.Errorf("%s must be an integer", what)
		}
		value = int(number)
	case int:
		value = number
	default:
		return 0, fmt.Errorf("%s must be an integer", what)
	}
	if len(input) != 1 {
		return 0, fmt.Errorf("%s takes no other fields", what)
	}
	return value, nil
}

func without(input map[string]any, drop ...string) map[string]any {
	out := make(map[string]any, len(input))
outer:
	for key, value := range input {
		for _, unwanted := range drop {
			if key == unwanted {
				continue outer
			}
		}
		out[key] = value
	}
	return out
}
