// Package samplev3 is a test-only Plugin Manifest API 3 plugin. Like the
// other samples it is never bundled with a release: host tests load it to
// prove that host-owned settings, instances, secrets, schedules, personal
// data, and the typed service client work for a plugin that has no tables,
// routes, or Studio code of its own.
package samplev3

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ID is the sample plugin's identifier.
const ID = "sample_signs"

const manifest = `{
  "apiVersion": 3,
  "id": "sample_signs",
  "definitionVersion": 1,
  "name": "Sample Signs",
  "description": "A test plugin on Plugin Manifest API 3 with host-owned settings and instances.",
  "category": "Display",
  "icon": "signpost",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "sign", "plural": "signs" },
  "server": { "entrypoint": "./plugin.go" },
  "api": { "basePaths": ["/plugins/sample-signs"] },
  "studio": { "route": "/plugins/sample-signs" },
  "services": ["organization.read@1", "secrets.read@1", "settings.read@1"],
  "settings": {
    "organization": [
      { "key": "apiToken", "label": "API token", "control": "secret", "maxLength": 200 },
      { "key": "refreshMinutes", "label": "Refresh", "control": "integer", "default": 5, "minimum": 1, "maximum": 60 }
    ],
    "screen": [
      { "key": "room", "label": "Room", "control": "text", "maxLength": 80 }
    ]
  },
  "instances": [
    {
      "kind": "sign",
      "noun": { "singular": "sign", "plural": "signs" },
      "path": "signs",
      "operations": { "singular": "SampleSign", "plural": "SampleSigns" },
      "targeting": "screens",
      "schedule": "window",
      "priority": { "minimum": -10, "maximum": 10, "default": 0 },
      "fields": [
        { "key": "title", "label": "Title", "control": "text", "required": true, "maxLength": 80 },
        { "key": "contact", "label": "Contact", "control": "text", "maxLength": 80, "personal": { "retentionDays": 1 } },
        { "key": "accessKey", "label": "Access key", "control": "secret", "maxLength": 100 },
        { "key": "fontId", "label": "Font", "control": "font" },
        { "key": "logoAssetId", "label": "Logo", "control": "media_asset", "mediaTypes": ["image"] }
      ]
    },
    {
      "kind": "note",
      "noun": { "singular": "note", "plural": "notes" },
      "path": "notes",
      "operations": { "singular": "SampleNote", "plural": "SampleNotes" },
      "targeting": "none",
      "schedule": "none",
      "fields": [
        { "key": "text", "label": "Text", "control": "multiline_text", "required": true, "maxLength": 500 }
      ]
    }
  ],
  "player": {
    "state": [{ "type": "sample_sign", "version": 1 }],
    "runtime": {
      "entrypoint": "./runtime/index.ts",
      "services": { "required": ["player.clock@1"] }
    }
  },
  "docs": { "reference": "packages/plugin-sdk/go/plugintest/samplev3" }
}`

// Plugin is the sample API 3 plugin.
type Plugin struct {
	plugin.Bundle

	mu       sync.Mutex
	services *plugin.Services
}

var (
	_ plugin.InstanceValidator = (*Plugin)(nil)
	_ plugin.InstanceProjector = (*Plugin)(nil)
	_ plugin.ServiceConsumer   = (*Plugin)(nil)
)

func New() *Plugin {
	return &Plugin{Bundle: plugin.NewBundle([]byte(manifest), nil)}
}

// UseServices receives the typed service client.
func (p *Plugin) UseServices(services *plugin.Services) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.services = services
}

// Services returns the client the host gave the plugin.
func (p *Plugin) Services() *plugin.Services {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.services
}

// ValidateInstance refuses a sign titled "forbidden", a rule no field schema
// can state.
func (p *Plugin) ValidateInstance(_ context.Context, instance plugin.HostedInstance) error {
	if title, _ := instance.Configuration["title"].(string); strings.EqualFold(title, "forbidden") {
		return plugin.Invalidf("that title is not allowed")
	}
	return nil
}

// ProjectInstance sends the Player the sign's title, with the organization
// refresh interval and the screen's room from the plugin's settings.
func (p *Plugin) ProjectInstance(_ context.Context, instance plugin.HostedInstance, target plugin.ProjectionTarget) (plugin.InstanceProjection, error) {
	if instance.Kind != "sign" {
		return plugin.InstanceProjection{}, nil
	}
	state := map[string]any{"title": instance.Configuration["title"], "refreshMinutes": target.OrganizationSettings["refreshMinutes"]}
	if room, ok := target.ScreenSettings["room"]; ok {
		state["room"] = room
	}
	if instance.Schedule != nil {
		state["endsAt"] = instance.Schedule.EndsAt
	}
	return plugin.InstanceProjection{
		State:  &plugin.PlayerState{Type: "sample_sign", Version: 1, State: state},
		Legacy: nil,
	}, nil
}

// ReadToken reads the organization API token through the service client, the
// way a plugin's background work does. It returns the secret's value.
func (p *Plugin) ReadToken(ctx context.Context) (string, error) {
	return p.Services().ReadSecret(ctx, plugin.ScopeOrganization, uuid.Nil, "apiToken")
}

// Organization reads the organization name through the service client.
func (p *Plugin) Organization(ctx context.Context) (string, error) {
	var out struct {
		Name string `json:"name"`
	}
	if err := p.Services().OrganizationReadGet(ctx, nil, &out); err != nil {
		return "", fmt.Errorf("read organization: %w", err)
	}
	return out.Name, nil
}
