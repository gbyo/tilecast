package samplefeeds

import "testing"

func TestManifestIsValid(t *testing.T) {
	if err := New().Manifest().Validate(); err != nil {
		t.Fatal(err)
	}
}
