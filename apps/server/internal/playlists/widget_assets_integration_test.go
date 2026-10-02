package playlists

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func insertReadyImageForMediaTest(t *testing.T, f *capabilityFixture) (assetID, variantID uuid.UUID) {
	t.Helper()
	assetID, variantID = uuid.New(), uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by)VALUES($1,$2,'Sampler image','image','sampler.png','image/png',$3,100,1920,1080,'ready',$4)`, assetID, f.org, make([]byte, 32), f.user); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible)VALUES($1,$2,'playback','local',$3,'image/png',100,$4,1920,1080,TRUE)`, variantID, assetID, "variants/"+assetID.String(), make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	return assetID, variantID
}

func samplerCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	definition := syntheticMediaDefinition()
	definition.DefaultConfiguration = map[string]any{}
	definition.PresentationSchemaVersion = 1
	definition.RequiredCapabilities = map[string]int{"layout.surface": 1, "content.asset_image": 2}
	definition.PresentationTemplate = json.RawMessage(`{"type":"surface","children":[{"type":"asset_image","props":{"variantId":{"$config":"logoVariantId"},"fit":"cover"}}]}`)
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{definition}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestProjectWidgetAssetsProjectsCustomMediaFields(t *testing.T) {
	f := setupCapabilityFixture(t)
	logoAsset, logoVariant := insertReadyImageForMediaTest(t, f)
	backgroundAsset, backgroundVariant := insertReadyImageForMediaTest(t, f)
	artworkAsset, artworkVariant := insertReadyImageForMediaTest(t, f)
	slideAsset, slideVariant := insertReadyImageForMediaTest(t, f)
	f.service.SetContentDefinitions(samplerCatalog(t))

	configuration, _ := json.Marshal(map[string]any{
		"logoAssetId":       logoAsset.String(),
		"backgroundAssetId": backgroundAsset.String(),
		"artwork":           artworkAsset.String(),
		"slides":            []any{map[string]any{"slideAssetId": slideAsset.String()}},
	})
	widget := ManifestWidget{Provider: "media-sampler", Configuration: configuration}
	manifest := &Manifest{}
	if err := f.service.projectWidgetAssets(f.ctx, manifest, &widget, map[uuid.UUID]bool{}); err != nil {
		t.Fatal(err)
	}
	var projected map[string]any
	if err := json.Unmarshal(widget.Configuration, &projected); err != nil {
		t.Fatal(err)
	}
	if projected["logoVariantId"] != logoVariant.String() {
		t.Fatalf("logoVariantId = %v, want %s", projected["logoVariantId"], logoVariant)
	}
	if projected["backgroundVariantId"] != backgroundVariant.String() {
		t.Fatalf("backgroundVariantId = %v, want %s", projected["backgroundVariantId"], backgroundVariant)
	}
	if projected["artworkVariantId"] != artworkVariant.String() {
		t.Fatalf("artworkVariantId = %v, want %s", projected["artworkVariantId"], artworkVariant)
	}
	items, _ := projected["slides"].([]any)
	if len(items) != 1 {
		t.Fatalf("slides projected to %v", projected["slides"])
	}
	slide, _ := items[0].(map[string]any)
	if slide["slideVariantId"] != slideVariant.String() {
		t.Fatalf("slideVariantId = %v, want %s", slide["slideVariantId"], slideVariant)
	}
	if len(manifest.Assets) != 4 {
		t.Fatalf("manifest carries %d assets, want one variant per field", len(manifest.Assets))
	}
}

func TestProjectWidgetAssetsKeepsLegacyPairs(t *testing.T) {
	f := setupCapabilityFixture(t)
	assetID, variantID := insertReadyImageForMediaTest(t, f)

	configuration, _ := json.Marshal(map[string]any{"imageAssetId": assetID.String()})
	widget := ManifestWidget{Provider: "spotlight", Configuration: configuration}
	manifest := &Manifest{}
	if err := f.service.projectWidgetAssets(f.ctx, manifest, &widget, map[uuid.UUID]bool{}); err != nil {
		t.Fatal(err)
	}
	var projected map[string]any
	if err := json.Unmarshal(widget.Configuration, &projected); err != nil {
		t.Fatal(err)
	}
	if projected["imageVariantId"] != variantID.String() {
		t.Fatalf("legacy imageVariantId = %v, want %s", projected["imageVariantId"], variantID)
	}

	broken, _ := json.Marshal(map[string]any{"imageAssetId": "not-a-uuid"})
	widget = ManifestWidget{Provider: "spotlight", Configuration: broken}
	err := f.service.projectWidgetAssets(f.ctx, &Manifest{}, &widget, map[uuid.UUID]bool{})
	if err == nil || !strings.Contains(err.Error(), "widget image") {
		t.Fatalf("legacy invalid reference err = %v, want the historical label", err)
	}
}
