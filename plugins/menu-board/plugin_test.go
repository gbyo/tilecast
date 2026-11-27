package menuboard_test

import (
	"testing"

	menuboard "github.com/tilecast/tilecast/plugins/menu-board"
)

func TestManifestReadsOnlyAndKeepsPricesUpstream(t *testing.T) {
	manifest := menuboard.New().Manifest()
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	square, _ := manifest.ConnectionByID("square")
	images, _ := manifest.ConnectionByID("square_images")
	if len(square.OAuth.Scopes) != 1 || square.OAuth.Scopes[0] != "ITEMS_READ" || images.IsOAuth() {
		t.Fatalf("connections = %+v %+v", square.OAuth, images)
	}
	feed, _ := manifest.FeedByID("items")
	policies := map[string]string{}
	for _, field := range feed.Fields {
		policies[field.Key] = field.OverridePolicy()
	}
	for field, want := range map[string]string{"providerId": "upstream", "price": "upstream", "available": "upstream", "currency": "upstream",
		"name": "local_until_changed", "shortLabel": "local", "order": "local", "visible": "local", "photo": "upstream"} {
		if policies[field] != want {
			t.Errorf("%s policy = %s, want %s", field, policies[field], want)
		}
	}
}
