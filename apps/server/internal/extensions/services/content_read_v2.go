package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

// content.read@2 is the shared read contract of the content library. Its
// answers are the models in this file: explicit projections of the
// canonical domain records that the service owns, never a domain struct or
// a database row. A field added to a domain record does not reach plugins
// until it is added here; TestContentReadV2ModelShapes pins every member.
//
// Studio calls take the capability and the object rule of the equivalent
// dashboard route. Unattended calls read the installation-wide view under
// the content.read@2 grant. Storage details stay out: Widgets are their own
// resource even though Media stores them, private plugin attachments are
// never Media, and no answer carries a path, a URL, a credential, a cached
// payload, or processing internals.

// maxReadSearch bounds a search string.
const maxReadSearch = 200

// Relationship lists in a get answer hold at most these many entries; the
// answer says whether the list is complete.
const (
	maxPlaylistItems     = 100
	maxLayoutReferences  = 200
	maxScheduleTargets   = 250
	maxGroupScreens      = 500
	maxDataSourceFields  = 200
	maxWidgetConfigBytes = 32 << 10
)

type contentRef struct {
	Type string    `json:"type"`
	ID   uuid.UUID `json:"id"`
}

type contentPlaylist struct {
	ID                    uuid.UUID `json:"id"`
	Name                  string    `json:"name"`
	Description           string    `json:"description"`
	SourceType            string    `json:"sourceType"`
	PublishedRevision     int64     `json:"publishedRevision"`
	DraftRevision         int64     `json:"draftRevision"`
	HasUnpublishedChanges bool      `json:"hasUnpublishedChanges"`
	ItemCount             int       `json:"itemCount"`
	CreatedAt             time.Time `json:"createdAt"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

type contentPlaylistItem struct {
	ID          uuid.UUID `json:"id"`
	Position    int       `json:"position"`
	ContentType string    `json:"contentType"`
	ContentID   uuid.UUID `json:"contentId"`
	DurationMS  *int64    `json:"durationMs,omitempty"`
}

type contentTagRule struct {
	Match  string      `json:"match"`
	TagIDs []uuid.UUID `json:"tagIds"`
}

type contentPlaylistDetail struct {
	contentPlaylist
	Items         []contentPlaylistItem `json:"items"`
	ItemsComplete bool                  `json:"itemsComplete"`
	DataSourceIDs []uuid.UUID           `json:"dataSourceIds"`
	TagRule       *contentTagRule       `json:"tagRule,omitempty"`
}

type contentLayout struct {
	ID                    uuid.UUID  `json:"id"`
	Name                  string     `json:"name"`
	Description           string     `json:"description"`
	Orientation           string     `json:"orientation"`
	CanvasWidth           int        `json:"canvasWidth"`
	CanvasHeight          int        `json:"canvasHeight"`
	DraftRevision         int64      `json:"draftRevision"`
	PublishedRevision     *int64     `json:"publishedRevision,omitempty"`
	PublishedAt           *time.Time `json:"publishedAt,omitempty"`
	HasUnpublishedChanges bool       `json:"hasUnpublishedChanges"`
	CreatedAt             time.Time  `json:"createdAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
}

type contentLayoutDetail struct {
	contentLayout
	PlacementCount       int          `json:"placementCount"`
	Dependencies         []contentRef `json:"dependencies"`
	DependenciesComplete bool         `json:"dependenciesComplete"`
}

type contentWidget struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	Provider      string     `json:"provider"`
	ConfigVersion int        `json:"configVersion"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	AvailableFrom *time.Time `json:"availableFrom,omitempty"`
	ExpiresAt     *time.Time `json:"expiresAt,omitempty"`
}

type contentWidgetDetail struct {
	contentWidget
	FolderID *uuid.UUID `json:"folderId,omitempty"`
	// Configuration is the authored Widget configuration with every
	// secret-like member removed. It is omitted, and ConfigurationOmitted
	// set, when it exceeds maxWidgetConfigBytes.
	Configuration        json.RawMessage `json:"configuration,omitempty"`
	ConfigurationOmitted bool            `json:"configurationOmitted,omitempty"`
}

type contentMedia struct {
	ID               uuid.UUID  `json:"id"`
	Name             string     `json:"name"`
	Description      string     `json:"description"`
	Type             string     `json:"type"`
	MIMEType         string     `json:"mimeType"`
	SizeBytes        int64      `json:"sizeBytes"`
	Width            *int       `json:"width,omitempty"`
	Height           *int       `json:"height,omitempty"`
	DurationSeconds  *float64   `json:"durationSeconds,omitempty"`
	ProcessingStatus string     `json:"processingStatus"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
	AvailableFrom    *time.Time `json:"availableFrom,omitempty"`
	ExpiresAt        *time.Time `json:"expiresAt,omitempty"`
}

