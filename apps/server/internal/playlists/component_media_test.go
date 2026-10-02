package playlists

import (
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// syntheticMediaDefinition is a Widget using non-built-in media field names
// plus a nested media field, so media discovery cannot rely on a central
// list of configuration keys.
func syntheticMediaDefinition() contentdefs.WidgetDefinition {
	return contentdefs.WidgetDefinition{
		Source:   contentdefs.CoreSource(),
		ID:       "media-sampler",
		Version:  1,
		Name:     "Media sampler",
		Category: "Test",
		Runtime:  "native",
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "logoAssetId", Label: "Logo", Control: "media_asset", MediaTypes: []string{"image"}},
			{Key: "backgroundAssetId", Label: "Background", Control: "media_asset", MediaTypes: []string{"image"}},
			{Key: "artwork", Label: "Artwork", Control: "media_asset", MediaTypes: []string{"image"}},
			{Key: "slides", Label: "Slides", Control: "repeating_group", MaximumItems: 4, ItemFields: []contentdefs.FieldDefinition{
				{Key: "slideAssetId", Label: "Slide", Control: "media_asset", MediaTypes: []string{"image"}},
			}},
		}},
	}
}

func TestComponentMediaGrantsCustomAndNestedFields(t *testing.T) {
	definition := syntheticMediaDefinition()
	logoAsset, logoVariant := uuid.NewString(), uuid.NewString()
	slideAsset, slideVariant := uuid.NewString(), uuid.NewString()
	configuration := map[string]any{
		"logoAssetId":       logoAsset,
		"logoVariantId":     logoVariant,
		"backgroundAssetId": uuid.NewString(),
		"artwork":           uuid.NewString(),
		"artworkVariantId":  uuid.NewString(),
		"slides": []any{
			map[string]any{"slideAssetId": slideAsset, "slideVariantId": slideVariant},
			map[string]any{"slideAssetId": uuid.NewString()},
		},
	}
	media := componentMedia(definition, configuration)
	if len(media) != 2 {
		t.Fatalf("granted %d media pairs, want the logo and the projected slide: %+v", len(media), media)
	}
	if media[0].AssetID != logoAsset || media[0].VariantID != logoVariant {
		t.Fatalf("logo grant = %+v, want asset %s variant %s", media[0], logoAsset, logoVariant)
	}
	if media[1].AssetID != slideAsset || media[1].VariantID != slideVariant {
		t.Fatalf("slide grant = %+v, want asset %s variant %s", media[1], slideAsset, slideVariant)
	}
}
