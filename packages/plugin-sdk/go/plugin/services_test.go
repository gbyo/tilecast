package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The vocabulary is canonical in packages/plugin-sdk/player-services.json.
// TypeScript and Player Core replay the same file.
func TestPlayerServicesMirrorCanonicalFile(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "player-services.json"))
	if err != nil {
		t.Fatal(err)
	}
	var canonical struct {
		SchemaVersion int `json:"schemaVersion"`
		Host          struct {
			Capability string `json:"capability"`
			Version    int    `json:"version"`
		} `json:"host"`
		Services []PlayerService `json:"services"`
	}
	if err := json.Unmarshal(data, &canonical); err != nil {
		t.Fatal(err)
	}
	if canonical.SchemaVersion != 1 || canonical.Host.Capability != PlayerPluginHostCapability || canonical.Host.Version != PlayerPluginHostVersion {
		t.Fatalf("host capability drifted: %+v", canonical.Host)
	}
	if !reflect.DeepEqual(canonical.Services, PlayerServices) {
		t.Fatalf("service vocabulary drifted:\n%+v\n%+v", canonical.Services, PlayerServices)
	}
}

func TestServiceReferences(t *testing.T) {
	reference, ok := ParseServiceReference("player.presentation.observe@1")
	if !ok || reference.Name != "player.presentation.observe" || reference.Version != 1 {
		t.Fatalf("parse: %+v %v", reference, ok)
	}
	for _, bad := range []string{"player.clock", "clock@1", "player.clock@0", "@1"} {
		if _, ok := ParseServiceReference(bad); ok {
			t.Fatalf("%s parsed", bad)
		}
	}
	if problem := ServiceReferenceProblem(ServiceReference{"player.surface", 1}, ServiceNative); problem == "" {
		t.Fatal("a native contribution requested a runtime service")
	}
	if !ServicesAvailable(map[string]int{"player.clock": 2}, []string{"player.clock@1"}) {
		t.Fatal("a higher reported version must satisfy a lower request")
	}
	if ServicesAvailable(map[string]int{"player.clock": 1}, []string{"player.clock@1", "player.surface@1"}) {
		t.Fatal("a missing service was reported available")
	}
}
