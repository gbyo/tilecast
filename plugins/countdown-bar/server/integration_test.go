package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	countdownbar "github.com/tilecast/tilecast/plugins/countdown-bar"
	"github.com/tilecast/tilecast/plugins/countdown-bar/server"
)

const base = "/plugins/countdown-bar/instances"

// body is a complete instance document, as Studio and the CLI send it.
func body(name, scope string, ids []uuid.UUID, extra string) string {
	encoded, _ := json.Marshal(ids)
	if ids == nil {
		encoded = []byte("[]")
	}
	return fmt.Sprintf(`{"name":%q,"message":"Lunch ends in","scheduleType":"weekly","targetTime":"12:00","daysOfWeek":[5,1,3],
		"timezone":"America/New_York","leadTimeSeconds":900,"displayMode":"overlay","heightPx":72,"enabled":true,"priority":0,
		"targetScope":%q,"targetIds":%s%s}`, name, scope, encoded, extra)
}

func create(t *testing.T, h *pluginharness.Harness, document string) map[string]any {
	t.Helper()
	response := h.Serve("owner", http.MethodPost, base, document)
	if response.Status != http.StatusCreated {
		t.Fatalf("create = %d %s", response.Status, response.Body)
	}
	return response.Data()
}

func TestRoutesKeepTheirContractAndCheckRevisions(t *testing.T) {
	h := pluginharness.New(t, countdownbar.New())
	document := body("Lunch", "all", nil, "")
	if r := h.Serve("owner", http.MethodPost, base, document); r.Status != http.StatusConflict || r.ErrorCode() != "plugin_not_installed" {
		t.Fatalf("create before install = %+v", r)
	}
	h.Install()
	if r := h.Serve("editor", http.MethodPost, base, document); r.Status != http.StatusForbidden {
		t.Fatalf("editor create = %+v", r)
	}
	created := create(t, h, document)
	// Omitted fields take their schema defaults, as the old API did.
	if created["progressFill"] != "none" || created["contentPadding"] != float64(4) || created["textScale"] != float64(100) ||
		created["revision"] != float64(1) || created["kind"] != "instance" {
		t.Fatalf("create = %v", created)
	}
	if days, _ := json.Marshal(created["daysOfWeek"]); string(days) != "[1,3,5]" {
		t.Fatalf("days = %s", days)
	}
	id := created["id"].(string)
	if r := h.Serve("viewer", http.MethodGet, base, ""); r.Status != http.StatusOK || r.Data()["total"] != float64(1) {
		t.Fatalf("list = %+v", r)
	}
	if r := h.Serve("viewer", http.MethodGet, base+"/"+id, ""); r.Status != http.StatusOK || r.Data()["targetTime"] != "12:00" {
		t.Fatalf("get = %+v", r)
	}
	// An update must name the revision it read.
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Lunch", "all", nil, "")); r.Status != http.StatusPreconditionRequired || r.ErrorCode() != "expected_revision_required" {
		t.Fatalf("update without revision = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Renamed", "all", nil, `,"expectedRevision":1`)); r.Status != http.StatusOK || r.Data()["revision"] != float64(2) {
		t.Fatalf("update = %+v", r)
	}
	// A second editor still holding revision 1 changes nothing.
	stale := h.Serve("owner", http.MethodPut, base+"/"+id, body("Stale", "all", nil, `,"heightPx":200,"expectedRevision":1`))
	if stale.Status != http.StatusConflict || stale.ErrorCode() != "plugin_instance_revision_conflict" {
		t.Fatalf("stale update = %+v", stale)
	}
	if r := h.Serve("viewer", http.MethodGet, base+"/"+id, ""); r.Data()["name"] != "Renamed" || r.Data()["heightPx"] != float64(72) {
		t.Fatalf("a stale write changed the instance: %v", r.Data())
	}
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, `{"name":"","expectedRevision":2}`); r.Status != http.StatusBadRequest || r.ErrorCode() != "invalid_plugin_configuration" {
		t.Fatalf("invalid update = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Lunch", "all", nil, `,"unknown":1,"expectedRevision":2`)); r.Status != http.StatusBadRequest {
		t.Fatalf("unknown field = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Lunch", "all", nil, `,"urgentSeconds":400,"expectedRevision":2`)); r.Status != http.StatusBadRequest {
		t.Fatalf("the plugin's own rule was not applied: %+v", r)
	}
	if r := h.Serve("owner", http.MethodDelete, base+"/"+uuid.NewString(), ""); r.Status != http.StatusNotFound || r.ErrorCode() != "plugin_instance_not_found" {
		t.Fatalf("missing delete = %+v", r)
	}
	if r := h.Serve("owner", http.MethodDelete, base+"/"+id, ""); r.Status != http.StatusNoContent {
		t.Fatalf("delete = %+v", r)
	}
	if h.AuditCount("plugin.instance.created", id) != 1 || h.AuditCount("plugin.instance.updated", id) != 1 || h.AuditCount("plugin.instance.deleted", id) != 1 {
		t.Fatal("changes were not audited")
	}
}

