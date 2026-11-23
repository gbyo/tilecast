package plugin

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
)

// Feeds of a Plugin Manifest API 3 plugin (docs/plugin-feeds.md). A feed is
// a dataset that the plugin publishes with feeds.publish@1. The host stores
// it, applies operator overrides, imports remote images, and projects it as
// an ordinary Data Source with the provider identity
// "<plugin id>.<feed id>". The fields use the configuration schema: a
// publication is validated like a settings document, one record at a time.

// Feed bounds. 16 fields and 2,000 records are the bounds of one Player Data
// Document dataset, and an 80-character record ID is the Player's record ID
// bound.
const (
	MaxFeeds                = 8
	MaxFeedFields           = 16
	MaxFeedRecords          = 2000
	MaxFeedRecordIDLength   = 80
	MaxFeedPublicationBytes = 512 << 10
	MinFeedRefreshSeconds   = 60
	MaxFeedRefreshSeconds   = 7 * 24 * 60 * 60
	// MaxFeedValueLength bounds one text value, the Player's bound for one
	// projected value.
	MaxFeedValueLength = 4096
)

// Feed dataset scopes.
const (
	FeedDatasetOrganization = "organization"
	FeedDatasetInstance     = "instance"
)

// Field override policies.
const (
	// OverrideUpstream: the publication always wins; no operator edit.
	OverrideUpstream = "upstream"
	// OverrideLocal: an operator edit always wins.
	OverrideLocal = "local"
	// OverrideLocalUntilChanged: an operator edit wins until a publication
	// changes the field's upstream value.
	OverrideLocalUntilChanged = "local_until_changed"
)

// feedControls are the configuration controls a feed field may use, with
// the Data Document type each one projects to.
var feedControls = map[string]string{
	"text": "text", "multiline_text": "text", "select": "text", "number": "number",
	"integer": "integer", "boolean": "boolean", "date": "date", "datetime": "datetime", "url": "url",
}

var feedIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// FeedProviderIDPattern is the Data Source provider identity of a feed:
// "<plugin id>.<feed id>", at most 80 characters.
var FeedProviderIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}\.[a-z][a-z0-9_]{0,39}$`)

// ValidFeedProviderID reports whether id is a feed provider identity of at
// most 80 characters, the stored Data Source provider bound.
func ValidFeedProviderID(id string) bool {
	return len(id) <= 80 && FeedProviderIDPattern.MatchString(id)
}

// Feed is one feed declaration.
type Feed struct {
	ID          string `json:"id"`
	Version     int    `json:"version"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Dataset is "organization" (one dataset) or "instance" (one dataset for
	// each instance of InstanceKind).
	Dataset      string `json:"dataset"`
	InstanceKind string `json:"instanceKind,omitempty"`
	// ExpectedRefreshSeconds is how often the plugin publishes. A dataset
	// with no publication for twice this time is stale in Content Health.
	ExpectedRefreshSeconds int         `json:"expectedRefreshSeconds"`
	Fields                 []FeedField `json:"fields"`
}

// FeedField is one record field: a configuration schema field with an
// override policy and, for a remote image, the connection that fetches it.
type FeedField struct {
	configschema.Field
	// Override is upstream (default), local, or local_until_changed.
	Override string `json:"override,omitempty"`
	// Image makes a url field a remote image: the host fetches the URL
	// through the named connection declaration and projects a private
	// plugin asset.
	Image *FeedImage `json:"image,omitempty"`
}

// FeedImage names the connection declaration a remote image comes through.
type FeedImage struct {
	Connection string `json:"connection"`
}

// OverridePolicy returns the field's policy with the default applied.
func (f FeedField) OverridePolicy() string {
	if f.Override == "" {
		return OverrideUpstream
	}
	return f.Override
}

// DocumentType is the Player Data Document type of the field.
func (f FeedField) DocumentType() string {
	if f.Image != nil {
		return "asset"
	}
	return feedControls[f.Control]
}

