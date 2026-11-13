package backup

import "testing"

func TestBackupComponentsExcludePlayerUpdateArtifacts(t *testing.T) {
	components := backupComponents("/media")
	if len(components) != 3 {
		t.Fatalf("backup components = %d, want 3 durable media components", len(components))
	}
	for _, component := range components {
		if component.name == ComponentPlayerUpdates || component.prefix == updatesPrefix {
			t.Fatalf("cached Player updates must not be archived: %+v", component)
		}
	}
}

func TestManifestHasPlayerUpdateArtifacts(t *testing.T) {
	empty := Manifest{Components: []ManifestComponent{{Name: ComponentPlayerUpdates}}}
	if manifestHasPlayerUpdateArtifacts(empty) {
		t.Fatal("empty player_updates component should not report archived artifacts")
	}

	legacy := Manifest{Components: []ManifestComponent{{
		Name:      ComponentPlayerUpdates,
		FileCount: 1,
	}}}
	if !manifestHasPlayerUpdateArtifacts(legacy) {
		t.Fatal("legacy backup with player update files should report archived artifacts")
	}
}