func TestConcurrentEditorsOneWins(t *testing.T) {
	h := pluginharness.New(t, countdownbar.New())
	h.Install()
	id := create(t, h, body("Lunch", "all", nil, ""))["id"].(string)
	results := make(chan int, 2)
	for _, name := range []string{"First", "Second"} {
		go func(name string) {
			results <- h.Serve("owner", http.MethodPut, base+"/"+id, body(name, "all", nil, `,"expectedRevision":1`)).Status
		}(name)
	}
	statuses := map[int]int{}
	for range 2 {
		statuses[<-results]++
	}
	if statuses[http.StatusOK] != 1 || statuses[http.StatusConflict] != 1 {
		t.Fatalf("two editors from revision 1 = %v", statuses)
	}
	if r := h.Serve("viewer", http.MethodGet, base+"/"+id, ""); r.Data()["revision"] != float64(2) {
		t.Fatalf("revision after the race = %v", r.Data()["revision"])
	}
}

func TestTargetingProjectionAndInvalidation(t *testing.T) {
	h := pluginharness.New(t, countdownbar.New())
	location := h.Location("Cafeteria")
	targeted := h.Screen("Cafeteria", pluginharness.AtLocation(location))
	other := h.Screen("Lobby")
	group := h.SyncGroup("Lunch screens", targeted)
	h.Install()

	custom := create(t, h, body("Custom", plugin.TargetLocations, []uuid.UUID{location},
		`,"contentPadding":0,"textScale":175,"showConfetti":true,"urgencyEnabled":true,"startingSoonSeconds":480,"urgentSeconds":90,"pulseSeconds":15,"priority":7`))
	create(t, h, body("All screens", plugin.TargetAll, nil, ""))
	create(t, h, body("One screen", plugin.TargetScreens, []uuid.UUID{targeted}, ""))
	create(t, h, body("One group", plugin.TargetSyncGroups, []uuid.UUID{group}, ""))

	entries := h.Manifest(targeted)
	if len(entries) != 4 || entries[0].ID.String() != custom["id"] {
		t.Fatalf("targeted manifest (strongest first) = %#v", entries)
	}
	projected := entries[0].Config.(server.ManifestConfig)
	if projected.ContentPadding != 0 || projected.TextScale != 175 || !projected.ShowConfetti || projected.Priority != 7 ||
		!projected.UrgencyEnabled || projected.StartingSoonSeconds != 480 || projected.UrgentSeconds != 90 || projected.PulseSeconds != 15 {
		t.Fatalf("custom options not projected: %#v", projected)
	}
	if others := h.Manifest(other); len(others) != 1 || others[0].Config.(server.ManifestConfig).Name != "All screens" {
		t.Fatalf("untargeted manifest = %#v", others)
	}
	// A Player that hosts Plugin API 2 receives the same instances as state.
	states := h.PlayerState(targeted)
	if len(states) != len(entries) {
		t.Fatalf("v2 state = %d, v1 entries = %d", len(states), len(entries))
	}
	for index, state := range states {
		config, _ := json.Marshal(entries[index].Config)
		if state.Type != "plugin_state" || state.Plugin != "countdown_bar" || state.StateType != server.ManifestType ||
			state.StateVersion != 1 || state.ID != entries[index].ID || string(state.State) != string(config) {
			t.Fatalf("state %d = %#v\n%s", index, state, config)
		}
	}

	// A change to an instance revises only the screens it reaches.
	otherBefore, targetedBefore := h.ManifestVersion(other), h.ManifestVersion(targeted)
	id := custom["id"].(string)
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Custom", plugin.TargetLocations, []uuid.UUID{location}, `,"heightPx":90,"expectedRevision":1`)); r.Status != http.StatusOK {
		t.Fatalf("update = %+v", r)
	}
	if h.ManifestVersion(targeted) <= targetedBefore || h.ManifestVersion(other) != otherBefore {
		t.Fatal("an update revised a screen it does not reach, or missed one it does")
	}
	// Disabling removes it from the manifest.
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Custom", plugin.TargetLocations, []uuid.UUID{location}, `,"enabled":false,"expectedRevision":2`)); r.Status != http.StatusOK {
		t.Fatalf("disable = %+v", r)
	}
	for _, entry := range h.Manifest(targeted) {
		if entry.ID.String() == id {
			t.Fatal("a disabled instance reached the manifest")
		}
	}

	status := h.Status()
	if !status.Installed || !status.Configured || !status.Active || status.InstanceCount != 4 {
		t.Fatalf("status = %+v", status)
	}
	if err := h.Remove(); err == nil {
		t.Fatal("removal allowed while instances remain")
	}
	if r := h.Serve("viewer", http.MethodGet, base+"/"+id, ""); r.Status != http.StatusOK {
		t.Fatal("a refused removal lost data")
	}
}

