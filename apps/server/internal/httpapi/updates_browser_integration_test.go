package httpapi

import (
	"testing"

	"github.com/google/uuid"
)

// Browser Player has no native updater. Whatever family a native release
// carries, a Browser Screen is never one of its targets, even when it is
// named explicitly and even when its heartbeat claims another family.
func TestNativeReleasesNeverTargetBrowserScreens(t *testing.T) {
	f := newEdgeFixture(t)
	browser := f.screen(t, "Browser Lobby", "browser", "browser", "", 1)
	impostor := f.screen(t, "Browser claiming Electron", "browser", "electron-linux", "", 1)
	electron := f.screen(t, "Electron Lobby", "linux", "electron-linux", "", 1)
	windows := f.screen(t, "Windows Kiosk", "windows", "windows", "x86_64", 1000)
	edge := f.screen(t, "Edge Lobby", "linux", "edge", "x86_64", 1000)

	electronRelease := f.electronRelease(t)
	for name, release := range map[string]uuid.UUID{
		"electron": electronRelease,
		"windows":  f.windowsRelease(t, "x86_64"),
		"edge":     f.edgeRelease(t, "x86_64"),
	} {
		deployment, _ := f.deploy(t, release, browser, impostor, electron, windows, edge)
		if deployment == uuid.Nil {
			t.Fatalf("%s release: the native screens in the request must still deploy", name)
		}
		for _, screen := range []uuid.UUID{browser, impostor} {
			if got := f.state(t, deployment, screen); got != "not_targeted" {
				t.Fatalf("%s release reached a Browser Screen: state %q", name, got)
			}
		}
	}
	// A request naming only Browser Screens has no target to deploy to.
	if id, _ := f.deploy(t, electronRelease, browser, impostor); id != uuid.Nil {
		t.Fatal("a native release with only Browser targets must be refused")
	}
}
