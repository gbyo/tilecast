package playlists

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// reportCapabilities records what the fixture screen's Player reported: the
// shared Player Runtime's declarative profile (which renders time-bound
// Widgets) plus any extra capabilities.
func (f *capabilityFixture) reportCapabilities(t *testing.T, schemas string, extra map[string]int) {
	t.Helper()
	capabilities := map[string]int{"environment.time": 1}
	for name, version := range NativePresentationCapabilities {
		capabilities[name] = version
	}
	for name, version := range extra {
		capabilities[name] = version
	}
	encoded, _ := json.Marshal(capabilities)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO screen_player_status(screen_id,presentation_schema_versions,native_presentation_capabilities,web_runtime_version,player_version_code)VALUES($1,$2::int[],$3,2,40) ON CONFLICT(screen_id) DO UPDATE SET presentation_schema_versions=EXCLUDED.presentation_schema_versions,native_presentation_capabilities=EXCLUDED.native_presentation_capabilities,web_runtime_version=2,player_version_code=40`, f.screen, schemas, encoded); err != nil {
		t.Fatal(err)
	}
}

func (f *capabilityFixture) clockPlaylist(t *testing.T, configuration map[string]any) uuid.UUID {
	t.Helper()
	raw, _ := json.Marshal(configuration)
	widget, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "clock", Name: "Lobby Clock", Configuration: raw})
	if err != nil {
		t.Fatalf("create clock: %v", err)
	}
	playlist, err := f.service.Create(f.ctx, f.user, "Clock rotation", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(30_000)
	if _, err := f.service.AddItem(f.ctx, playlist.ID, f.user, ItemInput{AssetID: widget.ID, DurationMS: &duration, DeliveryPolicy: "stream"}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
	return playlist.ID
}

func onlyWidget(t *testing.T, manifest Manifest) ManifestWidget {
	t.Helper()
	if len(manifest.Widgets) != 1 {
		t.Fatalf("expected one manifest Widget, got %d", len(manifest.Widgets))
	}
	return manifest.Widgets[0]
}

// TestClockComponentChosenForEachPlayer proves the Server gives the Clock's
// first-class component only to Players that report its exact capability, and
// the unchanged compatibility presentation to every other Player, without
// changing the persisted Widget (docs/widgets-v2.md §7).
func TestClockComponentChosenForEachPlayer(t *testing.T) {
	f := setupCapabilityFixture(t)
	persisted := map[string]any{
		"timezone": "Europe/London", "format": "24", "showSeconds": true,
		"foregroundColor": "#F5F7FA", "backgroundColor": "#0E141B",
	}
	playlistID := f.clockPlaylist(t, persisted)

	// A Player that has not reported capabilities keeps the v11 configuration path.
	if _, err := f.service.Assign(f.ctx, f.screen, playlistID, f.user); err != nil {
		t.Fatal(err)
	}
	manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 11 || onlyWidget(t, manifest).Presentation != nil {
		t.Fatalf("legacy Player: schema %d, presentation %+v", manifest.SchemaVersion, onlyWidget(t, manifest).Presentation)
	}

	// A v13 Player without Widgets V2 gets the native compatibility presentation.
	f.reportCapabilities(t, "{1}", nil)
	manifest, _, err = f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 13 || onlyWidget(t, manifest).Presentation.Kind != "native" {
		t.Fatalf("v13 Player: schema %d, kind %q", manifest.SchemaVersion, onlyWidget(t, manifest).Presentation.Kind)
	}

	// Presentation schema 2 without the Clock's capability is not enough.
	f.reportCapabilities(t, "{1,2}", map[string]int{"widget.tilecast.weather": 1})
	manifest, _, err = f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 13 || onlyWidget(t, manifest).Presentation.Kind != "native" {
		t.Fatalf("Player without widget.tilecast.clock: schema %d, kind %q", manifest.SchemaVersion, onlyWidget(t, manifest).Presentation.Kind)
	}

	// A Player that renders Clock component version 1, from before the
	// Clock modes, still gets the compatibility presentation.
	f.reportCapabilities(t, "{1,2}", map[string]int{"widget.tilecast.clock": 1})
	manifest, _, err = f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 13 || onlyWidget(t, manifest).Presentation.Kind != "native" {
		t.Fatalf("Player with widget.tilecast.clock@1: schema %d, kind %q", manifest.SchemaVersion, onlyWidget(t, manifest).Presentation.Kind)
	}

	// A Widgets V2 Player gets manifest v16 and the component.
	f.reportCapabilities(t, "{1,2}", map[string]int{"widget.tilecast.clock": 2})
	manifest, _, err = f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	widget := onlyWidget(t, manifest)
	if manifest.SchemaVersion != ManifestSchemaComponents || widget.Presentation.Kind != "component" {
		t.Fatalf("V2 Player: schema %d, kind %q", manifest.SchemaVersion, widget.Presentation.Kind)
	}
	if widget.Presentation.SchemaVersion != 2 || widget.Presentation.RequiredCapabilities["widget.tilecast.clock"] != 2 || widget.Presentation.Native != nil {
		t.Fatalf("component presentation is malformed: %+v", widget.Presentation)
	}
	component := widget.Presentation.Component
	want := map[string]any{
		"timeZone": "Europe/London", "format": "24", "showSeconds": true,
		"style": "standard", "showDate": false, "mode": "time",
		// Saved colors are normalized to lowercase.
		"background": "#0e141b", "foreground": "#f5f7fa",
	}
	if component.Type != "tilecast.clock" || component.Version != 2 || len(component.DataSources) != 0 {
		t.Fatalf("component identity is wrong: %+v", component)
	}
	for key, value := range want {
		if component.Config[key] != value {
			t.Fatalf("component config %s = %v, want %v (config %v)", key, component.Config[key], value, component.Config)
		}
	}
	if widget.Configuration != nil {
		t.Fatalf("component manifest still carries the persisted configuration: %s", widget.Configuration)
	}

	// A Player that reports component schema 3 receives the bounded empty
	// policy in manifest v17. Schema 2 Players keep the v16 contract above.
	f.reportCapabilities(t, "{1,2,3}", map[string]int{"widget.tilecast.clock": 2})
	manifest, _, err = f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	v3Widget := onlyWidget(t, manifest)
	if manifest.SchemaVersion != ManifestSchemaComponentEmptyPolicy || v3Widget.Presentation.SchemaVersion != 3 || v3Widget.Presentation.Component.Empty != "render" {
		t.Fatalf("component schema 3 was not negotiated: schema=%d presentation=%+v", manifest.SchemaVersion, v3Widget.Presentation)
	}

	// The persisted Widget is unchanged by any of this.
	var stored json.RawMessage
	if err := f.pool.QueryRow(f.ctx, `SELECT configuration FROM widgets WHERE provider='clock'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), "timeZone") || !strings.Contains(string(stored), "Europe/London") {
		t.Fatalf("persisted Clock configuration changed: %s", stored)
	}

	// Assignment validation agrees with manifest generation for every profile.
	for _, schemas := range []string{"{1}", "{1,2}", "{1,2,3}"} {
		f.reportCapabilities(t, schemas, map[string]int{"widget.tilecast.clock": 2})
		if err := f.service.ValidatePresentationTargets(f.ctx, &playlistID, nil, []uuid.UUID{f.screen}, nil); err != nil {
			t.Fatalf("schemas %s: valid Clock content rejected: %v", schemas, err)
		}
	}
}