func TestScopedOperatorCannotMoveABarOutOfScope(t *testing.T) {
	h := pluginharness.New(t, countdownbar.New())
	mine := h.Screen("Mine")
	theirs := h.Screen("Theirs")
	h.Install()
	operator := uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := h.Pool.Exec(h.Ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Scoped','scoped','unused','administrator',TRUE)`, operator)
	exec(`INSERT INTO user_content_access(user_id,library_mode,tag_mode) VALUES($1,'all','all')`, operator)
	exec(`INSERT INTO user_screen_access(user_id,mode) VALUES($1,'restricted')`, operator)
	exec(`INSERT INTO user_screen_scopes(user_id,scope_type,scope_id) VALUES($1,'group',$2)`, operator, h.SyncGroup("Mine", mine))

	if r := h.ServeAs(operator, "administrator", http.MethodPost, base, body("Theirs", plugin.TargetScreens, []uuid.UUID{theirs}, "")); r.Status != http.StatusForbidden || r.ErrorCode() != "out_of_scope" {
		t.Fatalf("create out of scope = %+v", r)
	}
	r := h.ServeAs(operator, "administrator", http.MethodPost, base, body("Mine", plugin.TargetScreens, []uuid.UUID{mine}, ""))
	if r.Status != http.StatusCreated {
		t.Fatalf("create in scope = %+v", r)
	}
	id := r.Data()["id"].(string)
	if r := h.ServeAs(operator, "administrator", http.MethodPut, base+"/"+id, body("Mine", plugin.TargetScreens, []uuid.UUID{theirs}, `,"expectedRevision":1`)); r.Status != http.StatusForbidden {
		t.Fatalf("moving the bar out of scope = %+v", r)
	}
	// An instance the operator cannot fully reach cannot be changed either.
	owned := create(t, h, body("Everywhere", plugin.TargetAll, nil, ""))["id"].(string)
	if r := h.ServeAs(operator, "administrator", http.MethodPut, base+"/"+owned, body("Mine", plugin.TargetScreens, []uuid.UUID{mine}, `,"expectedRevision":1`)); r.Status != http.StatusForbidden {
		t.Fatalf("narrowing a bar the operator cannot reach = %+v", r)
	}
}

func TestFontIsLibraryReferencedAndPlayerStateOnly(t *testing.T) {
	h := pluginharness.New(t, countdownbar.New())
	screen := h.Screen("Cafeteria")
	h.Install()
	font := h.Font("Lobster")
	if r := h.Serve("owner", http.MethodPost, base, body("Lunch", "all", nil, fmt.Sprintf(`,"fontId":%q`, uuid.NewString()))); r.Status != http.StatusBadRequest {
		t.Fatalf("an unknown font = %+v", r)
	}
	created := create(t, h, body("Lunch", "all", nil, fmt.Sprintf(`,"fontId":%q`, font)))
	if created["fontId"] != font.String() {
		t.Fatalf("created font = %v", created["fontId"])
	}
	if users := h.FontUsers(font); len(users) != 1 || users[0] != "Lunch" {
		t.Fatalf("the library does not know the bar uses the font: %v", users)
	}
	states := h.PlayerState(screen)
	if len(states) != 1 || len(states[0].Fonts) != 1 || states[0].Fonts[0].ID != font {
		t.Fatalf("state fonts = %#v", states)
	}
	var state map[string]any
	if err := json.Unmarshal(states[0].State, &state); err != nil || state["fontId"] != font.String() {
		t.Fatalf("state = %s (%v)", states[0].State, err)
	}
	entries := h.Manifest(screen)
	config, _ := json.Marshal(entries[0].Config)
	if strings.Contains(string(config), "fontId") {
		t.Fatalf("the v1 entry carries the font: %s", config)
	}
	id := created["id"].(string)
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Lunch", "all", nil, `,"fontId":null,"expectedRevision":1`)); r.Status != http.StatusOK {
		t.Fatalf("clear font = %+v", r)
	}
	if users := h.FontUsers(font); len(users) != 0 {
		t.Fatalf("an unused font is still referenced: %v", users)
	}
	if states = h.PlayerState(screen); len(states[0].Fonts) != 0 {
		t.Fatalf("state still declares a font: %#v", states[0].Fonts)
	}
	if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Lunch", "all", nil, fmt.Sprintf(`,"fontId":%q,"expectedRevision":2`, font))); r.Status != http.StatusOK {
		t.Fatalf("set font = %+v", r)
	}
	if r := h.Serve("owner", http.MethodDelete, base+"/"+id, ""); r.Status != http.StatusNoContent {
		t.Fatalf("delete = %+v", r)
	}
	if users := h.FontUsers(font); len(users) != 0 {
		t.Fatalf("a deleted bar still holds the font: %v", users)
	}
}

