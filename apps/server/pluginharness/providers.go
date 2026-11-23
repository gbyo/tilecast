package pluginharness

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/contentmodel"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/notify"
	"github.com/tilecast/tilecast/apps/server/internal/pluginproviders"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// Provider slot helpers (docs/plugin-providers.md): the real notification
// outbox and the real Content Health sweep, wired to the plugin host as
// main wires them.

// NotificationPolicy is the organization notification settings a test
// runs notify with.
type NotificationPolicy map[string]any

type fixedSettings struct {
	mu     sync.Mutex
	values map[string]any
}

func (f *fixedSettings) Organization(context.Context) (settings.Document, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	values := map[string]any{}
	for key, value := range f.values {
		values[key] = value
	}
	return settings.Document{Values: values}, nil
}

// Notifications is the notification service with the given policy, no
// email server, a recording webhook sender, and the plugin channels.
type Notifications struct {
	*notify.Service
	Webhooks *RecordingWebhooks
	settings *fixedSettings
}

// SetPolicy replaces the organization notification settings.
func (n *Notifications) SetPolicy(policy NotificationPolicy) {
	n.settings.mu.Lock()
	defer n.settings.mu.Unlock()
	n.settings.values = policy
}

// RecordingWebhooks records the outgoing notification webhooks.
type RecordingWebhooks struct {
	mu    sync.Mutex
	Posts []notify.WebhookTarget
}

// Post records one webhook post.
func (r *RecordingWebhooks) Post(_ context.Context, target notify.WebhookTarget, _ []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Posts = append(r.Posts, target)
	return nil
}

// Count returns how many posts were made.
func (r *RecordingWebhooks) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.Posts)
}

// Notifications builds the notification service for the harness.
func (h *Harness) Notifications(policy NotificationPolicy) *Notifications {
	config := notify.DefaultConfig()
	config.PublicURL = PublicURL
	reader := &fixedSettings{values: policy}
	webhooks := &RecordingWebhooks{}
	service := notify.NewService(h.Pool, reader, config, nil, webhooks, slog.Default())
	service.SetChannelProvider(pluginproviders.Channels{Plugins: h.service})
	return &Notifications{Service: service, Webhooks: webhooks, settings: reader}
}

// ContentHealth is the content health service with the plugin checks, on
// the harness clock.
func (h *Harness) ContentHealth() *contenthealth.Service {
	service := contenthealth.NewService(h.Pool, &fixedSettings{values: map[string]any{}})
	service.SetEvents(h.service)
	if h.clock != nil {
		service.SetClock(func() time.Time { return h.clock.Now().UTC() })
	}
	service.SetPluginChecks(pluginproviders.Checks{Plugins: h.service},
		contentmodel.NewBuilder(h.Pool, h.playlists, layouts.NewService(h.Pool), h.Media), nil)
	return service
}