// Ref is "<feed id>@<version>".
func (f Feed) Ref() string { return fmt.Sprintf("%s@%d", f.ID, f.Version) }

// ProviderID is the Data Source provider identity of the feed.
func (f Feed) ProviderID(pluginID string) string { return pluginID + "." + f.ID }

// ExpectedRefresh is the declared refresh interval.
func (f Feed) ExpectedRefresh() time.Duration {
	return time.Duration(f.ExpectedRefreshSeconds) * time.Second
}

// ConfigFields returns the fields as configuration schema fields, to
// normalize one record like a document.
func (f Feed) ConfigFields() []configschema.Field {
	out := make([]configschema.Field, 0, len(f.Fields))
	for _, field := range f.Fields {
		out = append(out, field.Field)
	}
	return out
}

// FeedByID returns a declared feed.
func (m Manifest) FeedByID(id string) (Feed, bool) {
	for _, feed := range m.Feeds {
		if feed.ID == id {
			return feed, true
		}
	}
	return Feed{}, false
}

func (m Manifest) validateFeeds() error {
	if len(m.Feeds) == 0 {
		return nil
	}
	if len(m.Feeds) > MaxFeeds {
		return fmt.Errorf("feeds declares %d feeds; the limit is %d", len(m.Feeds), MaxFeeds)
	}
	connections := map[string]bool{}
	for _, connection := range m.Connections {
		connections[connection.ID] = true
	}
	kinds := map[string]bool{}
	for _, kind := range m.Instances {
		kinds[kind.Kind] = true
	}
	seen := map[string]bool{}
	for _, feed := range m.Feeds {
		where := fmt.Sprintf("feed %q", feed.ID)
		switch {
		case !feedIDPattern.MatchString(feed.ID):
			return fmt.Errorf("feed id %q must match %s", feed.ID, feedIDPattern)
		case seen[feed.ID]:
			return fmt.Errorf("feed %q is declared twice", feed.ID)
		case !ValidFeedProviderID(feed.ProviderID(m.ID)):
			return fmt.Errorf("%s has a Data Source provider identity %q longer than 80 characters", where, feed.ProviderID(m.ID))
		case feed.Version < 1:
			return fmt.Errorf("%s needs a version of 1 or more; a schema change is a new version", where)
		case feed.Title == "" || len(feed.Title) > 80 || len(feed.Description) > 280:
			return fmt.Errorf("%s needs a title of 1 to 80 characters and a description of at most 280", where)
		case feed.ExpectedRefreshSeconds < MinFeedRefreshSeconds || feed.ExpectedRefreshSeconds > MaxFeedRefreshSeconds:
			return fmt.Errorf("%s needs expectedRefreshSeconds from %d to %d", where, MinFeedRefreshSeconds, MaxFeedRefreshSeconds)
		case len(feed.Fields) < 1 || len(feed.Fields) > MaxFeedFields:
			return fmt.Errorf("%s needs 1 to %d fields; %d is the limit of a Player dataset", where, MaxFeedFields, MaxFeedFields)
		}
		seen[feed.ID] = true
		switch feed.Dataset {
		case FeedDatasetOrganization:
			if feed.InstanceKind != "" {
				return fmt.Errorf("%s has an organization dataset and names an instance kind", where)
			}
		case FeedDatasetInstance:
			if !kinds[feed.InstanceKind] {
				return fmt.Errorf("%s has an instance dataset but names no declared instance kind", where)
			}
		default:
			return fmt.Errorf("%s dataset must be %q or %q", where, FeedDatasetOrganization, FeedDatasetInstance)
		}
		for _, field := range feed.Fields {
			if _, ok := feedControls[field.Control]; !ok {
				return fmt.Errorf("%s field %q uses control %q; a feed field is text, multiline_text, select, number, integer, boolean, date, datetime, or url", where, field.Key, field.Control)
			}
			switch field.OverridePolicy() {
			case OverrideUpstream, OverrideLocal, OverrideLocalUntilChanged:
			default:
				return fmt.Errorf("%s field %q override must be upstream, local, or local_until_changed", where, field.Key)
			}
			if field.Default != nil {
				return fmt.Errorf("%s field %q has a default; a publication supplies every value", where, field.Key)
			}
			if field.Image != nil {
				switch {
				case field.Control != "url":
					return fmt.Errorf("%s field %q is an image and must use the url control", where, field.Key)
				case !connections[field.Image.Connection]:
					return fmt.Errorf("%s field %q imports images through connection %q, which the manifest does not declare", where, field.Key, field.Image.Connection)
				case field.OverridePolicy() != OverrideUpstream:
					return fmt.Errorf("%s field %q is an image; images are always upstream", where, field.Key)
				case field.Personal != nil:
					return fmt.Errorf("%s field %q is an image and cannot be personal", where, field.Key)
				}
			}
			if (field.Control == "text" || field.Control == "multiline_text") && (field.MaxLength == 0 || field.MaxLength > MaxFeedValueLength) {
				return fmt.Errorf("%s field %q needs a maxLength of at most %d", where, field.Key, MaxFeedValueLength)
			}
		}
		if err := configschema.ValidateFields(feed.ConfigFields(), configschema.ProfilePlugin); err != nil {
			return fmt.Errorf("%s: %w", where, err)
		}
	}
	return nil
}

