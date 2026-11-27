// Package pluginproviders connects the plugin host to the core features
// whose provider slots plugins fill (docs/plugin-providers.md). notify and
// contenthealth define narrow interfaces and know nothing of plugin
// hosting; the plugin host knows nothing of the outbox or the sweep. This
// package maps one to the other, and maps the SDK's typed outcomes to the
// core's, so core policy never reads a plugin's error text.
package pluginproviders

import (
	"context"
	"errors"
	"fmt"

	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/notify"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Channels is notify's ChannelProvider on the plugin host.
type Channels struct{ Plugins *plugins.Service }

var _ notify.ChannelProvider = Channels{}

// ReadyChannels lists the ready channels of installed plugins.
func (c Channels) ReadyChannels(ctx context.Context) ([]notify.PluginChannel, error) {
	channels, err := c.Plugins.NotificationChannels(ctx, true)
	if err != nil {
		return nil, err
	}
	out := make([]notify.PluginChannel, 0, len(channels))
	for _, channel := range channels {
		out = append(out, notify.PluginChannel{Target: channel.Target()})
	}
	return out, nil
}

// DeliverToChannel delivers one notification and maps its outcome.
func (c Channels) DeliverToChannel(ctx context.Context, target string, n notify.PluginNotification) error {
	err := c.Plugins.DeliverNotification(ctx, target, plugin.Notification{
		EventKey: n.EventKey, Category: n.Category, Severity: n.Severity, Subject: n.Subject,
		Body: n.Body, OccurredAt: n.OccurredAt, StudioURL: n.StudioURL,
	})
	switch {
	case err == nil:
		return nil
	case errors.Is(err, plugins.ErrChannelGone):
		return notify.ErrChannelGone
	case errors.Is(err, plugin.ErrChannelUnavailable):
		return notify.ErrChannelOff
	case errors.Is(err, plugin.ErrNotificationPermanent):
		return fmt.Errorf("%w: plugin channel", notify.ErrPermanent)
	}
	return errors.New("temporary plugin channel failure")
}

// Checks is contenthealth's PluginChecks on the plugin host.
type Checks struct{ Plugins *plugins.Service }

var _ contenthealth.PluginChecks = Checks{}

// ContentChecks lists the checks of installed plugins.
func (c Checks) ContentChecks(ctx context.Context) ([]contenthealth.PluginCheck, error) {
	checks, err := c.Plugins.ContentChecks(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]contenthealth.PluginCheck, 0, len(checks))
	for _, check := range checks {
		out = append(out, contenthealth.PluginCheck{PluginID: check.PluginID, CheckID: check.Check.ID,
			Title: check.Check.Title, Kinds: append([]string{}, check.Check.Kinds...)})
	}
	return out, nil
}

// RunContentCheck runs one check and maps its failure code.
func (c Checks) RunContentCheck(ctx context.Context, pluginID, checkID string, item plugin.ContentItem) ([]plugin.Condition, error) {
	conditions, err := c.Plugins.RunContentCheck(ctx, pluginID, checkID, item)
	var failure *plugins.ContentCheckError
	if errors.As(err, &failure) {
		return nil, &contenthealth.CheckFailure{Code: failure.Code}
	}
	return conditions, err
}
