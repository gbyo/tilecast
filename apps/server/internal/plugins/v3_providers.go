package plugins

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Provider slots of Plugin Manifest API 3 (docs/plugin-providers.md): the
// plugin host's side of notifications.channels and contenthealth.checks.
// notify and contenthealth do not know how plugins are hosted; the adapter
// in internal/pluginproviders connects them to these methods.

// Provider call time limits.
const (
	// channelReadyTimeout bounds a NotificationChannelReady call. It runs
	// while notify queues a notification.
	channelReadyTimeout = 2 * time.Second
	// notificationTimeout bounds one DeliverNotification call, the same job
	// time limit as a delivery callback.
	notificationTimeout = 30 * time.Second
	// contentCheckTimeout bounds one CheckContent call. A sweep checks many
	// items, so one item gets less than a callback.
	contentCheckTimeout = 10 * time.Second
)

// Errors of the channel slot.
var (
	// ErrChannelGone: the plugin or the channel no longer exists here.
	ErrChannelGone = errors.New("the notification channel no longer exists")
	// ErrChannelPanic: the channel's hook panicked. It is retried.
	ErrChannelPanic = errors.New("the notification channel failed")
)

// NotificationChannel is one installed, declared channel.
type NotificationChannel struct {
	PluginID string
	Channel  plugin.NotificationChannelDeclaration
}

// Target is the notification outbox target of a channel.
func (c NotificationChannel) Target() string { return c.PluginID + ":" + c.Channel.ID }

// SplitChannelTarget parses "<plugin id>:<channel id>".
func SplitChannelTarget(target string) (string, string, bool) {
	for i := len(target) - 1; i >= 0; i-- {
		if target[i] == ':' {
			return target[:i], target[i+1:], i > 0 && i < len(target)-1
		}
	}
	return "", "", false
}

// NotificationChannels lists the channels of installed plugins. ready
// keeps only the channels whose readiness hook answers true; a hook that
// fails counts as ready, so a provider problem shows up as a failed
// delivery instead of silence.
func (s *Service) NotificationChannels(ctx context.Context, ready bool) ([]NotificationChannel, error) {
	installed, err := s.installedPluginIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := []NotificationChannel{}
	for _, hosted := range s.hosted {
		if hosted.manifest.APIVersion < 3 || !installed[hosted.manifest.ID] {
			continue
		}
		if _, ok := hosted.plugin.(plugin.NotificationChannelProvider); !ok {
			continue
		}
		for _, channel := range hosted.manifest.NotificationChannels() {
			if ready && !s.channelReady(ctx, hosted, channel.ID) {
				continue
			}
			out = append(out, NotificationChannel{PluginID: hosted.manifest.ID, Channel: channel})
		}
	}
	return out, nil
}

func (s *Service) channelReady(ctx context.Context, hosted hostedPlugin, channel string) bool {
	status, ok := hosted.plugin.(plugin.NotificationChannelStatus)
	if !ok {
		return true
	}
	ready := true
	err := s.runProviderHook(ctx, hosted.manifest.ID, channelReadyTimeout, func(ctx context.Context) error {
		value, err := status.NotificationChannelReady(ctx, channel)
		ready = value
		return err
	})
	if err != nil {
		s.logger.Warn("plugin notification channel readiness failed; queueing anyway", "plugin", hosted.manifest.ID, "channel", channel)
		return true
	}
	return ready
}

// DeliverNotification runs a channel's hook. It returns nil,
// ErrChannelGone, plugin.ErrChannelUnavailable,
// plugin.ErrNotificationPermanent, or another error, which is temporary.
func (s *Service) DeliverNotification(ctx context.Context, target string, notification plugin.Notification) error {
	pluginID, channelID, ok := SplitChannelTarget(target)
	if !ok {
		return ErrChannelGone
	}
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return ErrChannelGone
	}
	provider, ok := hosted.plugin.(plugin.NotificationChannelProvider)
	if _, declared := hosted.manifest.NotificationChannelByID(channelID); !ok || !declared {
		return ErrChannelGone
	}
	installed, err := s.pluginInstalled(ctx, pluginID)
	if err != nil {
		return err
	}
	if !installed {
		return ErrChannelGone
	}
	notification.Channel = channelID
	return s.runProviderHook(ctx, pluginID, notificationTimeout, func(ctx context.Context) error {
		return provider.DeliverNotification(ctx, notification)
	})
}

