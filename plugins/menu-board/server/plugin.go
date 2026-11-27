// Package server is Square Menu Board's server contribution on Plugin
// Manifest API 3. The host stores the menus, the Square connection and its
// tokens, the timers, and the feed, and it downloads item pictures itself.
// This package reads the Square item library through http.fetch@1 and
// publishes each menu.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Kind is the one instance kind, a menu.
const Kind = "menu"

// Feed is the published feed.
const Feed = "items"

const (
	tickKey      = "tick"
	tickInterval = 10 * time.Minute
	// validFor is how long Players treat a menu as current; each sync
	// extends it.
	validFor = time.Hour
)

func syncKey(menu uuid.UUID) string  { return "sync:" + menu.String() }
func stateKey(menu uuid.UUID) string { return "menu:" + menu.String() }

// Config is a menu's configuration.
type Config struct {
	Connection       uuid.UUID `json:"connection"`
	ImagesConnection uuid.UUID `json:"imagesConnection"`
	LocationID       string    `json:"locationId"`
	Sample           bool      `json:"sample"`
}

// syncState is the read metadata kept in storage.kv@1: when the last read
// finished and what it saw. The catalog itself is never stored there; the
// feed holds the menu.
type syncState struct {
	LastSync time.Time `json:"lastSync"`
	Objects  int       `json:"objects"`
	Pages    int       `json:"pages"`
	Complete bool      `json:"complete"`
	Records  int       `json:"records"`
}

// Plugin is Square Menu Board.
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

// ValidateInstance checks that a menu reads Square unless it shows the
// sample menu, and asks for an early tick so a saved menu syncs within
// seconds.
func (p *Plugin) ValidateInstance(ctx context.Context, instance plugin.HostedInstance) error {
	var config Config
	if err := instance.Decode(&config); err != nil {
		return plugin.Invalidf("the configuration is not valid")
	}
	if !config.Sample && config.Connection == uuid.Nil {
		return plugin.Invalidf("choose a Square connection, or turn on the sample menu")
	}
	if strings.ContainsAny(config.LocationID, " /?#") {
		return plugin.Invalidf("a Square location ID has no spaces or slashes")
	}
	// Best effort: without the early tick the item syncs at the next
	// regular tick, and a save never fails because a timer could not be set.
	if services := p.client(); services != nil {
		_, _ = services.ScheduleTimer(ctx, tickKey, p.Now().Add(2*time.Second), nil)
	}
	return nil
}

// DemoInstances adds one menu with the sample items. Demo Mode never signs
// in to Square.
func (p *Plugin) DemoInstances(context.Context, plugin.Demo) ([]plugin.DemoInstance, error) {
	return []plugin.DemoInstance{{Kind: Kind, Name: "Cafe menu", Enabled: true, Configuration: map[string]any{"sample": true, "locationId": ""}}}, nil
}

// HandleTimer runs a tick or one menu's sync. Both are idempotent.
func (p *Plugin) HandleTimer(ctx context.Context, timer plugin.Timer) error {
	services := p.client()
	if services == nil {
		return errors.New("menu board: no service client")
	}
	if timer.Key == tickKey {
		menus, err := services.ListInstances(ctx, Kind)
		if err != nil {
			return err
		}
		now := p.Now()
		for index, menu := range menus {
			if menu.Enabled {
				if _, err := services.ScheduleTimer(ctx, syncKey(menu.ID), now.Add(time.Duration(index%30)*2*time.Second), nil); err != nil {
					return err
				}
			}
		}
		_, err = services.ScheduleTimer(ctx, tickKey, now.Add(tickInterval), nil)
		return err
	}
	if id, ok := strings.CutPrefix(timer.Key, "sync:"); ok {
		menu, err := uuid.Parse(id)
		if err != nil {
			return nil
		}
		return p.syncMenu(ctx, services, menu)
	}
	return nil
}

// syncMenu publishes one menu. A Square or connection failure waits for
// the next tick; the feed's staleness is the signal in Content Health and
// on the sign.
func (p *Plugin) syncMenu(ctx context.Context, services *plugin.Services, menu uuid.UUID) error {
	instance, err := services.ReadInstance(ctx, Kind, menu)
	if errors.Is(err, plugin.ErrInstanceNotFound) {
		return nil
	}
	if err != nil || !instance.Enabled {
		return err
	}
	var config Config
	if err := instance.Decode(&config); err != nil {
		return nil
	}
	now := p.Now()
	if config.Sample {
		return p.publish(ctx, services, menu, sampleMenu(), nil, now)
	}
	read, err := listCatalog(ctx, services, config.Connection)
	if err != nil {
		return nil
	}
	records := assemble(read.Objects, config.LocationID, config.ImagesConnection != uuid.Nil)
	connections := map[string]uuid.UUID{}
	if config.ImagesConnection != uuid.Nil {
		connections["square_images"] = config.ImagesConnection
	}
	if err := p.publish(ctx, services, menu, records, connections, now); err != nil {
		return err
	}
	encoded, _ := json.Marshal(syncState{LastSync: now.UTC(), Objects: len(read.Objects), Pages: read.Pages, Complete: read.Complete, Records: len(records)})
	return services.KVSet(ctx, stateKey(menu), encoded)
}

func (p *Plugin) publish(ctx context.Context, services *plugin.Services, menu uuid.UUID, records []plugin.FeedRecord, connections map[string]uuid.UUID, now time.Time) error {
	until := now.Add(validFor)
	for attempt := 0; attempt < 2; attempt++ {
		revision, err := services.FeedRevision(ctx, Feed, menu)
		if err != nil {
			return err
		}
		_, err = services.PublishFeed(ctx, plugin.FeedPublication{Feed: Feed, Instance: menu, Replaces: revision, Records: records,
			ValidUntil: &until, Connections: connections})
		if !errors.Is(err, plugin.ErrFeedConflict) {
			return err
		}
	}
	return nil
}
