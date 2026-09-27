package widgets

import (
	"encoding/json"
	"testing"
)

func TestManifestsEmbedEveryWidget(t *testing.T) {
	manifests, err := Manifests()
	if err != nil {
		t.Fatal(err)
	}
	if len(manifests) == 0 {
		t.Fatal("no Widget manifests embedded")
	}
	for _, manifest := range manifests {
		var decoded struct {
			ID        string `json:"id"`
			Component struct {
				Type string `json:"type"`
			} `json:"component"`
		}
		if err := json.Unmarshal(manifest.JSON, &decoded); err != nil {
			t.Fatalf("%s: %v", manifest.Dir, err)
		}
		if decoded.ID == "" || decoded.Component.Type == "" {
			t.Fatalf("%s: manifest lacks an id or component type", manifest.Dir)
		}
	}
}
