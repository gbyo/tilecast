// Package samplev2 is a test-only Plugin API v2 plugin with a Player
// contribution that has no visual surface. Like sampleplugin it is never
// bundled with a release: host tests load it to prove that v2 Player state
// travels through the generic projection path, gated by the Player's
// reported plugin host, without any special case.
package samplev2

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ID is the sample plugin's identifier.
const ID = "sample_beacon"

const manifest = `{
  "apiVersion": 2,
  "id": "sample_beacon",
  "definitionVersion": 1,
  "name": "Sample Beacon",
  "description": "A test plugin whose Player contribution observes playback without drawing.",
  "category": "Automation",
  "icon": "radio",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "beacon", "plural": "beacons" },
  "server": { "entrypoint": "./plugin.go" },
  "player": {
    "state": [{ "type": "sample_beacon", "version": 1 }],
    "runtime": {
      "entrypoint": "./runtime/index.ts",
      "services": {
        "required": ["player.clock@1"],
        "optional": ["player.presentation.observe@1"]
      }
    }
  },
  "docs": { "reference": "packages/plugin-sdk/go/plugintest/samplev2" }
}`

// Beacon is one configured beacon. Media is projected as declared media.
type Beacon struct {
	ID         uuid.UUID
	Label      string
	Media      []plugin.MediaRef
	ValidUntil *time.Time
}

// Plugin is the sample v2 plugin.
type Plugin struct {
	plugin.Bundle
	host plugin.Host

	mu      sync.Mutex
	beacons map[uuid.UUID]Beacon
}

var (
	_ plugin.Initializer          = (*Plugin)(nil)
	_ plugin.PlayerStateProjector = (*Plugin)(nil)
)

func New() *Plugin {
	return &Plugin{Bundle: plugin.NewBundle([]byte(manifest), nil), beacons: map[uuid.UUID]Beacon{}}
}

func (p *Plugin) Init(_ context.Context, host plugin.Host) error {
	p.host = host
	return nil
}

// Put stores a beacon for every screen.
func (p *Plugin) Put(beacon Beacon) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.beacons[beacon.ID] = beacon
}

func (p *Plugin) ProjectPlayerState(context.Context, uuid.UUID) ([]plugin.PlayerState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	states := []plugin.PlayerState{}
	for _, beacon := range p.beacons {
		states = append(states, plugin.PlayerState{
			ID: beacon.ID, Type: "sample_beacon", Version: 1,
			State: map[string]any{"label": beacon.Label},
			Media: beacon.Media, ValidUntil: beacon.ValidUntil,
		})
	}
	return states, nil
}
