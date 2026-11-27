// Package providerplugins holds two test-only Plugin Manifest API 3
// plugins for provider slot conformance tests (docs/plugin-providers.md): a
// notification channel and a Content Health checker. They are never bundled
// with a release.
package providerplugins

import (
	"context"
	"sync"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Plugin IDs and declarations.
const (
	ChannelID = "harness_channel"
	Channel   = "push"
	CheckerID = "harness_checker"
	Check     = "lint"
)

const channelManifest = `{
  "apiVersion": 3,
  "id": "harness_channel",
  "definitionVersion": 1,
  "name": "Harness Channel",
  "description": "A test notification channel that records what it receives.",
  "category": "Workflow",
  "icon": "bell",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "item", "plural": "items" },
  "server": { "entrypoint": "./plugin.go" },
  "providers": { "notifications": { "channels": [ { "id": "push", "title": "Push" } ] } }
}`

const checkerManifest = `{
  "apiVersion": 3,
  "id": "harness_checker",
  "definitionVersion": 1,
  "name": "Harness Checker",
  "description": "A test Content Health check that records every item it receives.",
  "category": "Workflow",
  "icon": "list-checks",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "item", "plural": "items" },
  "server": { "entrypoint": "./plugin.go" },
  "providers": { "contentHealth": { "checks": [
    { "id": "lint", "title": "Content lint", "kinds": ["playlist", "media_item", "widget_instance"] }
  ] } }
}`

// ChannelPlugin records notifications. SetReady and SetOutcome decide its
// answers.
type ChannelPlugin struct {
	plugin.Bundle
	mu       sync.Mutex
	ready    bool
	outcome  func(plugin.Notification) error
	received []plugin.Notification
	system   []bool
}

var (
	_ plugin.NotificationChannelProvider = (*ChannelPlugin)(nil)
	_ plugin.NotificationChannelStatus   = (*ChannelPlugin)(nil)
)

// NewChannel returns the channel plugin, ready.
func NewChannel() *ChannelPlugin {
	return &ChannelPlugin{Bundle: plugin.NewBundle([]byte(channelManifest), nil), ready: true}
}

// SetReady decides NotificationChannelReady.
func (c *ChannelPlugin) SetReady(ready bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ready = ready
}

// SetOutcome decides each later delivery.
func (c *ChannelPlugin) SetOutcome(outcome func(plugin.Notification) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.outcome = outcome
}

// NotificationChannelReady answers SetReady.
func (c *ChannelPlugin) NotificationChannelReady(context.Context, string) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ready, nil
}

// DeliverNotification records the notification and answers SetOutcome.
func (c *ChannelPlugin) DeliverNotification(ctx context.Context, notification plugin.Notification) error {
	_, operator := plugin.PrincipalFrom(ctx)
	c.mu.Lock()
	c.received = append(c.received, notification)
	c.system = append(c.system, !operator)
	outcome := c.outcome
	c.mu.Unlock()
	if outcome != nil {
		return outcome(notification)
	}
	return nil
}

// Received returns the notifications so far.
func (c *ChannelPlugin) Received() []plugin.Notification {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]plugin.Notification(nil), c.received...)
}

// RanWithoutOperator reports whether every delivery ran with no operator.
func (c *ChannelPlugin) RanWithoutOperator() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, system := range c.system {
		if !system {
			return false
		}
	}
	return true
}

// CheckerPlugin records the items it checks. SetRespond decides each
// result.
type CheckerPlugin struct {
	plugin.Bundle
	mu      sync.Mutex
	respond func(plugin.ContentItem) ([]plugin.Condition, error)
	items   []plugin.ContentItem
}

var _ plugin.ContentChecker = (*CheckerPlugin)(nil)

// NewChecker returns the checker; it reports no condition.
func NewChecker() *CheckerPlugin {
	return &CheckerPlugin{Bundle: plugin.NewBundle([]byte(checkerManifest), nil)}
}

// SetRespond decides each later check.
func (c *CheckerPlugin) SetRespond(respond func(plugin.ContentItem) ([]plugin.Condition, error)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.respond = respond
}

// CheckContent records the item and answers SetRespond.
func (c *CheckerPlugin) CheckContent(_ context.Context, item plugin.ContentItem) ([]plugin.Condition, error) {
	c.mu.Lock()
	c.items = append(c.items, item)
	respond := c.respond
	c.mu.Unlock()
	if respond != nil {
		return respond(item)
	}
	return nil, nil
}

// Items returns the checked items so far.
func (c *CheckerPlugin) Items() []plugin.ContentItem {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]plugin.ContentItem(nil), c.items...)
}

// Reset forgets the checked items.
func (c *CheckerPlugin) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = nil
}
