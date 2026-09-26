package server_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	countdownbar "github.com/tilecast/tilecast/plugins/countdown-bar"
	"github.com/tilecast/tilecast/plugins/countdown-bar/server"
)

func input() server.Input {
	target := "12:00"
	padding := 4
	return server.Input{
		Name: "Lunch", Message: "Lunch ends in", ScheduleType: "weekly",
		TargetTime: &target, DaysOfWeek: []int{1, 2, 3, 4, 5},
		Timezone: "America/New_York", LeadTimeSeconds: 900,
		DisplayMode: "overlay", HeightPX: 72, ProgressFill: "none",
		ContentPadding: &padding, TextScale: 100, Enabled: true,
		StartingSoonSeconds: 300, UrgentSeconds: 60, PulseSeconds: 10,
		TargetScope: "all", TargetIDs: []uuid.UUID{},
	}
}

func TestLifecycleTargetingAndManifest(t *testing.T) {
	p := countdownbar.New().(*server.Plugin)
	h := pluginharness.New(t, p)
	location := h.Location("Cafeteria")
	targeted := h.Screen("Cafeteria", pluginharness.AtLocation(location))
	other := h.Screen("Lobby")
	group := h.SyncGroup("Lunch screens", targeted)

	// Configuration waits for installation rather than installing implicitly.
	if _, err := p.Create(h.Ctx, h.OwnerID, input()); !errors.Is(err, plugin.ErrNotInstalled) {
		t.Fatalf("create before install = %v", err)
	}
	h.Install()

	custom := input()
	zero := 0
	custom.ContentPadding = &zero
	custom.TextScale = 175
	custom.ShowConfetti = true
	custom.UrgencyEnabled = true
	custom.StartingSoonSeconds = 480
	custom.UrgentSeconds = 90
	custom.PulseSeconds = 15
	custom.TargetScope = plugin.TargetLocations
	custom.TargetIDs = []uuid.UUID{location}
	created, err := p.Create(h.Ctx, h.OwnerID, custom)
	if err != nil {
		t.Fatal(err)
	}
	if h.AuditCount("plugin.countdown_bar.created", created.ID.String()) != 1 {
		t.Fatal("create was not audited")
	}
	for _, target := range []struct {
		name  string
		scope string
		ids   []uuid.UUID
	}{
		{"All screens", plugin.TargetAll, nil},
		{"One screen", plugin.TargetScreens, []uuid.UUID{targeted}},
		{"One group", plugin.TargetSyncGroups, []uuid.UUID{group}},
	} {
		additional := input()
		additional.Name, additional.TargetScope, additional.TargetIDs = target.name, target.scope, target.ids
		if _, err = p.Create(h.Ctx, h.OwnerID, additional); err != nil {
			t.Fatal(err)
		}
	}

	entries := h.Manifest(targeted)
	if len(entries) != 4 {
		t.Fatalf("targeted manifest = %#v", entries)
	}
	var projected *server.ManifestConfig
	for _, entry := range entries {
		if entry.Type != server.ManifestType || entry.Version != 1 {
			t.Fatalf("entry %#v", entry)
		}
		if config := entry.Config.(server.ManifestConfig); entry.ID == created.ID {
			projected = &config
		}
	}
	if projected == nil || projected.ContentPadding != 0 || projected.TextScale != 175 || !projected.ShowConfetti ||
		!projected.UrgencyEnabled || projected.StartingSoonSeconds != 480 || projected.UrgentSeconds != 90 || projected.PulseSeconds != 15 {
		t.Fatalf("custom options not projected: %#v", projected)
	}
	if others := h.Manifest(other); len(others) != 1 || others[0].Config.(server.ManifestConfig).Name != "All screens" {
		t.Fatalf("untargeted manifest = %#v", others)
	}

	// A disabled instance leaves the manifest; every change revises it.
	before := h.ManifestVersion(other)
	created.Enabled = false
	created.ScheduleType, created.TargetTime, created.DaysOfWeek = "one_time", nil, nil
	at := time.Now().UTC().Add(time.Hour)
	created.OneTimeAt = &at
	if _, err = p.Update(h.Ctx, created.ID, h.OwnerID, created.Input); err != nil {
		t.Fatal(err)
	}
	for _, entry := range h.Manifest(targeted) {
		if entry.ID == created.ID {
			t.Fatal("disabled instance leaked into the manifest")
		}
	}
	if h.ManifestVersion(other) <= before {
		t.Fatal("an update did not revise manifests")
	}

	status := h.Status()
	if !status.Installed || !status.Configured || !status.Active || status.InstanceCount != 4 {
		t.Fatalf("status = %+v", status)
	}

	// Removal is refused while instances remain and deletes nothing.
	if err = h.Remove(); err == nil {
		t.Fatal("removal allowed while instances remain")
	}
	if _, err = p.Get(h.Ctx, created.ID); err != nil {
		t.Fatalf("a refused removal lost data: %v", err)
	}
	if err = p.Delete(h.Ctx, created.ID, h.OwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err = p.Get(h.Ctx, created.ID); !errors.Is(err, plugin.ErrNotFound) {
		t.Fatalf("deleted instance = %v", err)
	}
}

// The HTTP contract is the one in api/openapi.yaml and the one Studio uses.
func TestRoutes(t *testing.T) {
	h := pluginharness.New(t, countdownbar.New())
	body := `{"name":"Lunch","message":"Lunch ends in","scheduleType":"weekly","targetTime":"12:00","daysOfWeek":[1],
		"timezone":"UTC","leadTimeSeconds":900,"completionText":"","showConfetti":false,"displayMode":"overlay","heightPx":72,
		"urgencyEnabled":false,"startingSoonSeconds":300,"urgentSeconds":60,"pulseSeconds":10,"enabled":true,"priority":0,
		"targetScope":"all","targetIds":[]}`
	if r := h.Serve("owner", http.MethodPost, "/plugins/countdown-bar/instances", body); r.Status != http.StatusConflict || r.ErrorCode() != "plugin_not_installed" {
		t.Fatalf("create before install = %+v", r)
	}
	h.Install()
	if r := h.Serve("editor", http.MethodPost, "/plugins/countdown-bar/instances", body); r.Status != http.StatusForbidden {
		t.Fatalf("editor create = %+v", r)
	}
	created := h.Serve("owner", http.MethodPost, "/plugins/countdown-bar/instances", body)
	if created.Status != http.StatusCreated || created.Data()["progressFill"] != "none" || created.Data()["contentPadding"] != float64(4) {
		t.Fatalf("create = %+v", created)
	}
	id := created.Data()["id"].(string)
	if r := h.Serve("viewer", http.MethodGet, "/plugins/countdown-bar/instances", ""); r.Status != http.StatusOK || r.Data()["total"] != float64(1) {
		t.Fatalf("list = %+v", r)
	}
	if r := h.Serve("viewer", http.MethodGet, "/plugins/countdown-bar/instances/"+id, ""); r.Status != http.StatusOK || r.Data()["targetTime"] != "12:00" {
		t.Fatalf("get = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, "/plugins/countdown-bar/instances/"+id, `{"name":""}`); r.Status != http.StatusBadRequest || r.ErrorCode() != "invalid_plugin_configuration" {
		t.Fatalf("invalid update = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, "/plugins/countdown-bar/instances/"+id, `{"unknown":1}`); r.Status != http.StatusBadRequest || r.ErrorCode() != "invalid_request" {
		t.Fatalf("unknown field = %+v", r)
	}
	if r := h.Serve("owner", http.MethodDelete, "/plugins/countdown-bar/instances/"+uuid.NewString(), ""); r.Status != http.StatusNotFound || r.ErrorCode() != "plugin_instance_not_found" {
		t.Fatalf("missing delete = %+v", r)
	}
	if r := h.Serve("owner", http.MethodDelete, "/plugins/countdown-bar/instances/"+id, ""); r.Status != http.StatusNoContent {
		t.Fatalf("delete = %+v", r)
	}
}

func TestDemoSeed(t *testing.T) {
	p := countdownbar.New().(*server.Plugin)
	h := pluginharness.New(t, p)
	school := h.Location("High School")
	h.Install()
	if err := p.SeedDemo(h.Ctx, plugin.Demo{Scenario: "district", OwnerID: h.OwnerID, Timezone: "America/Chicago",
		Locations: map[string]uuid.UUID{"high_school": school}}); err != nil {
		t.Fatal(err)
	}
	items, err := p.List(h.Ctx)
	if err != nil || len(items) != 1 || items[0].TargetScope != plugin.TargetLocations || len(items[0].TargetIDs) != 1 {
		t.Fatalf("seeded = %+v, %v", items, err)
	}
}

// A write resolves host facts before its transaction. With one pooled
// connection, a pool read inside the transaction would wait forever on the
// connection the transaction holds.
func TestWritesNeedOnlyOneConnection(t *testing.T) {
	p := countdownbar.New().(*server.Plugin)
	h := pluginharness.New(t, p, pluginharness.MaxConnections(1))
	h.Install()
	ctx, cancel := context.WithTimeout(h.Ctx, 10*time.Second)
	defer cancel()
	created, err := p.Create(ctx, h.OwnerID, input())
	if err != nil {
		t.Fatalf("create with one connection: %v", err)
	}
	if _, err = p.Update(ctx, created.ID, h.OwnerID, input()); err != nil {
		t.Fatalf("update with one connection: %v", err)
	}
	if err = p.Delete(ctx, created.ID, h.OwnerID); err != nil {
		t.Fatalf("delete with one connection: %v", err)
	}
}
