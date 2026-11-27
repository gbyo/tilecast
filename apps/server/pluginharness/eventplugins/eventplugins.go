// Package eventplugins holds two test-only Plugin Manifest API 3 plugins for
// event conformance tests: a publisher of one plugin event, and a
// subscriber of every core event and of plugin events. They are never
// bundled with a release.
package eventplugins

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Plugin IDs.
const (
	PublisherID  = "harness_publisher"
	SubscriberID = "harness_subscriber"
)

// Signal is the publisher's event, and SignalV2 a version it never
// declares.
const (
	Signal   = "plugin.harness_publisher.signal@1"
	SignalV2 = "plugin.harness_publisher.signal@2"
	// Missing names a publisher this release does not host.
	Missing = "plugin.absent_plugin.thing@1"
	// BellPeriodStarted is the Bell Schedule plugin's event.
	BellPeriodStarted = "plugin.bell_schedule.period_started@1"
)

const publisherManifest = `{
  "apiVersion": 3,
  "id": "harness_publisher",
  "definitionVersion": 1,
  "name": "Harness Publisher",
  "description": "A test plugin that publishes one event.",
  "category": "Workflow",
  "icon": "radio",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "item", "plural": "items" },
  "server": { "entrypoint": "./plugin.go" },
  "services": ["events.publish@1", "timers.schedule@1"],
  "events": {
    "publishes": [{
      "name": "signal", "version": 1, "title": "Signal",
      "fields": [
        { "key": "message", "label": "Message", "control": "text", "required": true },
        { "key": "count", "label": "Count", "control": "integer", "minimum": 0 },
        { "key": "at", "label": "At", "control": "datetime" }
      ]
    }]
  }
}`

const subscriberManifest = `{
  "apiVersion": 3,
  "id": "harness_subscriber",
  "definitionVersion": 1,
  "name": "Harness Subscriber",
  "description": "A test plugin that records every event it receives.",
  "category": "Workflow",
  "icon": "inbox",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "item", "plural": "items" },
  "server": { "entrypoint": "./plugin.go" },
  "services": ["storage.kv@1"],
  "events": {
    "subscribes": [
      "screen.status.changed@1",
      "takeover.started@1", "takeover.ended@1", "takeover.suspended@1",
      "incident.opened@1", "incident.recovered@1",
      "schedule.changed@1",
      "feed.stale@1",
      "plugin.harness_publisher.signal@1",
      "plugin.harness_publisher.signal@2",
      "plugin.absent_plugin.thing@1",
      "plugin.bell_schedule.period_started@1"
    ]
  }
}`

// Publisher publishes Signal through its service client from a timer
// callback, the way a real plugin publishes from durable work. The timer
// payload is a JSON Publication.
type Publisher struct {
	plugin.Bundle
	mu       sync.Mutex
	services *plugin.Services
	results  []PublishResult
}

// Publication is the timer payload: what to publish.
type Publication struct {
	Event   string         `json:"event"`
	Subject string         `json:"subject"`
	Payload map[string]any `json:"payload"`
}

// PublishResult is one publication as the plugin saw it.
type PublishResult struct {
	Occurrence plugin.PublishedOccurrence
	Err        error
}

var (
	_ plugin.ServiceConsumer = (*Publisher)(nil)
	_ plugin.TimerHandler    = (*Publisher)(nil)
)

// HandleTimer publishes the timer's Publication and records the result. A
// refused publication is recorded, not retried.
func (p *Publisher) HandleTimer(ctx context.Context, timer plugin.Timer) error {
	var publication Publication
	if err := json.Unmarshal(timer.Payload, &publication); err != nil {
		return err
	}
	occurrence, err := p.Services().PublishEvent(ctx, publication.Event, publication.Subject, publication.Payload)
	p.mu.Lock()
	p.results = append(p.results, PublishResult{Occurrence: occurrence, Err: err})
	p.mu.Unlock()
	return nil
}

// Results returns the publications so far.
func (p *Publisher) Results() []PublishResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]PublishResult(nil), p.results...)
}

// NewPublisher returns the publisher.
func NewPublisher() *Publisher {
	return &Publisher{Bundle: plugin.NewBundle([]byte(publisherManifest), nil)}
}

// UseServices receives the typed service client.
func (p *Publisher) UseServices(services *plugin.Services) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.services = services
}

// Services returns the client.
func (p *Publisher) Services() *plugin.Services {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.services
}

// Received is one HandleEvent call as the subscriber saw it.
type Received struct {
	Event plugin.Event
	// Principal is true when the call carried an operator.
	Principal bool
	// Deadline is the call's time limit, from the context.
	Deadline bool
}

// Subscriber records every delivery. Handle, when set, decides each one.
type Subscriber struct {
	plugin.Bundle
	mu       sync.Mutex
	services *plugin.Services
	received []Received
	Handle   func(ctx context.Context, event plugin.Event) error
}

var (
	_ plugin.ServiceConsumer = (*Subscriber)(nil)
	_ plugin.EventHandler    = (*Subscriber)(nil)
)

// NewSubscriber returns the subscriber.
func NewSubscriber() *Subscriber {
	return &Subscriber{Bundle: plugin.NewBundle([]byte(subscriberManifest), nil)}
}

// UseServices receives the typed service client.
func (s *Subscriber) UseServices(services *plugin.Services) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.services = services
}

// HandleEvent records the delivery and runs Handle.
func (s *Subscriber) HandleEvent(ctx context.Context, event plugin.Event) error {
	_, principal := plugin.PrincipalFrom(ctx)
	_, deadline := ctx.Deadline()
	s.mu.Lock()
	s.received = append(s.received, Received{Event: event, Principal: principal, Deadline: deadline})
	handle := s.Handle
	s.mu.Unlock()
	if handle != nil {
		return handle(ctx, event)
	}
	return nil
}

// Received returns the deliveries so far, optionally of one event name.
func (s *Subscriber) Received(names ...string) []Received {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Received{}
	for _, item := range s.received {
		if len(names) == 0 {
			out = append(out, item)
			continue
		}
		for _, name := range names {
			if item.Event.Name == name {
				out = append(out, item)
			}
		}
	}
	return out
}

// Reset forgets the deliveries so far.
func (s *Subscriber) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.received = nil
}
