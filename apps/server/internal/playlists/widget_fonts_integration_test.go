package playlists

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/fonts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

func (f *capabilityFixture) countdownPlaylist(t *testing.T, fontID string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"target": "2026-12-01T09:00", "timezone": "America/New_York", "fontId": fontID})
	widget, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "countdown", Name: "Graduation", Configuration: raw})
	if err != nil {
		t.Fatalf("create countdown: %v", err)
	}
	playlist, err := f.service.Create(f.ctx, f.user, "Countdown rotation", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(30_000)
	if _, err := f.service.AddItem(f.ctx, playlist.ID, f.user, ItemInput{AssetID: widget.ID, DurationMS: &duration, DeliveryPolicy: "stream"}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
	return widget.ID, playlist.ID
}

// TestCountdownComponentCarriesLibraryFont covers a Widget font field end to
// end: the save records the family, the component presentation carries its
// faces as verified manifest assets, the library refuses to remove a family
// a Widget uses, and clearing the field releases it (docs/fonts.md).
func TestCountdownComponentCarriesLibraryFont(t *testing.T) {
	f := setupCapabilityFixture(t)
	familyID, assetID, variantID := insertFontFamily(t, f, "Fixture Display")
	widgetID, playlistID := f.countdownPlaylist(t, familyID.String())

	var recorded bool
	if err := f.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM widget_font_references WHERE widget_id=$1 AND font_id=$2)`, widgetID, familyID).Scan(&recorded); err != nil || !recorded {
		t.Fatalf("widget font reference not recorded: %v", err)
	}
	f.reportCapabilities(t, "{1,2,3}", map[string]int{"widget.tilecast.countdown": 1})
	if _, err := f.service.Assign(f.ctx, f.screen, playlistID, f.user); err != nil {
		t.Fatal(err)
	}
	manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	widget := onlyWidget(t, manifest)
	if widget.Presentation == nil || widget.Presentation.Kind != "component" {
		t.Fatalf("countdown component not chosen: %+v", widget.Presentation)
	}
	component := widget.Presentation.Component
	if component.Config["fontId"] != familyID.String() {
		t.Fatalf("component config lost the font: %#v", component.Config)
	}
	if len(component.Fonts) != 1 || component.Fonts[0].ID != familyID || component.Fonts[0].Family != "Fixture Display" || len(component.Fonts[0].Faces) != 1 {
		t.Fatalf("component fonts not projected: %#v", component.Fonts)
	}
	if face := component.Fonts[0].Faces[0]; face.AssetID != assetID || face.VariantID != variantID {
		t.Fatalf("unexpected face %#v", face)
	}
	if !manifestHasVariant(&manifest, assetID, variantID) {
		t.Fatalf("font face is not a manifest asset: %#v", manifest.Assets)
	}

	library := fonts.NewService(f.pool, nil, fonts.NewCatalog(true))
	studio := audit.WithSurface(f.ctx, audit.SurfaceStudio)
	err = library.Delete(studio, f.user, familyID)
	var inUse *fonts.InUse
	if !errors.As(err, &inUse) || len(inUse.Widgets) != 1 || inUse.Widgets[0].ID != widgetID || inUse.Widgets[0].Name != "Graduation" {
		t.Fatalf("deleting a family a Widget uses: %v %#v", err, inUse)
	}

	raw, _ := json.Marshal(map[string]any{"target": "2026-12-01T09:00", "timezone": "America/New_York", "fontId": ""})
	if _, err = f.media.UpdateWidget(f.ctx, widgetID, f.user, media.WidgetInput{Name: "Graduation", Configuration: raw}); err != nil {
		t.Fatal(err)
	}
	if err = f.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM widget_font_references WHERE widget_id=$1)`, widgetID).Scan(&recorded); err != nil || recorded {
		t.Fatalf("clearing the font kept its reference: %v", err)
	}
	if err = library.Delete(studio, f.user, familyID); err != nil {
		t.Fatalf("delete an unused family: %v", err)
	}
}

func TestCountdownRejectsUnknownLibraryFont(t *testing.T) {
	f := setupCapabilityFixture(t)
	for _, value := range []string{uuid.NewString(), "Inter"} {
		raw, _ := json.Marshal(map[string]any{"target": "2026-12-01T09:00", "fontId": value})
		if _, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "countdown", Name: "Bad font", Configuration: raw}); err == nil {
			t.Fatalf("countdown with font %q was accepted", value)
		}
	}
}