// FeedRecord is one published record. Values hold JSON values of the
// feed's fields: strings, numbers, booleans, or null.
type FeedRecord struct {
	ID     string         `json:"id"`
	Values map[string]any `json:"values"`
}

// FeedPublication replaces the records of one dataset.
type FeedPublication struct {
	Feed string `json:"feed"`
	// Instance is the instance of a per-instance feed; empty otherwise.
	Instance uuid.UUID `json:"instance,omitempty"`
	// Replaces is the revision this publication replaces: 0 for the first.
	Replaces int64        `json:"replaces"`
	Records  []FeedRecord `json:"records"`
	// ValidUntil, when set, makes Players treat the data as expired after
	// this time.
	ValidUntil *time.Time `json:"validUntil,omitempty"`
	// Connections are the connection records remote images come through,
	// by connection declaration ID.
	Connections map[string]uuid.UUID `json:"connections,omitempty"`
}

// FeedPublished is the answer of a publication.
type FeedPublished struct {
	Dataset      uuid.UUID `json:"dataset"`
	Revision     int64     `json:"revision"`
	Records      int       `json:"records"`
	ImagesQueued int       `json:"imagesQueued"`
}

// FeedRevisionConflict is the failure code of a publication that names a
// revision other than the current one.
const FeedRevisionConflict = "revision_conflict"

// ErrFeedConflict answers a publication that lost a race with another one.
// Read the revision again and publish again.
var ErrFeedConflict = errors.New("plugin: the feed dataset changed since its revision was read")

// PublishFeed replaces the records of one dataset through feeds.publish@1.
func (s *Services) PublishFeed(ctx context.Context, publication FeedPublication) (FeedPublished, error) {
	if publication.Records == nil {
		publication.Records = []FeedRecord{}
	}
	var out FeedPublished
	err := s.Call(ctx, "feeds.publish@1/publish", publication, &out)
	var failure *ServiceError
	if errors.As(err, &failure) && failure.Code == FeedRevisionConflict {
		return FeedPublished{}, ErrFeedConflict
	}
	return out, err
}

// FeedRevision reads the revision the next publication of a dataset
// replaces: 0 before the first.
func (s *Services) FeedRevision(ctx context.Context, feed string, instance uuid.UUID) (int64, error) {
	var out struct {
		Revision int64 `json:"revision"`
	}
	err := s.Call(ctx, "feeds.publish@1/revision", map[string]any{"feed": feed, "instance": instance}, &out)
	return out.Revision, err
}
