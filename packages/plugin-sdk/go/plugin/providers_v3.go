package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
	"unicode/utf8"
)

// Provider slots of Plugin Manifest API 3 (docs/plugin-providers.md). A
// provider slot is a typed interface of a core feature. Core owns the
// semantics; the plugin supplies one function. Phase 3 has two slots:
//
//   - notifications.channels: deliver a notification that notify already
//     decided to send.
//   - contenthealth.checks: check one content item that Content Health
//     passes in, and return named conditions.
//
// The manifest member is "providers", with "notifications.channels" and
// "contentHealth.checks".

// Slot identities, as the ADR names them.
const (
	SlotNotificationChannels = "notifications.channels"
	SlotContentHealthChecks  = "contenthealth.checks"
)

// Provider bounds.
const (
	// MaxNotificationChannels bounds the channels of one plugin. A channel
	// is one delivery path, such as one push service; two leaves room for a
	// second path of the same provider.
	MaxNotificationChannels = 2
	// MaxContentChecks bounds the checks of one plugin. Each check runs over
	// every changed item of its kinds on each sweep.
	MaxContentChecks = 4
	// MaxConditionsPerItem bounds what one check returns for one item.
	MaxConditionsPerItem = 16
	// MaxConditionReasonBytes bounds a condition's reason.
	MaxConditionReasonBytes = 280
)

// Content item kinds a check may read in phase 3.
const (
	ContentKindPlaylist       = "playlist"
	ContentKindLayout         = "layout"
	ContentKindWidgetInstance = "widget_instance"
	ContentKindMediaItem      = "media_item"
)

// ContentKinds is the closed vocabulary of item kinds.
var ContentKinds = []string{ContentKindPlaylist, ContentKindLayout, ContentKindWidgetInstance, ContentKindMediaItem}

var (
	providerIDPattern    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	conditionNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
)

// Providers declares the provider slots a plugin fills.
type Providers struct {
	Notifications *NotificationProviders  `json:"notifications,omitempty"`
	ContentHealth *ContentHealthProviders `json:"contentHealth,omitempty"`
}

// NotificationProviders fills notifications.channels.
type NotificationProviders struct {
	Channels []NotificationChannelDeclaration `json:"channels"`
}

// NotificationChannelDeclaration is one notification channel.
type NotificationChannelDeclaration struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

// ContentHealthProviders fills contenthealth.checks.
type ContentHealthProviders struct {
	Checks []ContentCheckDeclaration `json:"checks"`
}

// ContentCheckDeclaration is one Content Health check.
type ContentCheckDeclaration struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Kinds are the item kinds the check reads.
	Kinds []string `json:"kinds"`
}

// NotificationChannels returns the declared channels.
func (m Manifest) NotificationChannels() []NotificationChannelDeclaration {
	if m.APIVersion < 3 || m.Providers == nil || m.Providers.Notifications == nil {
		return nil
	}
	return m.Providers.Notifications.Channels
}

// ContentChecks returns the declared checks.
func (m Manifest) ContentChecks() []ContentCheckDeclaration {
	if m.APIVersion < 3 || m.Providers == nil || m.Providers.ContentHealth == nil {
		return nil
	}
	return m.Providers.ContentHealth.Checks
}

// ContentCheckByID returns a declared check.
func (m Manifest) ContentCheckByID(id string) (ContentCheckDeclaration, bool) {
	for _, check := range m.ContentChecks() {
		if check.ID == id {
			return check, true
		}
	}
	return ContentCheckDeclaration{}, false
}

// NotificationChannelByID returns a declared channel.
func (m Manifest) NotificationChannelByID(id string) (NotificationChannelDeclaration, bool) {
	for _, channel := range m.NotificationChannels() {
		if channel.ID == id {
			return channel, true
		}
	}
	return NotificationChannelDeclaration{}, false
}

// Reads reports whether a check reads an item kind.
func (c ContentCheckDeclaration) Reads(kind string) bool {
	for _, declared := range c.Kinds {
		if declared == kind {
			return true
		}
	}
	return false
}