type contentMediaDetail struct {
	contentMedia
	FolderID *uuid.UUID  `json:"folderId,omitempty"`
	TagIDs   []uuid.UUID `json:"tagIds"`
}

type contentDataSource struct {
	ID                uuid.UUID `json:"id"`
	Name              string    `json:"name"`
	Description       string    `json:"description"`
	Provider          string    `json:"provider"`
	ConfigVersion     int       `json:"configVersion"`
	Status            string    `json:"status"`
	CachedRecordCount int       `json:"cachedRecordCount"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type contentDataSourceField struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

type contentDataSourceDetail struct {
	contentDataSource
	Fields                  []contentDataSourceField `json:"fields"`
	FieldsComplete          bool                     `json:"fieldsComplete"`
	UsingCachedData         bool                     `json:"usingCachedData"`
	LastSuccessfulRefreshAt *time.Time               `json:"lastSuccessfulRefreshAt,omitempty"`
	LastAttemptedRefreshAt  *time.Time               `json:"lastAttemptedRefreshAt,omitempty"`
	CacheUpdatedAt          *time.Time               `json:"cacheUpdatedAt,omitempty"`
	CacheExpiresAt          *time.Time               `json:"cacheExpiresAt,omitempty"`
}

type contentSchedule struct {
	ID               uuid.UUID  `json:"id"`
	Name             string     `json:"name"`
	Description      string     `json:"description"`
	Type             string     `json:"type"`
	Enabled          bool       `json:"enabled"`
	Priority         int        `json:"priority"`
	Timezone         string     `json:"timezone"`
	PresentationType string     `json:"presentationType"`
	PlaylistID       *uuid.UUID `json:"playlistId,omitempty"`
	LayoutID         *uuid.UUID `json:"layoutId,omitempty"`
	StartDate        *string    `json:"startDate,omitempty"`
	EndDate          *string    `json:"endDate,omitempty"`
	OneTimeStart     *time.Time `json:"oneTimeStart,omitempty"`
	OneTimeEnd       *time.Time `json:"oneTimeEnd,omitempty"`
	DailyStart       *string    `json:"dailyStart,omitempty"`
	DailyEnd         *string    `json:"dailyEnd,omitempty"`
	DaysOfWeek       []int      `json:"daysOfWeek"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}

type contentScheduleDetail struct {
	contentSchedule
	Targets         []contentRef `json:"targets"`
	TargetsComplete bool         `json:"targetsComplete"`
}

