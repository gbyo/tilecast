package sampleconnections

import "testing"

func TestManifestIsValid(t *testing.T) {
	manifest := New().Manifest()
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Connections) != 8 {
		t.Fatalf("connections = %d", len(manifest.Connections))
	}
}
