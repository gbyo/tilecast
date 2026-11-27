// Package sampleconnections is a test-only Plugin Manifest API 3 plugin
// with host connections. Like the other samples it is never bundled with a
// release. Host tests load it to prove connection records, consents,
// connection fields, and http.fetch@1 with secret headers.
package sampleconnections

import (
	"context"
	"sync"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ID is the sample plugin's identifier.
const ID = "sample_connections"

const manifest = `{
  "apiVersion": 3,
  "id": "sample_connections",
  "definitionVersion": 1,
  "name": "Sample Connections",
  "description": "A test plugin on Plugin Manifest API 3 with host-owned outbound connections.",
  "category": "Workflow",
  "icon": "plug",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "source", "plural": "sources" },
  "server": { "entrypoint": "./plugin.go" },
  "api": { "basePaths": ["/plugins/sample-connections"] },
  "studio": { "route": "/plugins/sample-connections" },
  "services": ["http.fetch@1", "secrets.read@1"],
  "connections": [
    {
      "id": "api",
      "title": "Example API",
      "type": "http",
      "origins": ["https://api.example.com", "https://files.example.com"]
    },
    {
      "id": "large",
      "title": "Large export",
      "type": "http",
      "origins": ["https://example.com"],
      "maxResponseBytes": 16777216,
      "timeoutSeconds": 60
    },
    {
      "id": "lan",
      "title": "Local gateway",
      "type": "http",
      "origins": "operator",
      "privateNetwork": "allowed",
      "plainHttp": "allowed",
      "allowPlaintextSecret": true
    },
    {
      "id": "lan_strict",
      "title": "Local gateway without plaintext secrets",
      "type": "http",
      "origins": "operator",
      "privateNetwork": "allowed",
      "plainHttp": "allowed"
    },
    {
      "id": "private_https",
      "title": "Private HTTPS service",
      "type": "http",
      "origins": "operator",
      "privateNetwork": "allowed"
    },
    {
      "id": "calendar",
      "title": "Example Calendar",
      "type": "oauth2",
      "origins": ["https://api.example.com"],
      "oauth": {
        "authorizationEndpoint": "https://auth.example.com/authorize",
        "tokenEndpoint": "https://auth.example.com/token",
        "revocationEndpoint": "https://auth.example.com/revoke",
        "scopes": ["calendar.read", "offline"],
        "tokenEndpointAuthMethod": "client_secret_basic",
        "authorizationParameters": { "access_type": "offline", "prompt": "consent" }
      }
    },
    {
      "id": "calendar_json",
      "title": "Example Calendar with JSON token requests",
      "type": "oauth2",
      "origins": ["https://api.example.com"],
      "oauth": {
        "authorizationEndpoint": "https://auth.example.com/authorize",
        "tokenEndpoint": "https://auth.example.com/json-token",
        "scopes": ["calendar.read"],
        "tokenEndpointAuthMethod": "client_secret_post",
        "tokenRequestFormat": "json"
      }
    },
    {
      "id": "calendar_public",
      "title": "Example Calendar for a public client",
      "type": "oauth2",
      "origins": ["https://api.example.com"],
      "oauth": {
        "authorizationEndpoint": "https://auth.example.com/authorize",
        "tokenEndpoint": "https://auth.example.com/token",
        "revocationEndpoint": "https://auth.example.com/revoke",
        "scopes": ["calendar.read"],
        "tokenEndpointAuthMethod": "none"
      }
    }
  ],
  "settings": {
    "organization": [
      { "key": "apiToken", "label": "API token", "control": "secret", "maxLength": 200 },
      { "key": "primary", "label": "Primary connection", "control": "connection", "connections": ["api"] },
      { "key": "calendar", "label": "Calendar connection", "control": "connection", "connections": ["calendar", "calendar_json", "calendar_public"] }
    ]
  },
  "instances": [
    {
      "kind": "source",
      "noun": { "singular": "source", "plural": "sources" },
      "path": "sources",
      "operations": { "singular": "SampleSource", "plural": "SampleSources" },
      "targeting": "none",
      "schedule": "none",
      "fields": [
        { "key": "title", "label": "Title", "control": "text", "required": true, "maxLength": 80 },
        { "key": "gateway", "label": "Gateway", "control": "connection", "connections": ["lan", "lan_strict"], "required": true },
        { "key": "gatewayKey", "label": "Gateway key", "control": "secret", "maxLength": 200 }
      ]
    }
  ],
  "docs": { "reference": "packages/plugin-sdk/go/plugintest/sampleconnections" }
}`

// Plugin is the sample plugin.
type Plugin struct {
	plugin.Bundle

	mu       sync.Mutex
	services *plugin.Services
}

var _ plugin.ServiceConsumer = (*Plugin)(nil)

// New returns the sample plugin.
func New() *Plugin {
	return &Plugin{Bundle: plugin.NewBundle([]byte(manifest), nil)}
}

// UseServices receives the typed service client.
func (p *Plugin) UseServices(services *plugin.Services) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.services = services
}

// Fetch sends one request through the host, the way plugin code does.
func (p *Plugin) Fetch(ctx context.Context, request plugin.HTTPRequest) (plugin.HTTPResponse, error) {
	p.mu.Lock()
	services := p.services
	p.mu.Unlock()
	return services.Fetch(ctx, request)
}