type contentGroup struct {
	ID               uuid.UUID  `json:"id"`
	Name             string     `json:"name"`
	Description      string     `json:"description"`
	DisplayMode      string     `json:"displayMode"`
	PresentationType *string    `json:"presentationType,omitempty"`
	PlaylistID       *uuid.UUID `json:"playlistId,omitempty"`
	LayoutID         *uuid.UUID `json:"layoutId,omitempty"`
	ScreenCount      int        `json:"screenCount"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}

type contentGroupDetail struct {
	contentGroup
	ScreenIDs       []uuid.UUID `json:"screenIds"`
	ScreensComplete bool        `json:"screensComplete"`
}

// contentPage is the answer of every content.read@2 list.
type contentPage[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// Projections.

func projectPlaylist(p playlists.Playlist) contentPlaylist {
	return contentPlaylist{
		ID: p.ID, Name: p.Name, Description: p.Description, SourceType: p.SourceType,
		PublishedRevision: p.Revision, DraftRevision: p.DraftRevision, HasUnpublishedChanges: p.HasUnpublishedChanges,
		ItemCount: p.ItemCount, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
}

func projectPlaylistDetail(p playlists.Playlist) contentPlaylistDetail {
	detail := contentPlaylistDetail{contentPlaylist: projectPlaylist(p), Items: []contentPlaylistItem{}, ItemsComplete: true, DataSourceIDs: []uuid.UUID{}}
	if detail.ItemCount < len(p.Items) {
		detail.ItemCount = len(p.Items)
	}
	for _, item := range p.Items {
		if len(detail.Items) == maxPlaylistItems {
			detail.ItemsComplete = false
			break
		}
		projected := contentPlaylistItem{ID: item.ID, Position: item.Position, ContentType: item.AssetType, ContentID: item.AssetID, DurationMS: item.DurationMS}
		if item.LayoutID != nil {
			projected.ContentType, projected.ContentID = "layout", *item.LayoutID
		}
		detail.Items = append(detail.Items, projected)
	}
	if p.DataSourceIDs != nil {
		detail.DataSourceIDs = append(detail.DataSourceIDs, p.DataSourceIDs...)
	}
	if p.TagRule != nil {
		rule := &contentTagRule{Match: p.TagRule.Match, TagIDs: make([]uuid.UUID, 0, len(p.TagRule.Tags))}
		for _, tag := range p.TagRule.Tags {
			rule.TagIDs = append(rule.TagIDs, tag.ID)
		}
		detail.TagRule = rule
	}
	return detail
}

func projectLayout(l layouts.Summary) contentLayout {
	return contentLayout{
		ID: l.ID, Name: l.Name, Description: l.Description, Orientation: l.Orientation,
		CanvasWidth: l.CanvasWidth, CanvasHeight: l.CanvasHeight, DraftRevision: l.DraftRevision,
		PublishedRevision: l.PublishedRevision, PublishedAt: l.PublishedAt, HasUnpublishedChanges: l.HasUnpublishedChanges,
		CreatedAt: l.CreatedAt, UpdatedAt: l.UpdatedAt,
	}
}

func projectLayoutDetail(l layouts.Layout) contentLayoutDetail {
	detail := contentLayoutDetail{
		contentLayout: projectLayout(layouts.Summary{
			ID: l.ID, Name: l.Name, Description: l.Description, Orientation: l.Orientation,
			CanvasWidth: l.CanvasWidth, CanvasHeight: l.CanvasHeight, DraftRevision: l.DraftRevision,
			PublishedRevision: l.PublishedRevision, PublishedAt: l.PublishedAt, HasUnpublishedChanges: l.HasUnpublishedChanges,
			CreatedAt: l.CreatedAt, UpdatedAt: l.UpdatedAt,
		}),
		PlacementCount: len(l.Draft.Placements), Dependencies: []contentRef{}, DependenciesComplete: true,
	}
	for _, dependency := range l.Dependencies {
		if len(detail.Dependencies) == maxLayoutReferences {
			detail.DependenciesComplete = false
			break
		}
		detail.Dependencies = append(detail.Dependencies, contentRef{Type: dependency.Type, ID: dependency.ID})
	}
	return detail
}

func projectWidget(a media.Asset) contentWidget {
	widget := contentWidget{
		ID: a.ID, Name: a.Name, Description: a.Description,
		CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt, AvailableFrom: a.AvailableFrom, ExpiresAt: a.ExpiresAt,
	}
	if a.Widget != nil {
		widget.Provider, widget.ConfigVersion = a.Widget.Provider, a.Widget.ConfigVersion
	}
	return widget
}

func projectWidgetDetail(a media.Asset) contentWidgetDetail {
	detail := contentWidgetDetail{contentWidget: projectWidget(a), FolderID: a.FolderID}
	if a.Widget != nil && len(a.Widget.Configuration) > 0 {
		clean := safeConfiguration(a.Widget.Configuration)
		if len(clean) > maxWidgetConfigBytes {
			detail.ConfigurationOmitted = true
		} else {
			detail.Configuration = clean
		}
	}
	return detail
}

// secretFragments name configuration members that never leave the
// service, at any depth, whatever a provider stores in them.
var secretFragments = []string{
	"password", "passphrase", "token", "secret", "credential", "authorization",
	"cookie", "apikey", "api_key", "accesskey", "access_key", "privatekey", "private_key", "signature",
}

func secretKey(key string) bool {
	lower := strings.ToLower(key)
	for _, fragment := range secretFragments {
		if strings.Contains(lower, fragment) {
			return true
		}
	}
	return false
}

// safeConfiguration removes secret-like members from an authored
// configuration document. A document that is not JSON answers null.
func safeConfiguration(raw json.RawMessage) json.RawMessage {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return json.RawMessage("null")
	}
	encoded, err := json.Marshal(stripSecrets(value))
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

func stripSecrets(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if secretKey(key) {
				continue
			}
			out[key] = stripSecrets(item)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, stripSecrets(item))
		}
		return out
	default:
		return value
	}
}

func projectMedia(a media.Asset) contentMedia {
	mime := a.DetectedMIMEType
	if mime == "" {
		mime = a.DeclaredMIMEType
	}
	return contentMedia{
		ID: a.ID, Name: a.Name, Description: a.Description, Type: a.Type, MIMEType: mime, SizeBytes: a.OriginalSize,
		Width: a.Width, Height: a.Height, DurationSeconds: a.Duration, ProcessingStatus: string(a.ProcessingStatus),
		CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt, AvailableFrom: a.AvailableFrom, ExpiresAt: a.ExpiresAt,
	}
}

func projectMediaDetail(a media.Asset) contentMediaDetail {
	detail := contentMediaDetail{contentMedia: projectMedia(a), FolderID: a.FolderID, TagIDs: make([]uuid.UUID, 0, len(a.Tags))}
	for _, tag := range a.Tags {
		detail.TagIDs = append(detail.TagIDs, tag.ID)
	}
	return detail
}

func projectDataSource(source media.DataSource, status string, cached int) contentDataSource {
	return contentDataSource{
		ID: source.ID, Name: source.Name, Description: source.Description, Provider: source.Provider,
		ConfigVersion: source.ConfigVersion, Status: status, CachedRecordCount: cached,
		CreatedAt: source.CreatedAt, UpdatedAt: source.UpdatedAt,
	}
}

func projectDataSourceDetail(detail media.DataSourceDetail) contentDataSourceDetail {
	out := contentDataSourceDetail{
		contentDataSource: projectDataSource(detail.DataSource, detail.Status, detail.CachedRecords),
		Fields:            []contentDataSourceField{}, FieldsComplete: true,
		UsingCachedData:         detail.Diagnostics.UsingCachedData,
		LastSuccessfulRefreshAt: detail.Diagnostics.LastSuccessfulAt,
		LastAttemptedRefreshAt:  detail.Diagnostics.LastAttemptedAt,
		CacheUpdatedAt:          detail.Diagnostics.CacheUpdatedAt,
		CacheExpiresAt:          detail.Diagnostics.CacheExpiresAt,
	}
	for _, field := range detail.Fields {
		if len(out.Fields) == maxDataSourceFields {
			out.FieldsComplete = false
			break
		}
		out.Fields = append(out.Fields, contentDataSourceField{Key: field.Key, Label: field.Label, Type: field.Type})
	}
	return out
}

func projectSchedule(r scheduling.Record) contentSchedule {
	schedule := contentSchedule{
		ID: r.ID, Name: r.Name, Description: r.Description, Type: string(r.Type), Enabled: r.Enabled,
		Priority: r.Priority, Timezone: r.Timezone, PresentationType: r.PresentationType, LayoutID: r.LayoutID,
		StartDate: r.StartDate, EndDate: r.EndDate, OneTimeStart: r.OneTimeStart, OneTimeEnd: r.OneTimeEnd,
		DailyStart: r.DailyStart, DailyEnd: r.DailyEnd, DaysOfWeek: append([]int{}, r.DaysOfWeek...),
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
	if r.PlaylistID != uuid.Nil {
		id := r.PlaylistID
		schedule.PlaylistID = &id
	}
	return schedule
}

func projectScheduleDetail(r scheduling.Record) contentScheduleDetail {
	detail := contentScheduleDetail{contentSchedule: projectSchedule(r), Targets: []contentRef{}, TargetsComplete: true}
	for _, target := range r.Targets {
		if len(detail.Targets) == maxScheduleTargets {
			detail.TargetsComplete = false
			break
		}
		detail.Targets = append(detail.Targets, contentRef{Type: target.Type, ID: target.ID})
	}
	return detail
}

func projectGroup(g scheduling.Group) contentGroup {
	return contentGroup{
		ID: g.ID, Name: g.Name, Description: g.Description, DisplayMode: g.DisplayMode,
		PresentationType: g.PresentationType, PlaylistID: g.PlaylistID, LayoutID: g.LayoutID,
		ScreenCount: g.MembershipCount, CreatedAt: g.CreatedAt, UpdatedAt: g.UpdatedAt,
	}
}

func projectGroupDetail(g scheduling.Group) contentGroupDetail {
	detail := contentGroupDetail{contentGroup: projectGroup(g), ScreenIDs: []uuid.UUID{}, ScreensComplete: true}
	if detail.ScreenCount < len(g.Screens) {
		detail.ScreenCount = len(g.Screens)
	}
	for _, screen := range g.Screens {
		if len(detail.ScreenIDs) == maxGroupScreens {
			detail.ScreensComplete = false
			break
		}
		detail.ScreenIDs = append(detail.ScreenIDs, screen.ID)
	}
	return detail
}

// Inputs.

type contentListInput struct {
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
	Search string `json:"search"`
}

// filters is what a cursor is bound to: everything but limit and cursor.
func (in contentListInput) filters() any { return map[string]string{"search": in.Search} }

func (in contentListInput) validate() (int, *CallError) {
	if len(in.Search) > maxReadSearch {
		return 0, invalidInput("search may be at most %d bytes", maxReadSearch)
	}
	return listLimit(in.Limit)
}

type idInput struct {
	ID uuid.UUID `json:"id"`
}

func decodeID(call Call) (uuid.UUID, *CallError) {
	var input idInput
	if failure := decode(call.Input, &input); failure != nil {
		return uuid.Nil, failure
	}
	if input.ID == uuid.Nil {
		return uuid.Nil, invalidInput("id is required")
	}
	return input.ID, nil
}

// keysetPage runs one keyset list: it decodes the cursor, reads limit+1
// rows, fits the page to the transport bound, and issues the next cursor.
func keysetPage[Row any, Item any](call Call, input contentListInput, filters any, limit int,
	read func(after *keysetPosition, limit int) ([]Row, error),
	position func(Row) (time.Time, uuid.UUID), project func(Row) Item,
) (any, *Denial, *CallError) {
	after, failure := decodeKeysetCursor(input.Cursor, call.Operation, filters)
	if failure != nil {
		return nil, nil, failure
	}
	rows, err := read(after, limit+1)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		items = append(items, project(row))
	}
	kept, last := fitPage(call.Operation, items, limit, false)
	page := contentPage[Item]{Items: kept}
	if last >= 0 {
		at, id := position(rows[last])
		page.NextCursor = keysetCursor(call.Operation, filters, at, id)
	}
	return page, nil, nil
}

// libraryView is the Media library a call reads: for a studio call, the
// operator's content access after the capability check; for an unattended
// call, the whole library. types are the asset types the operation reads.
func (d *Dispatcher) libraryView(ctx context.Context, call Call, capability auth.Capability, types []string) (media.View, *CallError) {
	actor, studio, failure := studioActor(call)
	if failure != nil {
		return media.View{}, failure
	}
	if !studio {
		return media.View{Access: media.FullAccess(uuid.Nil), Types: types}, nil
	}
	if err := authz.Require(actor, capability); err != nil {
		return media.View{}, authzFailure(err, "")
	}
	access, err := d.deps.Media.AccessFor(ctx, actor.UserID, actor.Owner)
	if err != nil {
		return media.View{}, unavailable(err)
	}
	return media.View{Access: access, Types: types}, nil
}

// Handlers.

func (d *Dispatcher) contentPlaylistsList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapPlaylistRead); failure != nil {
		return nil, nil, failure
	}
	var input contentListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	limit, failure := input.validate()
	if failure != nil {
		return nil, nil, failure
	}
	return keysetPage(call, input, input.filters(), limit,
		func(after *keysetPosition, n int) ([]playlists.Playlist, error) {
			return d.deps.Playlists.ListAfter(ctx, input.Search, after, n)
		},
		func(p playlists.Playlist) (time.Time, uuid.UUID) { return p.CreatedAt, p.ID },
		projectPlaylist)
}

func (d *Dispatcher) contentPlaylistsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapPlaylistRead); failure != nil {
		return nil, nil, failure
	}
	id, failure := decodeID(call)
	if failure != nil {
		return nil, nil, failure
	}
	playlist, err := d.deps.Playlists.GetDraft(ctx, id)
	if errors.Is(err, playlists.ErrNotFound) {
		return nil, nil, notFound("playlist was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return projectPlaylistDetail(playlist), nil, nil
}

func (d *Dispatcher) contentLayoutsList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapLayoutRead); failure != nil {
		return nil, nil, failure
	}
	var input contentListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	limit, failure := input.validate()
	if failure != nil {
		return nil, nil, failure
	}
	return keysetPage(call, input, input.filters(), limit,
		func(after *keysetPosition, n int) ([]layouts.Summary, error) {
			return d.deps.Layouts.ListAfter(ctx, input.Search, after, n)
		},
		func(l layouts.Summary) (time.Time, uuid.UUID) { return l.CreatedAt, l.ID },
		projectLayout)
}

func (d *Dispatcher) contentLayoutsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapLayoutRead); failure != nil {
		return nil, nil, failure
	}
	id, failure := decodeID(call)
	if failure != nil {
		return nil, nil, failure
	}
	layout, err := d.deps.Layouts.Get(ctx, id)
	if errors.Is(err, layouts.ErrNotFound) {
		return nil, nil, notFound("layout was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return projectLayoutDetail(layout), nil, nil
}

type widgetListInput struct {
	contentListInput
	Provider string `json:"provider"`
}

func (d *Dispatcher) contentWidgetsList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input widgetListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	view, failure := d.libraryView(ctx, call, auth.CapWidgetRead, []string{"widget"})
	if failure != nil {
		return nil, nil, failure
	}
	limit, failure := input.validate()
	if failure != nil {
		return nil, nil, failure
	}
	if len(input.Provider) > 64 {
		return nil, nil, invalidInput("provider may be at most 64 bytes")
	}
	filters := map[string]string{"search": input.Search, "provider": input.Provider}
	return keysetPage(call, input.contentListInput, filters, limit,
		func(after *keysetPosition, n int) ([]media.Asset, error) {
			return d.deps.Media.ListAssetsAfter(ctx, media.AssetPageQuery{View: view, Search: input.Search, Provider: input.Provider, After: after, Limit: n})
		},
		func(a media.Asset) (time.Time, uuid.UUID) { return a.CreatedAt, a.ID },
		projectWidget)
}

func (d *Dispatcher) contentWidgetsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	id, failure := decodeID(call)
	if failure != nil {
		return nil, nil, failure
	}
	view, failure := d.libraryView(ctx, call, auth.CapWidgetRead, []string{"widget"})
	if failure != nil {
		return nil, nil, failure
	}
	asset, err := d.deps.Media.GetAssetInView(ctx, view, id)
	if errors.Is(err, media.ErrNotFound) {
		return nil, nil, notFound("widget was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return projectWidgetDetail(asset), nil, nil
}

type mediaListInput struct {
	contentListInput
	Type string `json:"type"`
}

func (d *Dispatcher) contentMediaList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input mediaListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	types := []string{"image", "video"}
	switch input.Type {
	case "":
	case "image", "video":
		types = []string{input.Type}
	default:
		return nil, nil, invalidInput("type must be image or video")
	}
	view, failure := d.libraryView(ctx, call, auth.CapMediaRead, types)
	if failure != nil {
		return nil, nil, failure
	}
	limit, failure := input.validate()
	if failure != nil {
		return nil, nil, failure
	}
	filters := map[string]string{"search": input.Search, "type": input.Type}
	return keysetPage(call, input.contentListInput, filters, limit,
		func(after *keysetPosition, n int) ([]media.Asset, error) {
			return d.deps.Media.ListAssetsAfter(ctx, media.AssetPageQuery{View: view, Search: input.Search, After: after, Limit: n})
		},
		func(a media.Asset) (time.Time, uuid.UUID) { return a.CreatedAt, a.ID },
		projectMedia)
}

func (d *Dispatcher) contentMediaGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	id, failure := decodeID(call)
	if failure != nil {
		return nil, nil, failure
	}
	view, failure := d.libraryView(ctx, call, auth.CapMediaRead, []string{"image", "video"})
	if failure != nil {
		return nil, nil, failure
	}
	asset, err := d.deps.Media.GetAssetInView(ctx, view, id)
	if errors.Is(err, media.ErrNotFound) {
		return nil, nil, notFound("media item was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return projectMediaDetail(asset), nil, nil
}

type dataSourceListInput struct {
	contentListInput
	Provider string `json:"provider"`
}

func (d *Dispatcher) contentDataSourcesList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapDataSourceRead); failure != nil {
		return nil, nil, failure
	}
	var input dataSourceListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	limit, failure := input.validate()
	if failure != nil {
		return nil, nil, failure
	}
	if len(input.Provider) > 128 {
		return nil, nil, invalidInput("provider may be at most 128 bytes")
	}
	filters := map[string]string{"search": input.Search, "provider": input.Provider}
	return keysetPage(call, input.contentListInput, filters, limit,
		func(after *keysetPosition, n int) ([]media.DataSourceListItem, error) {
			return d.deps.Media.ListDataSourcesAfter(ctx, input.Search, input.Provider, after, n)
		},
		func(item media.DataSourceListItem) (time.Time, uuid.UUID) { return item.CreatedAt, item.ID },
		func(item media.DataSourceListItem) contentDataSource {
			return projectDataSource(item.DataSource, item.Status, item.CachedRecords)
		})
}

func (d *Dispatcher) contentDataSourcesGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapDataSourceRead); failure != nil {
		return nil, nil, failure
	}
	id, failure := decodeID(call)
	if failure != nil {
		return nil, nil, failure
	}
	detail, err := d.deps.Media.GetDataSourceDetail(ctx, id)
	if errors.Is(err, media.ErrNotFound) {
		return nil, nil, notFound("data source was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return projectDataSourceDetail(detail), nil, nil
}

type scheduleListInput struct {
	contentListInput
	Enabled          *bool  `json:"enabled"`
	Type             string `json:"type"`
	PresentationType string `json:"presentationType"`
}

func (d *Dispatcher) contentSchedulesList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input scheduleListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	limit, failure := input.validate()
	if failure != nil {
		return nil, nil, failure
	}
	filter := scheduling.ListFilter{Search: input.Search, Enabled: input.Enabled, Type: scheduling.Kind(input.Type), PresentationType: input.PresentationType}
	if err := filter.Validate(); err != nil {
		return nil, nil, invalidInput("schedule filter is invalid")
	}
	access, failure := d.screenAccess(ctx, call, auth.CapScheduleRead)
	if failure != nil {
		return nil, nil, failure
	}
	filters := map[string]any{"search": input.Search, "enabled": input.Enabled, "type": input.Type, "presentationType": input.PresentationType}
	return keysetPage(call, input.contentListInput, filters, limit,
		func(after *keysetPosition, n int) ([]scheduling.Record, error) {
			return d.deps.Scheduling.ListAfter(ctx, filter, access, after, n)
		},
		func(r scheduling.Record) (time.Time, uuid.UUID) { return r.CreatedAt, r.ID },
		projectSchedule)
}

func (d *Dispatcher) contentSchedulesGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	id, failure := decodeID(call)
	if failure != nil {
		return nil, nil, failure
	}
	if failure := d.authorize(ctx, call, "schedule was not found", func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Schedule(ctx, actor, auth.CapScheduleRead, id)
	}); failure != nil {
		return nil, nil, failure
	}
	record, err := d.deps.Scheduling.Get(ctx, id)
	if errors.Is(err, scheduling.ErrNotFound) {
		return nil, nil, notFound("schedule was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return projectScheduleDetail(record), nil, nil
}

func (d *Dispatcher) contentGroupsList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input contentListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	limit, failure := input.validate()
	if failure != nil {
		return nil, nil, failure
	}
	access, failure := d.screenAccess(ctx, call, auth.CapScreenRead)
	if failure != nil {
		return nil, nil, failure
	}
	return keysetPage(call, input, input.filters(), limit,
		func(after *keysetPosition, n int) ([]scheduling.Group, error) {
			return d.deps.Scheduling.ListGroupsAfter(ctx, input.Search, access, after, n)
		},
		func(g scheduling.Group) (time.Time, uuid.UUID) { return g.CreatedAt, g.ID },
		projectGroup)
}

func (d *Dispatcher) contentGroupsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	id, failure := decodeID(call)
	if failure != nil {
		return nil, nil, failure
	}
	if failure := d.authorize(ctx, call, "screen group was not found", func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Group(ctx, actor, auth.CapScreenRead, id)
	}); failure != nil {
		return nil, nil, failure
	}
	group, err := d.deps.Scheduling.GetGroup(ctx, id)
	if errors.Is(err, scheduling.ErrNotFound) {
		return nil, nil, notFound("screen group was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return projectGroupDetail(group), nil, nil
}