func (m Manifest) validateProviders() error {
	if m.Providers == nil {
		return nil
	}
	if n := m.Providers.Notifications; n != nil {
		if len(n.Channels) == 0 || len(n.Channels) > MaxNotificationChannels {
			return fmt.Errorf("providers.notifications.channels declares %d channels; use 1 to %d", len(n.Channels), MaxNotificationChannels)
		}
		seen := map[string]bool{}
		for _, channel := range n.Channels {
			if err := validateProviderText("notification channel", channel.ID, channel.Title, channel.Description); err != nil {
				return err
			}
			if seen[channel.ID] {
				return fmt.Errorf("notification channel %q is declared twice", channel.ID)
			}
			seen[channel.ID] = true
		}
	}
	if c := m.Providers.ContentHealth; c != nil {
		if len(c.Checks) == 0 || len(c.Checks) > MaxContentChecks {
			return fmt.Errorf("providers.contentHealth.checks declares %d checks; use 1 to %d", len(c.Checks), MaxContentChecks)
		}
		seen := map[string]bool{}
		for _, check := range c.Checks {
			if err := validateProviderText("content check", check.ID, check.Title, check.Description); err != nil {
				return err
			}
			if seen[check.ID] {
				return fmt.Errorf("content check %q is declared twice", check.ID)
			}
			seen[check.ID] = true
			if len(check.Kinds) == 0 || len(check.Kinds) > len(ContentKinds) {
				return fmt.Errorf("content check %q needs 1 to %d item kinds", check.ID, len(ContentKinds))
			}
			kinds := map[string]bool{}
			for _, kind := range check.Kinds {
				known := false
				for _, candidate := range ContentKinds {
					known = known || candidate == kind
				}
				if !known {
					return fmt.Errorf("content check %q reads unknown item kind %q; kinds are playlist, layout, widget_instance, and media_item", check.ID, kind)
				}
				if kinds[kind] {
					return fmt.Errorf("content check %q names item kind %q twice", check.ID, kind)
				}
				kinds[kind] = true
			}
		}
	}
	return nil
}

func validateProviderText(what, id, title, description string) error {
	if !providerIDPattern.MatchString(id) {
		return fmt.Errorf("invalid %s id %q; use 1 to 40 lowercase letters, digits, and underscores", what, id)
	}
	if err := bounded(what+" title", title, 80); err != nil {
		return err
	}
	if len(description) > 280 {
		return fmt.Errorf("%s %q description is longer than 280 bytes", what, id)
	}
	return nil
}

// Notification is a message notify already decided to send, rendered by
// the host. A channel delivers it; it never chooses recipients, volume,
// category, severity policy, quiet hours, or digests.
type Notification struct {
	// Channel is the declared channel ID.
	Channel string `json:"channel"`
	// EventKey identifies the transition, such as incident:<id>:opened. It
	// is the same on every attempt, so a provider that deduplicates can use
	// it.
	EventKey   string    `json:"eventKey"`
	Category   string    `json:"category"`
	Severity   string    `json:"severity"`
	Subject    string    `json:"subject"`
	Body       string    `json:"body"`
	OccurredAt time.Time `json:"occurredAt"`
	// StudioURL is the Studio page that shows the condition, when the
	// installation has a public address.
	StudioURL string `json:"studioUrl,omitempty"`
}

// Typed delivery outcomes. Core decides retries from these values, never
// from an error text.
var (
	// ErrChannelUnavailable: the channel is intentionally off or not
	// configured. The host cancels the delivery and does not retry it.
	ErrChannelUnavailable = errors.New("the notification channel is not available")
	// ErrNotificationPermanent: the provider refused the message for good,
	// for example a rejected credential or topic. The host stops retrying.
	ErrNotificationPermanent = errors.New("the notification provider refused the message")
)

// PermanentNotificationError wraps err so that errors.Is reports
// ErrNotificationPermanent.
func PermanentNotificationError(err error) error {
	return fmt.Errorf("%w: %w", ErrNotificationPermanent, err)
}

// NotificationChannelProvider is implemented by a bundled plugin that
// declares notification channels. The host calls DeliverNotification in the
// system context. nil is a sent notification; ErrChannelUnavailable cancels
// it; ErrNotificationPermanent fails it; any other error retries it on the
// notification outbox's backoff.
type NotificationChannelProvider interface {
	DeliverNotification(ctx context.Context, notification Notification) error
}

// NotificationChannelStatus is optional. The host asks it before it queues a
// notification for a channel, so an intentionally disabled or unconfigured
// channel gets no delivery row. Without it, a declared channel is ready.
type NotificationChannelStatus interface {
	NotificationChannelReady(ctx context.Context, channel string) (bool, error)
}

// ContentItemModelVersion is the version of the ContentItem model. A
// change to the model is a new version.
const ContentItemModelVersion = 1

