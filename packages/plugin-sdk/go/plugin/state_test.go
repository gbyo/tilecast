package plugin

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func v2Manifest(t *testing.T) Manifest {
	t.Helper()
	m, err := ParseManifest([]byte(`{
		"apiVersion": 2, "id": "sample_v2", "definitionVersion": 3, "name": "Sample",
		"description": "Fixture.", "category": "Display", "icon": "puzzle",
		"maintainers": ["@gbyo"], "instanceNoun": {"singular": "item", "plural": "items"},
		"server": {"entrypoint": "./plugin.go"},
		"player": {"state": [{"type": "sample_notice", "version": 1}],
			"runtime": {"entrypoint": "./runtime/index.ts", "services": {"required": ["player.clock@1"]}}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestEncodePlayerStateWrapsDeclaredState(t *testing.T) {
	m := v2Manifest(t)
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	until := now.Add(time.Hour)
	id, asset, variant := uuid.New(), uuid.New(), uuid.New()
	entries, err := EncodePlayerState(m, []PlayerState{{
		ID: id, Type: "sample_notice", Version: 1, State: map[string]any{"text": "Hello"},
		Media: []MediaRef{{AssetID: asset, VariantID: variant}}, ValidUntil: &until,
	}}, now)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(entries[0])
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["type"] != "plugin_state" || wire["version"].(float64) != 1 || wire["plugin"] != "sample_v2" ||
		wire["definitionVersion"].(float64) != 3 || wire["stateType"] != "sample_notice" ||
		wire["stateVersion"].(float64) != 1 || wire["validUntil"] != "2026-10-14T13:00:00Z" {
		t.Fatalf("unexpected wire entry: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"state":{"text":"Hello"}`) {
		t.Fatalf("state not embedded as an object: %s", encoded)
	}
}

func TestEncodePlayerStateRefusesUndeclaredOrUnboundedState(t *testing.T) {
	m := v2Manifest(t)
	now := time.Now()
	deep := map[string]any{}
	cursor := deep
	for range 20 {
		next := map[string]any{}
		cursor["n"] = next
		cursor = next
	}
	far := now.Add(2 * MaxPlayerStateLifetime)
	id := uuid.New()
	for name, states := range map[string][]PlayerState{
		"undeclared type":    {{ID: uuid.New(), Type: "other", Version: 1, State: map[string]any{}}},
		"undeclared version": {{ID: uuid.New(), Type: "sample_notice", Version: 2, State: map[string]any{}}},
		"not an object":      {{ID: uuid.New(), Type: "sample_notice", Version: 1, State: []int{1}}},
		"too deep":           {{ID: uuid.New(), Type: "sample_notice", Version: 1, State: deep}},
		"too large":          {{ID: uuid.New(), Type: "sample_notice", Version: 1, State: map[string]any{"x": strings.Repeat("a", MaxPlayerStateBytes)}}},
		"nil id":             {{Type: "sample_notice", Version: 1, State: map[string]any{}}},
		"duplicate id":       {{ID: id, Type: "sample_notice", Version: 1, State: map[string]any{}}, {ID: id, Type: "sample_notice", Version: 1, State: map[string]any{}}},
		"too long valid":     {{ID: uuid.New(), Type: "sample_notice", Version: 1, State: map[string]any{}, ValidUntil: &far}},
		"empty media":        {{ID: uuid.New(), Type: "sample_notice", Version: 1, State: map[string]any{}, Media: []MediaRef{{}}}},
		"empty font":         {{ID: uuid.New(), Type: "sample_notice", Version: 1, State: map[string]any{}, Fonts: []uuid.UUID{uuid.Nil}}},
		"too many fonts": {{ID: uuid.New(), Type: "sample_notice", Version: 1, State: map[string]any{},
			Fonts: []uuid.UUID{uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()}}},
	} {
		if _, err := EncodePlayerState(m, states, now); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestEncodePlayerStateDeclaresFontFamiliesOnce(t *testing.T) {
	m := v2Manifest(t)
	font := uuid.New()
	entries, err := EncodePlayerState(m, []PlayerState{{
		ID: uuid.New(), Type: "sample_notice", Version: 1, State: map[string]any{},
		Fonts: []uuid.UUID{font, font},
	}, {
		ID: uuid.New(), Type: "sample_notice", Version: 1, State: map[string]any{},
	}}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries[0].Fonts) != 1 || entries[0].Fonts[0].ID != font {
		t.Fatalf("a repeated family must be declared once: %+v", entries[0].Fonts)
	}
	encoded, err := json.Marshal(entries[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"fonts"`) {
		t.Fatalf("an entry without fonts must not carry the key: %s", encoded)
	}
}
