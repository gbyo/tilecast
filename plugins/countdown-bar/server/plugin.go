// Package server is Countdown Bar's server contribution on Plugin Manifest
// API 3. The host stores, authorizes, audits, targets, and serves its
// instances; this package judges what a countdown means and turns one
// eligible instance into its Player state, with the Plugin API 1 entry for
// Players that do not host Plugin API 2.
package server

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ManifestType is the Player manifest entry type, version 1. It is also the
// Plugin API 2 Player state type, version 1, with the same configuration.
const ManifestType = "countdown_bar"

// Kind is the one instance kind.
const Kind = "instance"

// Plugin is Countdown Bar.
type Plugin struct {
	plugin.Bundle
	automation []byte
}

var (
	_ plugin.InstanceValidator  = (*Plugin)(nil)
	_ plugin.InstanceProjector  = (*Plugin)(nil)
	_ plugin.InstanceDemoSeeder = (*Plugin)(nil)
	_ plugin.AutomationProvider = (*Plugin)(nil)
)

func New(bundle plugin.Bundle, automation []byte) *Plugin {
	return &Plugin{Bundle: bundle, automation: automation}
}

// Automation returns the resolved automation document pluginctl generates
// from the manifest's instance kind.
func (p *Plugin) Automation() []byte { return p.automation }

// ValidateInstance applies the rules a field schema cannot state: which
// schedule fields each schedule type needs, the urgency stage order, and
// the character bounds of the text.
func (p *Plugin) ValidateInstance(_ context.Context, instance plugin.HostedInstance) error {
	var config Config
	if err := instance.Decode(&config); err != nil {
		return plugin.Invalidf("the configuration is not valid")
	}
	return config.Validate()
}

// ProjectInstance maps one eligible instance to Player state. The host has
// chosen the instance for the screen and sets the entry ID and fonts.
func (p *Plugin) ProjectInstance(_ context.Context, instance plugin.HostedInstance, _ plugin.ProjectionTarget) (plugin.InstanceProjection, error) {
	var config Config
	if err := instance.Decode(&config); err != nil {
		return plugin.InstanceProjection{}, fmt.Errorf("decode countdown bar %s: %w", instance.ID, err)
	}
	manifest := config.Manifest(instance.Name, instance.Priority)
	return plugin.InstanceProjection{
		State:  &plugin.PlayerState{Type: ManifestType, Version: 1, State: StateConfig{ManifestConfig: manifest, FontID: config.FontID}},
		Legacy: &plugin.ManifestEntry{Type: ManifestType, Version: 1, Config: manifest},
	}, nil
}

// DemoInstances adds a weekday lunch countdown to the demo schools.
func (p *Plugin) DemoInstances(_ context.Context, demo plugin.Demo) ([]plugin.DemoInstance, error) {
	targets := []uuid.UUID{}
	for _, name := range []string{"high_school", "middle_school"} {
		if id, ok := demo.Locations[name]; ok {
			targets = append(targets, id)
		}
	}
	target := plugin.Target{Scope: plugin.TargetLocations, IDs: targets}
	if len(targets) == 0 {
		target = plugin.Target{Scope: plugin.TargetAll, IDs: []uuid.UUID{}}
	}
	return []plugin.DemoInstance{{
		Kind: Kind, Name: "Lunch ends", Enabled: true, Target: &target,
		Configuration: map[string]any{
			"message": "Lunch ends in", "scheduleType": "weekly", "targetTime": "12:55",
			"daysOfWeek": []any{1.0, 2.0, 3.0, 4.0, 5.0}, "timezone": demo.Timezone, "leadTimeSeconds": 900.0,
		},
	}}, nil
}
