// Package samplefeeds is a test-only Plugin Manifest API 3 plugin that
// publishes feeds. Like the other samples it is never bundled with a
// release. Host tests load it to prove feed publication, overrides, remote
// images, and the Data Source projection.
package samplefeeds

import "github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"

// ID is the sample plugin's identifier.
const ID = "sample_feeds"

const manifest = `{
  "apiVersion": 3,
  "id": "sample_feeds",
  "definitionVersion": 1,
  "name": "Sample Feeds",
  "description": "A test plugin on Plugin Manifest API 3 that publishes feeds.",
  "category": "Display",
  "icon": "rss",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "board", "plural": "boards" },
  "server": { "entrypoint": "./plugin.go" },
  "api": { "basePaths": ["/plugins/sample-feeds"] },
  "studio": { "route": "/plugins/sample-feeds" },
  "services": ["feeds.publish@1", "http.fetch@1"],
  "connections": [
    { "id": "images", "title": "Image CDN", "type": "http", "origins": ["https://images.example.com"] },
    { "id": "lan_images", "title": "Local images", "type": "http", "origins": "operator", "privateNetwork": "allowed", "plainHttp": "allowed" }
  ],
  "instances": [
    {
      "kind": "board",
      "noun": { "singular": "board", "plural": "boards" },
      "path": "boards",
      "operations": { "singular": "SampleBoard", "plural": "SampleBoards" },
      "targeting": "none",
      "schedule": "none",
      "fields": [{ "key": "title", "label": "Title", "control": "text", "required": true, "maxLength": 80 }]
    },
    {
      "kind": "other",
      "noun": { "singular": "other", "plural": "others" },
      "path": "others",
      "operations": { "singular": "SampleOther", "plural": "SampleOthers" },
      "targeting": "none",
      "schedule": "none",
      "fields": [{ "key": "title", "label": "Title", "control": "text", "required": true, "maxLength": 80 }]
    }
  ],
  "feeds": [
    {
      "id": "items",
      "version": 1,
      "title": "Items",
      "dataset": "instance",
      "instanceKind": "board",
      "expectedRefreshSeconds": 300,
      "fields": [
        { "key": "name", "label": "Name", "control": "text", "maxLength": 120, "required": true, "override": "local_until_changed" },
        { "key": "short", "label": "Short label", "control": "text", "maxLength": 40, "override": "local" },
        { "key": "price", "label": "Price", "control": "number", "minimum": 0 },
        { "key": "available", "label": "Available", "control": "boolean" },
        { "key": "contact", "label": "Contact", "control": "text", "maxLength": 80, "override": "local", "personal": { "retentionDays": 1 } },
        { "key": "photo", "label": "Photo", "control": "url", "image": { "connection": "images" } },
        { "key": "lanPhoto", "label": "Local photo", "control": "url", "image": { "connection": "lan_images" } }
      ]
    },
    {
      "id": "notices",
      "version": 1,
      "title": "Notices",
      "dataset": "organization",
      "expectedRefreshSeconds": 60,
      "fields": [
        { "key": "text", "label": "Text", "control": "multiline_text", "maxLength": 4096 },
        { "key": "posted", "label": "Posted", "control": "datetime" }
      ]
    }
  ],
  "docs": { "reference": "packages/plugin-sdk/go/plugintest/samplefeeds" }
}`

// Plugin is the sample plugin.
type Plugin struct {
	plugin.Bundle
	services *plugin.Services
}

var _ plugin.ServiceConsumer = (*Plugin)(nil)

// New returns the sample plugin.
func New() *Plugin { return &Plugin{Bundle: plugin.NewBundle([]byte(manifest), nil)} }

// UseServices receives the typed service client.
func (p *Plugin) UseServices(services *plugin.Services) { p.services = services }