// errProviderTimeout and errProviderPanic are the host's failures of a
// provider hook.
var (
	errProviderTimeout = errors.New("the provider hook did not finish in time")
	errProviderPanic   = errors.New("the provider hook panicked")
)

// runProviderHook runs a hook in the system context with a time limit. A
// panic or the end of the time limit is an error. The invocation ends when
// this returns, so a hook that outlives its limit can no longer call a
// service.
func (s *Service) runProviderHook(ctx context.Context, pluginID string, timeout time.Duration, call func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	invocation, done := s.systemInvocation(ctx, pluginID)
	defer done()
	result := make(chan error, 1)
	go func() {
		defer func() {
			if recover() != nil {
				result <- errProviderPanic
			}
		}()
		result <- call(invocation)
	}()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return errProviderTimeout
	}
}

// ContentCheck is one installed, declared check.
type ContentCheck struct {
	PluginID string
	Check    plugin.ContentCheckDeclaration
}

// ContentChecks lists the checks of installed plugins.
func (s *Service) ContentChecks(ctx context.Context) ([]ContentCheck, error) {
	installed, err := s.installedPluginIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := []ContentCheck{}
	for _, hosted := range s.hosted {
		if hosted.manifest.APIVersion < 3 || !installed[hosted.manifest.ID] {
			continue
		}
		if _, ok := hosted.plugin.(plugin.ContentChecker); !ok {
			continue
		}
		for _, check := range hosted.manifest.ContentChecks() {
			out = append(out, ContentCheck{PluginID: hosted.manifest.ID, Check: check})
		}
	}
	return out, nil
}

// Content check failure codes, the same as contenthealth's.
const (
	ContentCheckFailed        = "check_failed"
	ContentCheckTimeout       = "check_timeout"
	ContentCheckPanic         = "check_panic"
	ContentCheckInvalidResult = "invalid_result"
)

// ContentCheckError is a check that did not complete.
type ContentCheckError struct{ Code string }

func (e *ContentCheckError) Error() string { return "plugin content check failed: " + e.Code }

// RunContentCheck runs one check on one item and validates the result. The
// plugin receives only this item.
func (s *Service) RunContentCheck(ctx context.Context, pluginID, checkID string, item plugin.ContentItem) ([]plugin.Condition, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return nil, &ContentCheckError{Code: ContentCheckFailed}
	}
	checker, ok := hosted.plugin.(plugin.ContentChecker)
	declaration, declared := hosted.manifest.ContentCheckByID(checkID)
	if !ok || !declared || !declaration.Reads(item.Kind) {
		return nil, &ContentCheckError{Code: ContentCheckFailed}
	}
	item.Check = checkID
	var conditions []plugin.Condition
	err := s.runProviderHook(ctx, pluginID, contentCheckTimeout, func(ctx context.Context) error {
		var err error
		conditions, err = checker.CheckContent(ctx, item)
		return err
	})
	switch {
	case errors.Is(err, errProviderTimeout):
		return nil, &ContentCheckError{Code: ContentCheckTimeout}
	case errors.Is(err, errProviderPanic):
		return nil, &ContentCheckError{Code: ContentCheckPanic}
	case err != nil:
		return nil, &ContentCheckError{Code: ContentCheckFailed}
	}
	if err := plugin.ValidateConditions(conditions); err != nil {
		return nil, &ContentCheckError{Code: ContentCheckInvalidResult}
	}
	return conditions, nil
}

// ProviderStatus is the provider section of a plugin's Status page.
type ProviderStatus struct {
	Channels []ChannelStatus `json:"channels"`
	Checks   []CheckStatus   `json:"checks"`
}

// ChannelStatus is one notification channel.
type ChannelStatus struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Ready is false when the channel is intentionally off or not
	// configured; notifications skip it.
	Ready        bool       `json:"ready"`
	Sent         int        `json:"sent"`
	Pending      int        `json:"pending"`
	Failed       int        `json:"failed"`
	LastSentAt   *time.Time `json:"lastSentAt,omitempty"`
	LastFailedAt *time.Time `json:"lastFailedAt,omitempty"`
}

// CheckStatus is one Content Health check.
type CheckStatus struct {
	ID             string     `json:"id"`
	Title          string     `json:"title"`
	Kinds          []string   `json:"kinds"`
	CheckedItems   int        `json:"checkedItems"`
	FailingItems   int        `json:"failingItems"`
	OpenConditions int        `json:"openConditions"`
	LastFailure    string     `json:"lastFailure,omitempty"`
	LastFailedAt   *time.Time `json:"lastFailedAt,omitempty"`
}

