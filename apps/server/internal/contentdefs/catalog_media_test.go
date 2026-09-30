package contentdefs

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDerivedVariantKey(t *testing.T) {
	cases := []struct {
		assetKey string
		variant  string
		ok       bool
	}{
		{"imageAssetId", "imageVariantId", true},
		{"logoAssetId", "logoVariantId", true},
		{"backgroundAssetId", "backgroundVariantId", true},
		{"artwork", "", false},
		{"AssetId", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		variant, ok := DerivedVariantKey(tc.assetKey)
		if variant != tc.variant || ok != tc.ok {
			t.Fatalf("DerivedVariantKey(%q) = (%q, %v), want (%q, %v)", tc.assetKey, variant, ok, tc.variant, tc.ok)
		}
	}
}

func TestValidateTemplateAcceptsSchemaDerivedVariants(t *testing.T) {
	schema := ConfigurationSchema{Fields: []FieldDefinition{
		{Key: "logoAssetId", Label: "Logo", Control: "media_asset"},
		{Key: "backgroundAssetId", Label: "Background", Control: "media_asset"},
	}}
	capabilities := map[string]int{"layout.surface": 1, "content.asset_image": 2}
	custom := `{"type":"surface","children":[{"type":"asset_image","props":{"variantId":{"$config":"logoVariantId"}}},{"type":"asset_image","props":{"variantId":{"$config":"backgroundVariantId"}}}]}`
	if err := validateTemplate(json.RawMessage(custom), schema, capabilities); err != nil {
		t.Fatalf("template referencing schema-derived variants was refused: %v", err)
	}
	bogus := `{"type":"surface","children":[{"type":"asset_image","props":{"variantId":{"$config":"bogusVariantId"}}}]}`
	err := validateTemplate(json.RawMessage(bogus), schema, capabilities)
	if err == nil || !strings.Contains(err.Error(), "bogusVariantId") {
		t.Fatalf("template referencing an unknown key was accepted, err=%v", err)
	}
}