func TestDemoSeedUsesTheHostInstanceService(t *testing.T) {
	p := countdownbar.New()
	h := pluginharness.New(t, p)
	school := h.Location("High School")
	if err := h.SeedDemo(plugin.Demo{Scenario: "district", OwnerID: h.OwnerID, Timezone: "America/Chicago",
		Locations: map[string]uuid.UUID{"high_school": school}}); err != nil {
		t.Fatal(err)
	}
	r := h.Serve("viewer", http.MethodGet, base, "")
	items := r.Data()["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["targetScope"] != plugin.TargetLocations {
		t.Fatalf("seeded = %+v", r.Data())
	}
}

// A write resolves host facts before its transaction. With one pooled
// connection, a pool read inside the transaction would wait forever on the
// connection the transaction holds.
func TestWritesNeedOnlyOneConnection(t *testing.T) {
	h := pluginharness.New(t, countdownbar.New(), pluginharness.MaxConnections(1))
	h.Install()
	done := make(chan struct{})
	go func() {
		defer close(done)
		id := create(t, h, body("Lunch", "all", nil, ""))["id"].(string)
		if r := h.Serve("owner", http.MethodPut, base+"/"+id, body("Lunch", "all", nil, `,"expectedRevision":1`)); r.Status != http.StatusOK {
			t.Errorf("update with one connection = %+v", r)
		}
		if r := h.Serve("owner", http.MethodDelete, base+"/"+id, ""); r.Status != http.StatusNoContent {
			t.Errorf("delete with one connection = %+v", r)
		}
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("a write waited on its own connection")
	}
}