func (s *Service) providerStatus(ctx context.Context, hosted hostedPlugin, installed bool) (ProviderStatus, error) {
	status := ProviderStatus{Channels: []ChannelStatus{}, Checks: []CheckStatus{}}
	pluginID := hosted.manifest.ID
	for _, channel := range hosted.manifest.NotificationChannels() {
		item := ChannelStatus{ID: channel.ID, Title: channel.Title}
		if installed {
			item.Ready = s.channelReady(ctx, hosted, channel.ID)
		}
		err := s.db.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='sent'), count(*) FILTER (WHERE status='pending'),
				count(*) FILTER (WHERE status='failed'), max(sent_at), max(CASE WHEN status='failed' THEN next_attempt_at END)
			FROM notification_deliveries WHERE channel='plugin' AND target=$1`, pluginID+":"+channel.ID).
			Scan(&item.Sent, &item.Pending, &item.Failed, &item.LastSentAt, &item.LastFailedAt)
		if err != nil {
			return status, err
		}
		status.Channels = append(status.Channels, item)
	}
	for _, check := range hosted.manifest.ContentChecks() {
		item := CheckStatus{ID: check.ID, Title: check.Title, Kinds: append([]string{}, check.Kinds...)}
		var failure *string
		err := s.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE failure IS NOT NULL),
				max(failed_at), (SELECT failure FROM plugin_content_check_state WHERE plugin_id=$1 AND check_id=$2 AND failed_at IS NOT NULL ORDER BY failed_at DESC LIMIT 1)
			FROM plugin_content_check_state WHERE plugin_id=$1 AND check_id=$2`, pluginID, check.ID).
			Scan(&item.CheckedItems, &item.FailingItems, &item.LastFailedAt, &failure)
		if err != nil {
			return status, err
		}
		if failure != nil {
			item.LastFailure = *failure
		}
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM incidents WHERE failure_code='plugin_check' AND status IN ('open','acknowledged')
			AND left(dedupe_key, length($1))=$1`, fmt.Sprintf("plugin_check:%s:%s:", pluginID, check.ID)).Scan(&item.OpenConditions); err != nil {
			return status, err
		}
		status.Checks = append(status.Checks, item)
	}
	return status, nil
}

// removeProviderState recovers the open Content Health conditions of a
// plugin and deletes its check state, in the removal transaction. Queued
// notifications to its channels are cancelled when they come due.
func (s *Service) removeProviderState(ctx context.Context, tx pgx.Tx, pluginID string) error {
	now := s.clock.Now().UTC()
	rows, err := tx.Query(ctx, `UPDATE incidents SET status='recovered',recovered_at=$2,recovery_mode='automatic',
			resolution_reason='The plugin that reported this condition was removed.',updated_at=now()
		WHERE failure_code='plugin_check' AND status IN ('open','acknowledged') AND metadata->>'pluginId'=$1
		RETURNING id`, pluginID, now)
	if err != nil {
		return err
	}
	recovered, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	if err := coreevents.EmitIncidents(ctx, tx, s, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic, now, recovered...); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM plugin_content_check_state WHERE plugin_id=$1`, pluginID)
	return err
}

// ProviderReview is what the install review shows about a plugin's
// provider slots.
type ProviderReview struct {
	Channels []ChannelReview `json:"channels"`
	Checks   []CheckReview   `json:"checks"`
}

// ChannelReview is one notification channel.
type ChannelReview struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

// CheckReview is one Content Health check and the item kinds it reads.
type CheckReview struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Kinds       []string `json:"kinds"`
}

func providerReview(m plugin.Manifest) ProviderReview {
	review := ProviderReview{Channels: []ChannelReview{}, Checks: []CheckReview{}}
	for _, channel := range m.NotificationChannels() {
		review.Channels = append(review.Channels, ChannelReview{ID: channel.ID, Title: channel.Title, Description: channel.Description})
	}
	for _, check := range m.ContentChecks() {
		review.Checks = append(review.Checks, CheckReview{ID: check.ID, Title: check.Title, Description: check.Description, Kinds: append([]string{}, check.Kinds...)})
	}
	return review
}

func (r ProviderReview) clone() ProviderReview {
	out := ProviderReview{Channels: append([]ChannelReview{}, r.Channels...), Checks: []CheckReview{}}
	for _, check := range r.Checks {
		check.Kinds = append([]string{}, check.Kinds...)
		out.Checks = append(out.Checks, check)
	}
	return out
}
