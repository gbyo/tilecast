// Package server is Room Sign's server contribution on Plugin Manifest API
// 3. The host stores the rooms, the Google connection and its tokens, the
// timers, the stored sync state, and the feed. This package reads Google
// Calendar through http.fetch@1 and publishes each room's meetings.
package server

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Kind is the one instance kind, a room.
const Kind = "room"

// Feed is the published feed.
const Feed = "events"

// Timer keys. "tick" lists the rooms and schedules each room's sync; a
// room's sync reads Google and publishes.
const (
	tickKey      = "tick"
	tickInterval = 5 * time.Minute
)

func syncKey(room uuid.UUID) string { return "sync:" + room.String() }

// Config is a room's configuration.
type Config struct {
	Connection    uuid.UUID `json:"connection"`
	CalendarID    string    `json:"calendarId"`
	LookAheadDays int       `json:"lookAheadDays"`
	ShowTitles    bool      `json:"showTitles"`
	Sample        bool      `json:"sample"`
}

// Plugin is Room Sign.
type Plugin struct {
	plugin.Bundle

	mu       sync.Mutex
	services *plugin.Services
	// Now is the clock. Tests replace it.
	Now        func() time.Time
	automation []byte
}

var (
	_ plugin.ServiceConsumer    = (*Plugin)(nil)
	_ plugin.InstanceValidator  = (*Plugin)(nil)
	_ plugin.InstanceDemoSeeder = (*Plugin)(nil)
	_ plugin.TimerHandler       = (*Plugin)(nil)
	_ plugin.AutomationProvider = (*Plugin)(nil)
)

// New returns the plugin for a bundle.
func New(bundle plugin.Bundle, automation []byte) *Plugin {
	return &Plugin{Bundle: bundle, Now: time.Now, automation: automation}
}

// Automation returns the automation document pluginctl generates from the
// manifest's instance kind.
func (p *Plugin) Automation() []byte { return p.automation }

// UseServices receives the typed service client.
func (p *Plugin) UseServices(services *plugin.Services) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.services = services
}

func (p *Plugin) client() *plugin.Services {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.services
}

// ValidateInstance checks what the field schema cannot say: a room reads a
// calendar through a connection unless it shows sample meetings. A valid
// save also asks for an early tick, so a new or changed room syncs within
// seconds instead of at the next five-minute tick.
func (p *Plugin) ValidateInstance(ctx context.Context, instance plugin.HostedInstance) error {
	var config Config
	if err := instance.Decode(&config); err != nil {
		return plugin.Invalidf("the configuration is not valid")
	}
	if !config.Sample && (config.Connection == uuid.Nil || strings.TrimSpace(config.CalendarID) == "") {
		return plugin.Invalidf("choose a Google connection and a calendar ID, or turn on sample meetings")
	}
	// Best effort: without the early tick the item syncs at the next
	// regular tick, and a save never fails because a timer could not be set.
	if services := p.client(); services != nil {
		_, _ = services.ScheduleTimer(ctx, tickKey, p.Now().Add(2*time.Second), nil)
	}
	return nil
}

// DemoInstances adds one room with sample meetings. Demo Mode never signs
// in to Google.
func (p *Plugin) DemoInstances(context.Context, plugin.Demo) ([]plugin.DemoInstance, error) {
	return []plugin.DemoInstance{{Kind: Kind, Name: "Board Room", Enabled: true,
		Configuration: map[string]any{"lookAheadDays": 2, "showTitles": true, "sample": true, "calendarId": ""}}}, nil
}

// HandleTimer runs a tick or one room's sync. Both are idempotent: a tick
// schedules syncs by key, and a sync publishes the full record set again.
func (p *Plugin) HandleTimer(ctx context.Context, timer plugin.Timer) error {
	services := p.client()
	if services == nil {
		return errors.New("room sign: no service client")
	}
	if timer.Key == tickKey {
		return p.tick(ctx, services)
	}
	if room, ok := strings.CutPrefix(timer.Key, "sync:"); ok {
		id, err := uuid.Parse(room)
		if err != nil {
			return nil
		}
		return p.syncRoom(ctx, services, id)
	}
	return nil
}

func (p *Plugin) tick(ctx context.Context, services *plugin.Services) error {
	rooms, err := services.ListInstances(ctx, Kind)
	if err != nil {
		return err
	}
	now := p.Now()
	for index, room := range rooms {
		if !room.Enabled {
			continue
		}
		// Spread the rooms over the first minute of the interval.
		at := now.Add(time.Duration(index%30) * 2 * time.Second)
		if _, err := services.ScheduleTimer(ctx, syncKey(room.ID), at, nil); err != nil {
			return err
		}
	}
	_, err = services.ScheduleTimer(ctx, tickKey, now.Add(tickInterval), nil)
	return err
}

// syncRoom publishes one room. A room that no longer exists or is off
// stops here. A Google or connection failure is not retried by the timer:
// the next tick tries again, and the feed's staleness is the signal in
// Content Health and on the sign.
func (p *Plugin) syncRoom(ctx context.Context, services *plugin.Services, room uuid.UUID) error {
	instance, err := services.ReadInstance(ctx, Kind, room)
	if errors.Is(err, plugin.ErrInstanceNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !instance.Enabled {
		return nil
	}
	var config Config
	if err := instance.Decode(&config); err != nil {
		return nil
	}
	if config.LookAheadDays < 1 {
		config.LookAheadDays = 2
	}
	now := p.Now()
	if config.Sample {
		return p.publish(ctx, services, room, sampleRecords(now), now)
	}
	key := stateKey(room)
	raw, err := services.KVGet(ctx, key)
	if err != nil && !errors.Is(err, plugin.ErrKVNotFound) {
		return err
	}
	state, _ := decodeState(raw)
	if err := syncGoogle(ctx, services, config, &state, now); err != nil {
		return nil
	}
	if err := saveState(ctx, services, key, raw, state); err != nil {
		return err
	}
	return p.publish(ctx, services, room, state.records(config, now), now)
}

// saveState writes the state only when nobody else wrote it since it was
// read; a concurrent sync of the same room then wins, and this one's
// publication is still correct.
func saveState(ctx context.Context, services *plugin.Services, key string, previous []byte, state roomState) error {
	encoded, err := encodeState(state)
	if err != nil {
		return err
	}
	_, err = services.KVCompareAndSet(ctx, key, previous, encoded)
	return err
}

func (p *Plugin) publish(ctx context.Context, services *plugin.Services, room uuid.UUID, records []plugin.FeedRecord, now time.Time) error {
	until := now.Add(validFor)
	for attempt := 0; attempt < 2; attempt++ {
		revision, err := services.FeedRevision(ctx, Feed, room)
		if err != nil {
			return err
		}
		_, err = services.PublishFeed(ctx, plugin.FeedPublication{Feed: Feed, Instance: room, Replaces: revision, Records: records, ValidUntil: &until})
		if !errors.Is(err, plugin.ErrFeedConflict) {
			return err
		}
	}
	return nil
}