// ContentItem is one read-only content item, built by the host from its
// public API model. It is never a database row, and it carries no
// credentials, no users, and no usage of other content.
type ContentItem struct {
	// Check is the declared check this call runs.
	Check        string `json:"check"`
	Kind         string `json:"kind"`
	ID           string `json:"id"`
	ModelVersion int    `json:"modelVersion"`
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	// Exactly one of these matches Kind.
	Playlist *ContentPlaylist `json:"playlist,omitempty"`
	Layout   *ContentLayout   `json:"layout,omitempty"`
	Widget   *ContentWidget   `json:"widget,omitempty"`
	Media    *ContentMedia    `json:"media,omitempty"`
}

// ContentPlaylist is a playlist and its items in play order.
type ContentPlaylist struct {
	SourceType string                `json:"sourceType"`
	Items      []ContentPlaylistItem `json:"items"`
}

// ContentPlaylistItem is one playlist item.
type ContentPlaylistItem struct {
	ID             string     `json:"id"`
	AssetID        string     `json:"assetId"`
	LayoutID       string     `json:"layoutId,omitempty"`
	AssetName      string     `json:"assetName"`
	AssetType      string     `json:"assetType"`
	AssetStatus    string     `json:"assetStatus"`
	WidgetProvider string     `json:"widgetProvider,omitempty"`
	DurationMS     *int64     `json:"durationMs,omitempty"`
	FitMode        string     `json:"fitMode"`
	AvailableFrom  *time.Time `json:"availableFrom,omitempty"`
	ExpiresAt      *time.Time `json:"expiresAt,omitempty"`
}

// ContentLayout is a Layout's working document.
type ContentLayout struct {
	Orientation  string          `json:"orientation"`
	CanvasWidth  int             `json:"canvasWidth"`
	CanvasHeight int             `json:"canvasHeight"`
	Document     json.RawMessage `json:"document"`
}

// ContentWidget is a Widget instance: its provider and configuration.
type ContentWidget struct {
	Provider      string          `json:"provider"`
	ConfigVersion int             `json:"configVersion"`
	Configuration json.RawMessage `json:"configuration"`
}

// ContentMedia is a media item's playable properties.
type ContentMedia struct {
	Type             string     `json:"type"`
	MIMEType         string     `json:"mimeType"`
	Width            *int       `json:"width,omitempty"`
	Height           *int       `json:"height,omitempty"`
	DurationSeconds  *float64   `json:"durationSeconds,omitempty"`
	ProcessingStatus string     `json:"processingStatus"`
	AvailableFrom    *time.Time `json:"availableFrom,omitempty"`
	ExpiresAt        *time.Time `json:"expiresAt,omitempty"`
}

// Condition severities.
const (
	SeverityInfo     = "info"
	SeverityWarning  = "warning"
	SeverityError    = "error"
	SeverityCritical = "critical"
)

// Condition is one named problem a check found in an item. Core owns the
// incident: its ID, opening, deduplication, recovery, Activity, and
// notifications.
type Condition struct {
	// Name is stable for one kind of problem, such as low_contrast.
	Name     string `json:"name"`
	Severity string `json:"severity"`
	// Reason is a short sentence for an operator.
	Reason string `json:"reason"`
}

// ValidateConditions checks one result of a check.
func ValidateConditions(conditions []Condition) error {
	if len(conditions) > MaxConditionsPerItem {
		return fmt.Errorf("a check returns at most %d conditions for one item", MaxConditionsPerItem)
	}
	seen := map[string]bool{}
	for _, condition := range conditions {
		if !conditionNamePattern.MatchString(condition.Name) {
			return fmt.Errorf("invalid condition name %q", condition.Name)
		}
		if seen[condition.Name] {
			return fmt.Errorf("condition %q is returned twice", condition.Name)
		}
		seen[condition.Name] = true
		switch condition.Severity {
		case SeverityInfo, SeverityWarning, SeverityError, SeverityCritical:
		default:
			return fmt.Errorf("condition %q has unknown severity %q", condition.Name, condition.Severity)
		}
		if condition.Reason == "" || len(condition.Reason) > MaxConditionReasonBytes || !utf8.ValidString(condition.Reason) {
			return fmt.Errorf("condition %q needs a reason of 1 to %d bytes", condition.Name, MaxConditionReasonBytes)
		}
	}
	return nil
}

// ContentChecker is implemented by a bundled plugin that declares Content
// Health checks. The host calls CheckContent in the system context with one
// changed item of a declared kind. The check gets no other read access to
// content. An error keeps the item's earlier conditions and retries on a
// later sweep; it never recovers a condition.
type ContentChecker interface {
	CheckContent(ctx context.Context, item ContentItem) ([]Condition, error)
}
