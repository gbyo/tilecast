package notify

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Plugin notification channels (docs/plugin-providers.md). A channel is a
// third sender of this outbox, beside email and webhooks. It delivers a
// notification that Enqueue already decided to send: the plugin never
// chooses recipients, volume, category, severity policy, quiet hours, or
// digests. Like a webhook, a channel is a machine receiver, so quiet hours
// and digests do not apply to it.
//
// This package does not know how plugins are hosted. The plugin host
// implements ChannelProvider, and main wires it with SetChannelProvider.

// ChannelPlugin is the channel column of a plugin channel's deliveries. Its
// target is "<plugin id>:<channel id>".
const ChannelPlugin = "plugin"

// PluginChannel is one installed, declared channel that is ready now.
type PluginChannel struct {
	// Target is "<plugin id>:<channel id>".
	Target string
}

// PluginNotification is the host-rendered message a channel delivers.
type PluginNotification struct {
	EventKey   string
	Category   string
	Severity   string
	Subject    string
	Body       string
	OccurredAt time.Time
	StudioURL  string
}

// Outcomes of a channel delivery. Any other error is temporary and retries
// on the outbox's backoff.
var (
	// ErrChannelGone: the plugin or the channel no longer exists. The
	// delivery is cancelled, never retried.
	ErrChannelGone = errors.New("the plugin channel no longer exists")
	// ErrChannelOff: the channel is intentionally off or not configured.
	// The delivery is cancelled.
	ErrChannelOff = errors.New("the plugin channel is not available")
)

// ChannelProvider lists and invokes plugin channels.
type ChannelProvider interface {
	// ReadyChannels lists the channels that should receive a new
	// notification now: installed, declared, and not intentionally off.
	ReadyChannels(ctx context.Context) ([]PluginChannel, error)
	// DeliverToChannel delivers one notification. It returns nil,
	// ErrChannelGone, ErrChannelOff, an error wrapping ErrPermanent, or a
	// temporary error.
	DeliverToChannel(ctx context.Context, target string, notification PluginNotification) error
}

// SetChannelProvider wires plugin notification channels. Without it, no
// plugin channel receives anything.
func (s *Service) SetChannelProvider(provider ChannelProvider) { s.channels = provider }

// pluginTargets lists the ready plugin channels, sorted for a stable order.
func (s *Service) pluginTargets(ctx context.Context) ([]PluginChannel, error) {
	if s.channels == nil {
		return nil, nil
	}
	return s.channels.ReadyChannels(ctx)
}

// deliverPlugin sends one delivery to a plugin channel. The delivery log
// keeps a fixed message for each outcome, never the plugin's error text.
func (s *Service) deliverPlugin(ctx context.Context, item pendingDelivery) bool {
	if s.channels == nil {
		s.cancel(ctx, item, "Plugin notification channels are not available on this Server.")
		return false
	}
	notification := PluginNotification{
		EventKey: item.eventKey, Category: item.category, Severity: item.severity,
		Subject: item.subject, Body: item.body, OccurredAt: item.createdAt,
		StudioURL: studioURL(s.cfg.PublicURL, item.payload),
	}
	err := s.channels.DeliverToChannel(ctx, item.target, notification)
	switch {
	case err == nil:
		s.markSent(ctx, []pendingDelivery{item})
		return true
	case errors.Is(err, ErrChannelGone):
		s.cancel(ctx, item, "The plugin channel was removed before the notification was sent.")
	case errors.Is(err, ErrChannelOff):
		s.cancel(ctx, item, "The plugin channel was turned off before the notification was sent.")
	case errors.Is(err, ErrPermanent):
		s.failAll(ctx, []pendingDelivery{item}, errors.New("The plugin channel refused the notification."), true)
	default:
		s.failAll(ctx, []pendingDelivery{item}, errors.New("The plugin channel could not deliver the notification."), false)
	}
	return false
}

// studioURL is the absolute Studio link of a delivery's payload, or "".
func studioURL(publicURL string, payload []byte) string {
	link := studioLink(publicURL, payload)
	if !strings.HasPrefix(link, "http://") && !strings.HasPrefix(link, "https://") {
		return ""
	}
	return link
}
