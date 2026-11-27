// Package samplestate is a test-only Plugin Manifest API 3 plugin with
// storage.kv@1 and durable timers. Like the other samples it is never
// bundled with a release. Host tests load it to prove the key/value store,
// timer scheduling, and at-least-once timer delivery.
package samplestate

import (
	"context"
	"sync"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ID is the sample plugin's identifier.
const ID = "sample_state"

const manifest = `{
  "apiVersion": 3,
  "id": "sample_state",
  "definitionVersion": 1,
  "name": "Sample State",
  "description": "A test plugin on Plugin Manifest API 3 with key/value storage and durable timers.",
  "category": "Workflow",
  "icon": "timer",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "item", "plural": "items" },
  "server": { "entrypoint": "./plugin.go" },
  "api": { "basePaths": ["/plugins/sample-state"] },
  "studio": { "route": "/plugins/sample-state" },
  "services": ["storage.kv@1", "timers.schedule@1", "timers.cancel@1"],
  "settings": {
    "organization": [
      { "key": "label", "label": "Label", "control": "text", "maxLength": 80 }
    ]
  },
  "docs": { "reference": "packages/plugin-sdk/go/plugintest/samplestate" }
}`

// Delivery is one HandleTimer call as the plugin saw it.
type Delivery struct {
	Timer plugin.Timer
	// Context is the call context the host bound, from the context the
	// plugin received.
	Principal bool
}

// Plugin is the sample plugin. Handle, when set, decides each callback.
type Plugin struct {
	plugin.Bundle

	mu         sync.Mutex
	services   *plugin.Services
	deliveries []Delivery
	// Handle runs inside HandleTimer. A nil Handle succeeds.
	Handle func(ctx context.Context, services *plugin.Services, timer plugin.Timer) error
}

var (
	_ plugin.ServiceConsumer = (*Plugin)(nil)
	_ plugin.TimerHandler    = (*Plugin)(nil)
)

// New returns the sample plugin with the given definitionVersion.
func New() *Plugin {
	return &Plugin{Bundle: plugin.NewBundle([]byte(manifest), nil)}
}

// UseServices receives the typed service client.
func (p *Plugin) UseServices(services *plugin.Services) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.services = services
}

// Services returns the service client the host gave the plugin.
func (p *Plugin) Services() *plugin.Services {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.services
}

// HandleTimer records the delivery and runs Handle.
func (p *Plugin) HandleTimer(ctx context.Context, timer plugin.Timer) error {
	_, hasPrincipal := plugin.PrincipalFrom(ctx)
	p.mu.Lock()
	p.deliveries = append(p.deliveries, Delivery{Timer: timer, Principal: hasPrincipal})
	handle, services := p.Handle, p.services
	p.mu.Unlock()
	if handle == nil {
		return nil
	}
	return handle(ctx, services, timer)
}

// Deliveries returns the callbacks so far.
func (p *Plugin) Deliveries() []Delivery {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Delivery(nil), p.deliveries...)
}

// Reset forgets the callbacks so far.
func (p *Plugin) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deliveries = nil
}