func TestEmptyComponentPolicyPreservesOlderPlayerAutoSkip(t *testing.T) {
	f := setupCapabilityFixture(t)
	source, err := f.media.CreateDataSource(f.ctx, f.user, media.DataSourceInput{
		Provider: "manual", Name: "Recognition entries",
		Configuration: json.RawMessage(`{"columns":[{"key":"person","label":"Person","type":"text"},{"key":"contribution","label":"Contribution","type":"text"}],"rows":[]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	configuration, _ := json.Marshal(map[string]any{
		"dataSourceId": source.ID.String(), "nameField": "person", "noteField": "contribution",
		"heading": "Recognition", "autoSkipWhenEmpty": true,
	})
	widget, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "recognition-board", Name: "Recognition", Configuration: configuration})
	if err != nil {
		t.Fatal(err)
	}
	playlist, err := f.service.Create(f.ctx, f.user, "Recognition rotation", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(30_000)
	if _, err := f.service.AddItem(f.ctx, playlist.ID, f.user, ItemInput{AssetID: widget.ID, DurationMS: &duration, DeliveryPolicy: "stream"}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
	for _, schemas := range []string{"{1,2}", "{1,2,3}"} {
		f.reportCapabilities(t, schemas, map[string]int{"widget.tilecast.cards": 1})
		if _, err := f.service.Assign(f.ctx, f.screen, playlist.ID, f.user); err != nil {
			t.Fatal(err)
		}
		manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
		if err != nil {
			t.Fatal(err)
		}
		presentation := onlyWidget(t, manifest).Presentation
		if schemas == "{1,2}" {
			if presentation.Kind != "native" || presentation.Native.Root.Props["autoSkipWhenEmpty"] != true {
				t.Fatalf("older Player lost auto-skip: %+v", presentation)
			}
		} else if manifest.SchemaVersion != 17 || presentation.SchemaVersion != 3 || presentation.Component.Empty != "skip-eligible" {
			t.Fatalf("capable Player lost empty policy: %+v", presentation)
		}
	}
}

// TestClockComponentInLayoutZone proves a Layout placement keeps the component
// instead of being converted back into a render tree.
func TestClockComponentInLayoutZone(t *testing.T) {
	f := setupCapabilityFixture(t)
	raw, _ := json.Marshal(map[string]any{"timezone": "", "format": "locale", "showSeconds": false, "foregroundColor": "#F5F7FA", "backgroundColor": "#0E141B", "style": "analog", "showDate": true})
	widget, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "clock", Name: "Corner Clock", Configuration: raw})
	if err != nil {
		t.Fatalf("create clock: %v", err)
	}
	layoutID, revisionID := uuid.New(), uuid.New()
	documentBytes, _ := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"canvas":        map[string]any{"width": 1920, "height": 1080, "orientation": "landscape", "backgroundColor": "#000000", "safeAreaPercent": 0},
		"placements": []any{map[string]any{
			"id": uuid.New(), "type": "widget", "name": "Clock", "widgetId": widget.ID,
			"x": 1440, "y": 0, "width": 480, "height": 1080, "layer": 0, "opacity": 1, "visible": true, "locked": false,
		}},
	})
	document := string(documentBytes)
	sum := sha256.Sum256(documentBytes)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by)VALUES($1,$2,'Lobby','landscape',1920,1080,$3::jsonb,$4)`, []any{layoutID, f.org, document, f.user}},
		{`INSERT INTO layout_revisions(id,layout_id,revision,document,document_sha256,published_by)VALUES($1,$2,1,$3::jsonb,$4,$5)`, []any{revisionID, layoutID, document, hex.EncodeToString(sum[:]), f.user}},
		{`UPDATE layouts SET published_revision_id=$2 WHERE id=$1`, []any{layoutID, revisionID}},
		{`INSERT INTO layout_revision_dependencies(revision_id,dependency_type,dependency_id)VALUES($1,'widget',$2)`, []any{revisionID, widget.ID}},
	} {
		if _, err := f.pool.Exec(f.ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	f.reportCapabilities(t, "{1,2}", map[string]int{"widget.tilecast.clock": 2})
	if err := f.service.ValidatePresentationTargets(f.ctx, nil, &layoutID, []uuid.UUID{f.screen}, nil); err != nil {
		t.Fatalf("Layout with a component Clock rejected: %v", err)
	}
	tx, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := f.service.PresentationIdentityInTx(f.ctx, tx, "layout", layoutID)
	if err != nil || identity.Name != "Lobby" || identity.Revision == nil || *identity.Revision != 1 {
		t.Fatalf("published Layout identity=%#v err=%v", identity, err)
	}
	evidence, err := f.service.PresentationCapabilityEvidenceInTx(f.ctx, tx, f.screen, "layout", layoutID)
	if err != nil || evidence.Status != "supported" || len(evidence.Widgets) != 1 || evidence.Widgets[0].AssetID != widget.ID || evidence.Widgets[0].SelectedRenderer != "component" {
		t.Fatalf("Layout capability evidence=%#v err=%v", evidence, err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	playlist, err := f.service.Create(f.ctx, f.user, "Lobby rotation", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(30_000)
	if _, err := f.service.AddItem(f.ctx, playlist.ID, f.user, ItemInput{LayoutID: &layoutID, DurationMS: &duration, DeliveryPolicy: "stream"}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
	if _, err := f.service.Assign(f.ctx, f.screen, playlist.ID, f.user); err != nil {
		t.Fatal(err)
	}
	manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != ManifestSchemaComponents {
		t.Fatalf("Layout manifest schema %d", manifest.SchemaVersion)
	}
	component := onlyWidget(t, manifest).Presentation.Component
	if component == nil || component.Config["style"] != "analog" || component.Config["showDate"] != true {
		t.Fatalf("Layout Widget lost its component: %+v", onlyWidget(t, manifest).Presentation)
	}
}

func TestLayoutZoneAssignmentRejectsUnsupportedPlaylistItems(t *testing.T) {
	f := setupCapabilityFixture(t)
	playlist, err := f.service.Create(f.ctx, f.user, "Zone playlist", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	f.addReadyImageToPlaylist(t, playlist.ID)
	var imageID uuid.UUID
	if err = f.pool.QueryRow(f.ctx, `SELECT asset_id FROM playlist_items WHERE playlist_id=$1`, playlist.ID).Scan(&imageID); err != nil {
		t.Fatal(err)
	}
	imageDuration := int64(10_000)
	if _, err = f.service.AddItem(f.ctx, playlist.ID, f.user, ItemInput{AssetID: imageID, DurationMS: &imageDuration}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)

	layoutID, revisionID := uuid.New(), uuid.New()
	documentBytes, err := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"canvas":        map[string]any{"width": 1920, "height": 1080, "orientation": "landscape", "backgroundColor": "#000000"},
		"placements": []any{map[string]any{
			"id": uuid.New(), "type": "playlistZone", "name": "Zone", "playlistId": playlist.ID,
			"x": 0, "y": 0, "width": 1920, "height": 1080, "layer": 0, "opacity": 1, "visible": true,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(documentBytes)
	encoded := string(documentBytes)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by)VALUES($1,$2,'Zone layout','landscape',1920,1080,$3::jsonb,$4)`, []any{layoutID, f.org, encoded, f.user}},
		{`INSERT INTO layout_revisions(id,layout_id,revision,document,document_sha256,published_by)VALUES($1,$2,1,$3::jsonb,$4,$5)`, []any{revisionID, layoutID, encoded, hex.EncodeToString(digest[:]), f.user}},
		{`UPDATE layouts SET published_revision_id=$2 WHERE id=$1`, []any{layoutID, revisionID}},
	} {
		if _, err = f.pool.Exec(f.ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err = f.service.ValidatePresentationTargets(f.ctx, nil, &layoutID, []uuid.UUID{f.screen}, nil); err != nil {
		t.Fatalf("image-only zone rejected: %v", err)
	}

	clock, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "clock", Name: "Zone clock", Configuration: json.RawMessage(`{"timezone":"UTC","format":"24","showSeconds":false}`)})
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(30_000)
	if _, err = f.service.AddItem(f.ctx, playlist.ID, f.user, ItemInput{AssetID: clock.ID, DurationMS: &duration, DeliveryPolicy: "stream"}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
	if err = f.service.ValidatePresentationTargets(f.ctx, nil, &layoutID, []uuid.UUID{f.screen}, nil); err == nil || !strings.Contains(err.Error(), "only image and video items") {
		t.Fatalf("assignment validation accepted a Widget added after Layout publication: %v", err)
	}
}

// TestComponentOnlyWidgetRefusedWithoutCapability proves a Widget with no
// compatibility presentation is refused, with a readable reason, on a Player
// that cannot render its component.
func TestComponentOnlyWidgetRefusedWithoutCapability(t *testing.T) {
	f := setupCapabilityFixture(t)
	player := playerPresentationCapabilities{SchemaVersions: []int32{1}, Native: NativePresentationCapabilities, Reported: true}
	component := &WidgetPresentation{SchemaVersion: 2, Kind: "component", RequiredCapabilities: map[string]int{"widget.tilecast.clock": 1}}
	err := checkWidgetCompatibility(f.ctx, f.pool, f.screen, presentationWidgetRequirement{Name: "Lobby Clock", Component: component}, player)
	if err == nil || !strings.Contains(err.Error(), "widget.tilecast.clock@1") || !strings.Contains(err.Error(), "Lobby") {
		t.Fatalf("component-only Widget was not refused with a readable reason: %v", err)
	}
	if errors.Is(err, ErrConflict) {
		t.Fatalf("the compatibility check itself should not classify the error: %v", err)
	}
}
