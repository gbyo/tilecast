package main

import (
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestReleaseReservedIdentities(t *testing.T) {
	release := contentdefs.MustLoad()
	reserved := releaseReservedIdentities(release)
	if len(release.Widgets) == 0 || len(release.DataSources) == 0 {
		t.Fatal("release catalog is empty")
	}
	if _, ok := reserved("widget", release.Widgets[0].ID); !ok {
		t.Fatalf("release Widget %q is not reserved", release.Widgets[0].ID)
	}
	if _, ok := reserved("dataSource", release.DataSources[0].ID); !ok {
		t.Fatalf("release Data Source %q is not reserved", release.DataSources[0].ID)
	}
	// A package's own qualified contributions live in the effective
	// catalog, never the release catalog, so they are never reserved.
	if why, ok := reserved("widget", "acme.athletics.scoreboard"); ok {
		t.Fatalf("package contribution reserved: %s", why)
	}
	if why, ok := reserved("dataSource", "acme.athletics.schedule"); ok {
		t.Fatalf("package contribution reserved: %s", why)
	}
}
