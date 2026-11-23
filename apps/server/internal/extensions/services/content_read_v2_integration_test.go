package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// content.read@2 against real domain services: unattended reads see the
// installation-wide library, Studio reads take the dashboard decision, and
// no answer carries storage details, secrets, or private plugin assets.

type contentFixture struct {
	*serviceFixture
	org                                uuid.UUID
	playlists                          []uuid.UUID
	layout                             uuid.UUID
	image, video, widget               uuid.UUID
	attachment, managedWidget, archive uuid.UUID
	folder                             uuid.UUID
	dataSource                         uuid.UUID
	screen, group, schedule            uuid.UUID
}

func newContentFixture(t *testing.T) *contentFixture {
	t.Helper()
	f := &contentFixture{serviceFixture: newServiceFixture(t)}
	ctx := context.Background()
	f.org = serviceOrgID(t, f.pool)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := f.pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	// Three playlists, two created in the same instant so the id breaks the tie.
	same := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for index, name := range []string{"Morning", "Lunch", "Evening"} {
		created, err := f.dispatcher.deps.Playlists.Create(ctx, f.ownerID, name, "", "static")
		if err != nil {
			t.Fatal(err)
		}
		at := same
		if index == 0 {
			at = same.Add(-time.Hour)
		}
		exec(`UPDATE playlists SET created_at=$2 WHERE id=$1`, created.ID, at)
		f.playlists = append(f.playlists, created.ID)
	}
	layout, err := f.dispatcher.deps.Layouts.Create(ctx, f.ownerID, "Lobby", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	f.layout = layout.ID
	f.folder = uuid.New()
	exec(`INSERT INTO content_folders(id,organization_id,name) VALUES($1,$2,'Shared')`, f.folder, f.org)
	asset := func(kind, origin string, managed bool, folder *uuid.UUID, archived bool) uuid.UUID {
		id := uuid.New()
		var archivedAt *time.Time
		if archived {
			now := time.Now()
			archivedAt = &now
		}
		exec(`INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,origin,system_managed,folder_id,archived_at,metadata)
			VALUES($1,$2,$3,$4,'/srv/private/upload.bin','image/png','\x00',42,'ready',$5,$6,$7,$8,'{"gps":"secret place"}')`,
			id, f.org, kind+" "+origin, kind, origin, managed, folder, archivedAt)
		return id
	}
	f.image = asset("image", "library", false, &f.folder, false)
	f.video = asset("video", "library", false, nil, false)
	f.widget = asset("widget", "library", false, nil, false)
	f.attachment = asset("image", "form_attachment", false, nil, false)
	f.managedWidget = asset("widget", "library", true, nil, false)
	f.archive = asset("image", "library", false, nil, true)
	exec(`UPDATE assets SET owning_plugin='forms' WHERE id=$1`, f.attachment)
	exec(`INSERT INTO widgets(asset_id,provider,config_version,configuration) VALUES($1,'clock',1,'{"title":"Clock","apiToken":"never-leaves","nested":{"clientSecret":"x","color":"#fff"}}'),($2,'clock',1,'{}')`, f.widget, f.managedWidget)
	f.dataSource = uuid.New()
	exec(`INSERT INTO data_sources(id,organization_id,name,provider,configuration) VALUES($1,$2,'Menu','manual','{"url":"https://example.test/feed?token=abc","apiKey":"zzz","rows":[{"title":"private row"}]}')`, f.dataSource, f.org)
	f.screen, f.group, f.schedule = uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Hall','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, f.screen, f.org, uuid.NewString())
	exec(`INSERT INTO screen_groups(id,organization_id,name) VALUES($1,$2,'Hallways')`, f.group, f.org)
	exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id) VALUES($1,$2)`, f.group, f.screen)
	exec(`INSERT INTO schedules(id,organization_id,name,type,timezone,playlist_id,daily_start,daily_end,days_of_week) VALUES($1,$2,'Weekdays','weekly','UTC',$3,'08:00','17:00','{1,2,3,4,5}')`, f.schedule, f.org, f.playlists[0])
	exec(`INSERT INTO schedule_targets(schedule_id,target_type,screen_group_id) VALUES($1,'group',$2)`, f.schedule, f.group)
	return f
}

func (f *contentFixture) call(context string, actor *Actor, operation string, input any) callResult {
	raw, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	data, denial, failure := f.dispatcher.Call(contextBackground(), Call{
		PackageID: "acme.reader", Context: context, Actor: actor,
		Grants:    []packagemanifest.ServiceGrant{{ID: "content.read", Version: 2}},
		Operation: operation, Input: raw,
	})
	return callResult{data: data, denial: denial, failure: failure}
}

func contextBackground() context.Context { return context.Background() }

func itemIDs(t *testing.T, page map[string]any) []string {
	t.Helper()
	items, ok := page["items"].([]any)
	if !ok {
		t.Fatalf("page has no items: %+v", page)
	}
	ids := []string{}
	for _, item := range items {
		ids = append(ids, item.(map[string]any)["id"].(string))
	}
	return ids
}

func encodedOf(t *testing.T, result callResult) string {
	t.Helper()
	if result.denial != nil || result.failure != nil {
		t.Fatalf("denial=%+v failure=%+v", result.denial, result.failure)
	}
	encoded, err := json.Marshal(result.data)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestContentReadV2UnattendedReadsTheInstallation(t *testing.T) {
	f := newContentFixture(t)
	for _, context := range []string{ContextBackground, ContextSystem} {
		for operation, want := range map[string][]uuid.UUID{
			"content.read@2/playlists.list": f.playlists,
			"content.read@2/layouts.list":   {f.layout},
			"content.read@2/widgets.list":   {f.widget},
			"content.read@2/media.list":     {f.image, f.video},
			"content.read@2/groups.list":    {f.group},
			"content.read@2/schedules.list": {f.schedule},
		} {
			page := mustData(t, f.call(context, nil, operation, map[string]any{}))
			got := itemIDs(t, page)
			if len(got) != len(want) {
				t.Fatalf("%s %s = %v, want %d items", context, operation, got, len(want))
			}
			for _, id := range want {
				if !strings.Contains(strings.Join(got, ","), id.String()) {
					t.Errorf("%s %s is missing %s", context, operation, id)
				}
			}
			if _, more := page["nextCursor"]; more {
				t.Errorf("%s %s issued a cursor on its only page", context, operation)
			}
		}
		sources := itemIDs(t, mustData(t, f.call(context, nil, "content.read@2/dataSources.list", map[string]any{})))
		if len(sources) != 1 || sources[0] != f.dataSource.String() {
			t.Fatalf("data sources = %v", sources)
		}
	}
}

func TestContentReadV2SeparatesWidgetsMediaAndPrivateAssets(t *testing.T) {
	f := newContentFixture(t)
	for _, test := range []struct {
		operation string
		id        uuid.UUID
		found     bool
	}{
		{"content.read@2/media.get", f.image, true},
		{"content.read@2/media.get", f.widget, false},
		{"content.read@2/media.get", f.attachment, false},
		{"content.read@2/media.get", f.archive, false},
		{"content.read@2/widgets.get", f.widget, true},
		{"content.read@2/widgets.get", f.image, false},
		{"content.read@2/widgets.get", f.attachment, false},
		{"content.read@2/widgets.get", uuid.New(), false},
	} {
		result := f.call(ContextBackground, nil, test.operation, map[string]any{"id": test.id})
		if test.found && (result.failure != nil || result.denial != nil) {
			t.Errorf("%s %s = %+v %+v", test.operation, test.id, result.denial, result.failure)
		}
		if !test.found && (result.failure == nil || result.failure.Code != ErrCodeNotFound) {
			t.Errorf("%s %s = %+v, want not_found", test.operation, test.id, result.failure)
		}
	}
	listed := encodedOf(t, f.call(ContextBackground, nil, "content.read@2/media.list", map[string]any{}))
	for _, hidden := range []uuid.UUID{f.widget, f.attachment, f.managedWidget, f.archive} {
		if strings.Contains(listed, hidden.String()) {
			t.Errorf("media.list returned %s", hidden)
		}
	}
	images := itemIDs(t, mustData(t, f.call(ContextBackground, nil, "content.read@2/media.list", map[string]any{"type": "image"})))
	if len(images) != 1 || images[0] != f.image.String() {
		t.Fatalf("image filter = %v", images)
	}
	media := encodedOf(t, f.call(ContextBackground, nil, "content.read@2/media.get", map[string]any{"id": f.image}))
	for _, leaked := range []string{"/srv/private", "upload.bin", "gps", "secret place", "sha256", "variants", "thumbnailUrl", "metadata", "originalFilename"} {
		if strings.Contains(media, leaked) {
			t.Errorf("media.get leaked %q: %s", leaked, media)
		}
	}
	if !strings.Contains(media, f.folder.String()) {
		t.Errorf("media.get lost its folder: %s", media)
	}
	widget := encodedOf(t, f.call(ContextBackground, nil, "content.read@2/widgets.get", map[string]any{"id": f.widget}))
	if strings.Contains(widget, "never-leaves") || strings.Contains(widget, "clientSecret") || !strings.Contains(widget, `"color":"#fff"`) || !strings.Contains(widget, `"provider":"clock"`) {
		t.Errorf("widget configuration = %s", widget)
	}
}

func TestContentReadV2DataSourcesDescribeWithoutPayloads(t *testing.T) {
	f := newContentFixture(t)
	for _, encoded := range []string{
		encodedOf(t, f.call(ContextBackground, nil, "content.read@2/dataSources.get", map[string]any{"id": f.dataSource})),
		encodedOf(t, f.call(ContextBackground, nil, "content.read@2/dataSources.list", map[string]any{})),
	} {
		for _, leaked := range []string{"configuration", "token=abc", "zzz", "private row", "apiKey"} {
			if strings.Contains(encoded, leaked) {
				t.Errorf("data source answer leaked %q: %s", leaked, encoded)
			}
		}
		if !strings.Contains(encoded, `"provider":"manual"`) {
			t.Errorf("data source answer lost its provider: %s", encoded)
		}
	}
}

func TestContentReadV2Pagination(t *testing.T) {
	f := newContentFixture(t)
	seen := []string{}
	cursor := ""
	for range 5 {
		page := mustData(t, f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"limit": 1, "cursor": cursor}))
		ids := itemIDs(t, page)
		if len(ids) != 1 {
			t.Fatalf("limit 1 page = %v", ids)
		}
		seen = append(seen, ids[0])
		next, _ := page["nextCursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}
	if len(seen) != 3 {
		t.Fatalf("walked %v", seen)
	}
	// Oldest first, then the id breaks the tie of the two equal instants.
	if seen[0] != f.playlists[0].String() {
		t.Fatalf("first playlist = %s, want the oldest", seen[0])
	}
	tied := []string{f.playlists[1].String(), f.playlists[2].String()}
	if tied[0] > tied[1] {
		tied[0], tied[1] = tied[1], tied[0]
	}
	if seen[1] != tied[0] || seen[2] != tied[1] {
		t.Fatalf("tie order = %v, want %v", seen[1:], tied)
	}
	// The same walk twice gives the same pages.
	again := itemIDs(t, mustData(t, f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"limit": 2})))
	if again[0] != seen[0] || again[1] != seen[1] {
		t.Fatalf("second walk = %v, first = %v", again, seen)
	}
	first := mustData(t, f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"limit": 1}))
	token := first["nextCursor"].(string)
	for name, call := range map[string]callResult{
		"changed filter":   f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"limit": 1, "cursor": token, "search": "Lunch"}),
		"other operation":  f.call(ContextBackground, nil, "content.read@2/layouts.list", map[string]any{"limit": 1, "cursor": token}),
		"invalid cursor":   f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"cursor": "not-a-cursor"}),
		"over the maximum": f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"limit": MaxListLimit + 1}),
		"negative limit":   f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"limit": -1}),
		"long search":      f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"search": strings.Repeat("s", maxReadSearch+1)}),
		"unknown member":   f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"page": 2}),
	} {
		if call.failure == nil || call.failure.Code != ErrCodeInvalidInput {
			t.Errorf("%s = %+v, want invalid_input", name, call.failure)
		}
	}
	if ids := itemIDs(t, mustData(t, f.call(ContextBackground, nil, "content.read@2/playlists.list", map[string]any{"limit": MaxListLimit}))); len(ids) != 3 {
		t.Fatalf("maximum limit = %v", ids)
	}
}

func TestContentReadV2StudioTakesTheDashboardDecision(t *testing.T) {
	f := newContentFixture(t)
	ctx := context.Background()
	owner := &Actor{UserID: f.ownerID, Role: "owner", Capabilities: builtinActor("owner").Capabilities}
	viewer := &Actor{UserID: f.viewerID, Role: "viewer", Capabilities: builtinActor("viewer").Capabilities}

	// The Owner sees the whole library.
	if ids := itemIDs(t, mustData(t, f.call(ContextStudio, owner, "content.read@2/media.list", map[string]any{}))); len(ids) != 2 {
		t.Fatalf("owner media = %v", ids)
	}
	// A viewer without a content policy reaches nothing, and an asset by id
	// reads as absent.
	if ids := itemIDs(t, mustData(t, f.call(ContextStudio, viewer, "content.read@2/media.list", map[string]any{}))); len(ids) != 0 {
		t.Fatalf("viewer without policy media = %v", ids)
	}
	if result := f.call(ContextStudio, viewer, "content.read@2/media.get", map[string]any{"id": f.image}); result.failure == nil || result.failure.Code != ErrCodeNotFound {
		t.Fatalf("viewer media.get = %+v", result.failure)
	}
	// A restricted policy reaches its folder only.
	if _, err := f.pool.Exec(ctx, `INSERT INTO user_content_access(user_id,library_mode,tag_mode) VALUES($1,'restricted','all')`, f.viewerID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO user_content_folder_grants(user_id,folder_id) VALUES($1,$2)`, f.viewerID, f.folder); err != nil {
		t.Fatal(err)
	}
	if ids := itemIDs(t, mustData(t, f.call(ContextStudio, viewer, "content.read@2/media.list", map[string]any{}))); len(ids) != 1 || ids[0] != f.image.String() {
		t.Fatalf("restricted viewer media = %v", ids)
	}
	if result := f.call(ContextStudio, viewer, "content.read@2/widgets.get", map[string]any{"id": f.widget}); result.failure == nil || result.failure.Code != ErrCodeNotFound {
		t.Fatalf("restricted viewer widget outside folder = %+v", result.failure)
	}
	// Screen access narrows schedules and groups; an unconfigured policy
	// reaches nothing.
	for _, operation := range []string{"content.read@2/schedules.list", "content.read@2/groups.list"} {
		if ids := itemIDs(t, mustData(t, f.call(ContextStudio, viewer, operation, map[string]any{}))); len(ids) != 0 {
			t.Fatalf("viewer without screen access %s = %v", operation, ids)
		}
	}
	if result := f.call(ContextStudio, viewer, "content.read@2/schedules.get", map[string]any{"id": f.schedule}); result.failure == nil || result.failure.Code != ErrCodeNotFound {
		t.Fatalf("viewer schedules.get = %+v", result.failure)
	}
	if result := f.call(ContextStudio, viewer, "content.read@2/groups.get", map[string]any{"id": f.group}); result.failure == nil || result.failure.Code != ErrCodeNotFound {
		t.Fatalf("viewer groups.get = %+v", result.failure)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO user_screen_access(user_id,mode) VALUES($1,'all')`, f.viewerID); err != nil {
		t.Fatal(err)
	}
	schedule := mustData(t, f.call(ContextStudio, viewer, "content.read@2/schedules.get", map[string]any{"id": f.schedule}))
	if targets, _ := schedule["targets"].([]any); len(targets) != 1 || schedule["targetsComplete"] != true {
		t.Fatalf("schedule = %+v", schedule)
	}
	group := mustData(t, f.call(ContextStudio, viewer, "content.read@2/groups.get", map[string]any{"id": f.group}))
	if ids, _ := group["screenIds"].([]any); len(ids) != 1 || group["screenCount"] != float64(1) {
		t.Fatalf("group = %+v", group)
	}
}

func TestContentReadV2CursorGrantsNothing(t *testing.T) {
	f := newContentFixture(t)
	owner := &Actor{UserID: f.ownerID, Role: "owner", Capabilities: builtinActor("owner").Capabilities}
	viewer := &Actor{UserID: f.viewerID, Role: "viewer", Capabilities: builtinActor("viewer").Capabilities}
	first := mustData(t, f.call(ContextStudio, owner, "content.read@2/media.list", map[string]any{"limit": 1}))
	token, _ := first["nextCursor"].(string)
	if token == "" {
		t.Fatal("no cursor for a two-item library")
	}
	// The viewer continues the Owner's cursor and still sees nothing.
	if ids := itemIDs(t, mustData(t, f.call(ContextStudio, viewer, "content.read@2/media.list", map[string]any{"limit": 1, "cursor": token}))); len(ids) != 0 {
		t.Fatalf("viewer continued the owner's cursor into %v", ids)
	}
	// And an actor without the capability is refused on page two.
	none := &Actor{UserID: f.viewerID, Role: "custom.none", Capabilities: builtinActor("custom.none").Capabilities}
	if result := f.call(ContextStudio, none, "content.read@2/media.list", map[string]any{"limit": 1, "cursor": token}); result.failure == nil || result.failure.Code != ErrCodeForbidden {
		t.Fatalf("capability-less page two = %+v", result.failure)
	}
}

func TestContentReadV2DetailsAreProjections(t *testing.T) {
	f := newContentFixture(t)
	playlist := mustData(t, f.call(ContextBackground, nil, "content.read@2/playlists.get", map[string]any{"id": f.playlists[0]}))
	for _, key := range []string{"warnings", "layoutUsage", "usage", "Items"} {
		if _, ok := playlist[key]; ok {
			t.Errorf("playlist detail exposes %q", key)
		}
	}
	layout := mustData(t, f.call(ContextBackground, nil, "content.read@2/layouts.get", map[string]any{"id": f.layout}))
	for _, key := range []string{"draft", "previewImageUrl", "usage"} {
		if _, ok := layout[key]; ok {
			t.Errorf("layout detail exposes %q", key)
		}
	}
	if result := f.call(ContextBackground, nil, "content.read@2/playlists.get", map[string]any{"id": uuid.New()}); result.failure == nil || result.failure.Code != ErrCodeNotFound {
		t.Fatalf("missing playlist = %+v", result.failure)
	}
	if result := f.call(ContextBackground, nil, "content.read@2/playlists.get", map[string]any{}); result.failure == nil || result.failure.Code != ErrCodeInvalidInput {
		t.Fatalf("playlist without id = %+v", result.failure)
	}
}

// TestContentReadV1StaysCompatible pins the frozen V1 answers next to V2 on
// the same rows: page/pageSize pagination, domain shapes, and package-only
// callers.
func TestContentReadV1StaysCompatible(t *testing.T) {
	f := newContentFixture(t)
	page := mustData(t, f.background("acme.v1", "content.read", "content.read@1/playlists.list", map[string]any{"page": 1, "pageSize": 2}))
	if page["total"] != float64(3) || page["page"] != float64(1) || page["pageSize"] != float64(2) {
		t.Fatalf("v1 page = %+v", page)
	}
	if items, _ := page["items"].([]any); len(items) != 2 {
		t.Fatalf("v1 items = %+v", page["items"])
	}
	if _, cursor := page["nextCursor"]; cursor {
		t.Fatal("v1 gained a cursor")
	}
	groups := mustData(t, f.background("acme.v1", "content.read", "content.read@1/groups.get", map[string]any{"id": f.group}))
	if _, ok := groups["screens"]; !ok {
		t.Fatalf("v1 group lost its screens: %+v", groups)
	}
	// V1 still refuses the system context and bundled callers.
	data, denial, _ := f.dispatcher.Call(context.Background(), Call{PackageID: "acme.v1", Context: ContextSystem, Grants: []packagemanifest.ServiceGrant{{ID: "content.read", Version: 1}}, Operation: "content.read@1/playlists.list"})
	if denial == nil || denial.Kind != DenialForbiddenContext {
		t.Fatalf("v1 system call = %+v %+v", data, denial)
	}
	_, denial, _ = f.dispatcher.Call(context.Background(), Call{PluginID: "acme-plugin", Context: ContextBackground, Grants: []packagemanifest.ServiceGrant{{ID: "content.read", Version: 1}}, Operation: "content.read@1/playlists.list"})
	if denial == nil || denial.Kind != DenialMissingGrant {
		t.Fatalf("v1 bundled call = %+v", denial)
	}
}
