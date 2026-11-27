package playlists

import (
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// A plugin feed is projected into the ordinary Data Document: no new
// protocol, the feed's fields typed as declared, and an imported image as an
// asset value.
func TestFeedPayloadProjectsToTheDataDocument(t *testing.T) {
	payload, _ := json.Marshal(plugin.TypedDatasetPayload{Datasets: []plugin.TypedDataset{{
		ID: "items", Kind: "records",
		Fields: []plugin.DataSourceField{{Key: "name", Label: "Name", Type: "text"}, {Key: "price", Label: "Price", Type: "number"},
			{Key: "available", Label: "Available", Type: "boolean"}, {Key: "photo", Label: "Photo", Type: "asset"}},
		Records: []plugin.TypedRecord{
			{ID: "a", Values: map[string]string{"name": "Tea", "price": "3.5", "available": "true", "photo": "0b6a2a1e-63e2-4f43-9d3f-6cc9b8a64c7e"}},
			{ID: "b", Values: map[string]string{"name": "Cake", "price": "", "available": "false", "photo": ""}},
		},
	}}})
	document, err := projectDataDocument(payload)
	if err != nil {
		t.Fatal(err)
	}
	dataset := document.Datasets[0]
	a, b := dataset.Records[0].Values, dataset.Records[1].Values
	if dataset.ID != "items" || dataset.Kind != "records" || *a["price"].Number != 3.5 || !*a["available"].Boolean ||
		a["photo"].Kind != "asset" || *a["photo"].AssetID != "0b6a2a1e-63e2-4f43-9d3f-6cc9b8a64c7e" || b["photo"].Kind != "null" || b["price"].Kind != "null" {
		t.Fatalf("document = %+v", dataset)
	}
}
