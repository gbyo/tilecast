package playlists

import (
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
)

// insertFontFamily stores one library family with one face, the way the
// font library does: a system-managed 'font' asset with a Player-compatible
// original variant.
func insertFontFamily(t *testing.T, f *capabilityFixture, family string) (uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	familyID, assetID, variantID := uuid.New(), uuid.New(), uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO font_families(id,organization_id,family,source,source_id,source_version,category,license,subsets,created_by) VALUES($1,$2,$3,'google','test-family','1.0.0','display','OFL-1.1','{latin}',$4)`, familyID, f.org, family, f.user); err != nil {
		t.Fatalf("insert font family: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,system_managed,created_by) VALUES($1,$2,$3,'font','latin-wght-normal.woff2','font/woff2',$4,48256,'ready',TRUE,$5)`, assetID, f.org, family, make([]byte, 32), f.user); err != nil {
		t.Fatalf("insert font asset: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,player_compatible) VALUES($1,$2,'original','local',$3,'font/woff2',48256,$4,TRUE)`, variantID, assetID, "originals/"+assetID.String()+"/original.woff2", make([]byte, 32)); err != nil {
		t.Fatalf("insert font variant: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO font_faces(id,family_id,asset_id,style,weight_min,weight_max,subset,unicode_range) VALUES($1,$2,$3,'normal',100,900,'latin','U+0000-00FF')`, uuid.New(), familyID, assetID); err != nil {
		t.Fatalf("insert font face: %v", err)
	}
	return familyID, assetID, variantID
}

func fontTextLayout(fontID *uuid.UUID) layouts.Document {
	return layouts.Document{
		SchemaVersion: 2,
		Canvas:        layouts.Canvas{Width: 1920, Height: 1080, Orientation: "landscape", BackgroundColor: "#0E141B"},
		Placements: []layouts.Placement{{
			ID: uuid.New(), Type: "primitive", Name: "Welcome", X: 100, Y: 100,
			Width: 1200, Height: 200, Layer: 0, Opacity: 1, Visible: true,
			Primitive: &layouts.Primitive{Kind: "text", Text: "Welcome", FontFamily: "Inter", FontID: fontID, FontSize: 96, FontWeight: 700},
		}},
	}
}

func TestLayoutManifestCarriesLibraryFontFaces(t *testing.T) {
	f := setupCapabilityFixture(t)
	layoutsService := layouts.NewService(f.pool)
	layoutsService.SetManifestInvalidator(f.service)
	familyID, assetID, variantID := insertFontFamily(t, f, "Fixture Display")

	layout, err := layoutsService.Create(f.ctx, f.user, "Font layout", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	layout, err = layoutsService.SaveDraft(f.ctx, layout.ID, f.user, layout.DraftRevision, fontTextLayout(&familyID))
	if err != nil {
		t.Fatal(err)
	}
	var recorded bool
	if err = f.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM layout_draft_dependencies WHERE layout_id=$1 AND dependency_type='font' AND dependency_id=$2)`, layout.ID, familyID).Scan(&recorded); err != nil || !recorded {
		t.Fatalf("draft font dependency not recorded: %v", err)
	}
	if _, err = layoutsService.Publish(f.ctx, layout.ID, f.user, layout.DraftRevision); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.AssignPresentation(f.ctx, f.screen, nil, &layout.ID, f.user); err != nil {
		t.Fatal(err)
	}
	manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Layout == nil || len(manifest.Layout.Fonts) != 1 {
		t.Fatalf("layout fonts not projected: %#v", manifest.Layout)
	}
	font := manifest.Layout.Fonts[0]
	if font.ID != familyID || font.Family != "Fixture Display" || len(font.Faces) != 1 {
		t.Fatalf("unexpected font entry %#v", font)
	}
	face := font.Faces[0]
	if face.AssetID != assetID || face.VariantID != variantID || face.WeightMin != 100 || face.WeightMax != 900 || face.UnicodeRange != "U+0000-00FF" {
		t.Fatalf("unexpected face %#v", face)
	}
	found := false
	for _, asset := range manifest.Assets {
		if asset.VariantID == variantID {
			found = asset.MIMEType == "font/woff2" && asset.DownloadPath == "/api/v1/player/assets/"+assetID.String()+"/variants/"+variantID.String()
		}
	}
	if !found {
		t.Fatalf("font file is not a verified manifest asset: %#v", manifest.Assets)
	}

	// A family removed after publication leaves the text on its bundled
	// fallback rather than blocking the screen's manifest.
	if _, err = f.pool.Exec(f.ctx, `UPDATE font_families SET deleted_at=now() WHERE id=$1`, familyID); err != nil {
		t.Fatal(err)
	}
	manifest, _, err = f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatalf("manifest failed after the family was removed: %v", err)
	}
	if manifest.Layout == nil || len(manifest.Layout.Fonts) != 0 {
		t.Fatalf("removed family still projected: %#v", manifest.Layout.Fonts)
	}
	if manifest.Layout.Document.Placements[0].Primitive.FontFamily != "Inter" {
		t.Fatal("bundled fallback family was lost")
	}
}

func TestLayoutDraftRejectsUnknownLibraryFont(t *testing.T) {
	f := setupCapabilityFixture(t)
	layoutsService := layouts.NewService(f.pool)
	layout, err := layoutsService.Create(f.ctx, f.user, "Unknown font layout", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	missing := uuid.New()
	if _, err = layoutsService.SaveDraft(f.ctx, layout.ID, f.user, layout.DraftRevision, fontTextLayout(&missing)); err == nil {
		t.Fatal("a draft referencing a missing library font was accepted")
	}
}
