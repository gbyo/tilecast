package services

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/managedpresentations"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/apps/server/internal/takeovers"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// These tests run the dispatcher against real domain services on a
// temporary database: reads return domain data, mutations commit
// through canonical services with audit rows, and package ownership
// isolates managed presentations. They skip without TEST_DATABASE_URL.

type serviceFixture struct {
	pool       *pgxpool.Pool
	dispatcher *Dispatcher
	ownerID    uuid.UUID
	viewerID   uuid.UUID
}

func newServiceFixture(t *testing.T) *serviceFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7422001)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7422001)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	f := &serviceFixture{pool: pool, ownerID: uuid.New(), viewerID: uuid.New()}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Service Test',$1)`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','service-owner','unused','owner',TRUE),($2,'Viewer','service-viewer','unused','viewer',TRUE)`, f.ownerID, f.viewerID); err != nil {
		t.Fatal(err)
	}
	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "https://tilecast.test")
	playlistService := playlists.NewService(pool, deviceService)
	takeoverService := takeovers.NewService(pool, playlistService, deviceService, 24*time.Hour)
	managedService := managedpresentations.NewService(pool)
	schedulingService := scheduling.NewService(pool, deviceService, scheduling.Limits{MaxSchedules: 100, MaxTargetsPerSchedule: 100, MaxGroupsPerScreen: 10, PrefetchDays: 7, ActivationGraceSeconds: 60, ClockSkewWarningSeconds: 300})
	settingsService := settings.NewService(pool, deviceService, settings.HardLimits{})
	pluginService := plugins.NewService(pool, deviceService,
		plugins.WithTakeovers(takeoverService),
		plugins.WithManagedPresentations(managedService),
		plugins.WithScreens(deviceService),
		plugins.WithPublicURL("https://tilecast.test"),
		plugins.WithPublicVersion("9.9.9-test"),
	)
	f.dispatcher = NewDispatcher(Dependencies{
		DB: pool, Devices: deviceService, Playlists: playlistService,
		Layouts: layouts.NewService(pool), Media: media.NewService(pool, nil, media.Config{}),
		Scheduling: schedulingService, Takeovers: takeoverService, Managed: managedService,
		Settings: settingsService, Shared: pluginService.Shared(),
		Limits: Limits{MaxTakeoverTargets: 250},
	})
	return f
}

type callResult struct {
	data    any
	denial  *Denial
	failure *CallError
}

func (f *serviceFixture) background(packageID, capability, operation string, input any) callResult {
	raw, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	data, denial, failure := f.dispatcher.Call(context.Background(), Call{
		PackageID: packageID, Context: ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: capability, Version: 1}},
		Operation: operation, Input: raw,
	})
	return callResult{data: data, denial: denial, failure: failure}
}

func (f *serviceFixture) studio(userID uuid.UUID, role, packageID, capability, operation string, input any) callResult {
	raw, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	data, denial, failure := f.dispatcher.Call(context.Background(), Call{
		PackageID: packageID, Context: ContextStudio, Actor: &Actor{UserID: userID, Role: role},
		Grants:    []packagemanifest.ServiceGrant{{ID: capability, Version: 1}},
		Operation: operation, Input: raw,
	})
	return callResult{data: data, denial: denial, failure: failure}
}

func mustData(t *testing.T, result callResult) map[string]any {
	t.Helper()
	if result.denial != nil || result.failure != nil {
		t.Fatalf("denial=%+v failure=%+v", result.denial, result.failure)
	}
	encoded, err := json.Marshal(result.data)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestReadsOnEmptyInstallation(t *testing.T) {
	f := newServiceFixture(t)
	org := mustData(t, f.background("acme.test", "organization.read", "organization.read@1/get", map[string]any{}))
	if org["name"] != "Service Test" {
		t.Fatalf("organization = %+v", org)
	}
	instance := mustData(t, f.background("acme.test", "instance.read", "instance.read@1/get", map[string]any{}))
	if instance["publicUrl"] != "https://tilecast.test" || instance["tilecastVersion"] != "9.9.9-test" {
		t.Fatalf("instance = %+v", instance)
	}
	screens := mustData(t, f.background("acme.test", "screens.read", "screens.read@1/list", map[string]any{}))
	if screens["total"] != float64(0) {
		t.Fatalf("screens = %+v", screens)
	}
	targets := mustData(t, f.background("acme.test", "targets.resolve", "targets.resolve@1/resolve", map[string]any{"screenIds": []string{}, "groupIds": []string{}}))

	if ids, ok := targets["screenIds"].([]any); !ok || len(ids) != 0 {
		t.Fatalf("targets = %+v", targets)
	}
	for _, operation := range []string{"playlists.list", "layouts.list", "datasources.list", "schedules.list", "groups.list"} {
		got := mustData(t, f.background("acme.test", "content.read", "content.read@1/"+operation, map[string]any{}))
		if got["total"] != float64(0) {
			t.Fatalf("%s = %+v", operation, got)
		}
	}
	users := mustData(t, f.background("acme.test", "users.read-basic", "users.read-basic@1/list-by-role", map[string]any{"role": "owner"}))
	items, ok := users["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("owners = %+v", users)
	}
	owner, ok := items[0].(map[string]any)
	if !ok || owner["username"] != "service-owner" || owner["role"] != "owner" || owner["active"] != true {
		t.Fatalf("owner = %+v", items[0])
	}
	if _, leaked := owner["Username"]; leaked {
		t.Fatalf("directory user leaks Go keys: %+v", owner)
	}
}

func TestScreensGetReadsNotFound(t *testing.T) {
	f := newServiceFixture(t)
	result := f.studio(f.ownerID, "owner", "acme.test", "screens.read", "screens.read@1/get", map[string]any{"id": uuid.NewString()})
	if result.failure == nil || result.failure.Code != ErrCodeNotFound {
		t.Fatalf("failure = %+v, want not_found", result.failure)
	}
}

func TestManagedLifecycleIsPackageOwned(t *testing.T) {
	f := newServiceFixture(t)
	ensure := map[string]any{
		"name": "Lobby board", "description": "Package-owned board",
		"dataSourceProvider": "static", "dataSourceConfiguration": `{"rows":[]}`,
		"cachedPayload": `{"rows":[]}`, "cacheCategory": "snapshot",
		"widgetProvider": "static", "widgetConfiguration": `{"title":"Lobby"}`,
	}
	first := mustData(t, f.background("acme.one", "managed-presentations.manage", "managed-presentations.manage@1/ensure", ensure))
	again := mustData(t, f.background("acme.one", "managed-presentations.manage", "managed-presentations.manage@1/ensure", ensure))
	if first["playlistId"] != again["playlistId"] || first["dataSourceId"] != again["dataSourceId"] {
		t.Fatalf("ensure is not idempotent: %+v vs %+v", first, again)
	}
	other := mustData(t, f.background("acme.two", "managed-presentations.manage", "managed-presentations.manage@1/ensure", ensure))
	if other["playlistId"] == first["playlistId"] {
		t.Fatal("two packages share one managed playlist")
	}
	got := mustData(t, f.background("acme.one", "managed-presentations.manage", "managed-presentations.manage@1/get", map[string]any{}))
	if got["playlistId"] != first["playlistId"] {
		t.Fatalf("get = %+v, want %+v", got, first)
	}
	updated := mustData(t, f.background("acme.one", "managed-presentations.manage", "managed-presentations.manage@1/update-data", map[string]any{
		"configuration": `{"rows":[1]}`, "cachedPayload": `{"rows":[1]}`, "cacheCategory": "snapshot",
	}))
	if updated["updated"] != true {
		t.Fatalf("update-data = %+v", updated)
	}
	// System attribution stores NULL creators, never a zero UUID.
	var createdBy *uuid.UUID
	if err := f.pool.QueryRow(context.Background(), `SELECT created_by FROM data_sources WHERE id=$1`, first["dataSourceId"]).Scan(&createdBy); err != nil {
		t.Fatal(err)
	}
	if createdBy != nil {
		t.Fatalf("system managed row creator = %v, want NULL", createdBy)
	}
	// The ensure wrote its audit event with the package identity.
	var action string
	var metadata map[string]any
	if err := f.pool.QueryRow(context.Background(), `SELECT action,metadata FROM audit_logs WHERE action='package.managed_presentation.ensured' AND metadata->>'package_id'='acme.one' ORDER BY created_at DESC LIMIT 1`).Scan(&action, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["package_id"] != "acme.one" {
		t.Fatalf("audit metadata = %+v", metadata)
	}
}

func TestManagedEnsureAttributesStudioActor(t *testing.T) {
	f := newServiceFixture(t)
	ensure := map[string]any{
		"name": "Studio board", "dataSourceProvider": "static",
		"dataSourceConfiguration": `{"rows":[]}`, "cachedPayload": `{"rows":[]}`,
		"widgetProvider": "static", "widgetConfiguration": `{"title":"Studio"}`,
	}
	created := mustData(t, f.studio(f.ownerID, "owner", "acme.studio", "managed-presentations.manage", "managed-presentations.manage@1/ensure", ensure))
	var createdBy *uuid.UUID
	if err := f.pool.QueryRow(context.Background(), `SELECT created_by FROM playlists WHERE id=$1`, created["playlistId"]).Scan(&createdBy); err != nil {
		t.Fatal(err)
	}
	if createdBy == nil || *createdBy != f.ownerID {
		t.Fatalf("studio managed playlist creator = %v", createdBy)
	}
	// Viewers cannot create managed content from Studio.
	result := f.studio(f.viewerID, "viewer", "acme.studio", "managed-presentations.manage", "managed-presentations.manage@1/ensure", ensure)
	if result.failure == nil || result.failure.Code != ErrCodeForbidden {
		t.Fatalf("viewer ensure = %+v, want forbidden", result.failure)
	}
}

func TestTakeoverValidationPaths(t *testing.T) {
	f := newServiceFixture(t)
	result := f.background("acme.test", "takeovers.manage", "takeovers.manage@1/activate", map[string]any{
		"name": "Alert", "playlistId": uuid.NewString(),
		"screenIds": []string{}, "groupIds": []string{},
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	})
	if result.failure == nil || result.failure.Code != ErrCodeInvalidInput {
		t.Fatalf("empty targets = %+v, want invalid_input", result.failure)
	}
	result = f.background("acme.test", "takeovers.manage", "takeovers.manage@1/activate", map[string]any{
		"name": "Alert", "playlistId": uuid.NewString(),
		"screenIds": []string{uuid.NewString()}, "groupIds": []string{},
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	})
	if result.failure == nil || result.failure.Code != ErrCodeInvalidInput {
		t.Fatalf("unknown playlist = %+v, want invalid_input", result.failure)
	}
	result = f.background("acme.test", "takeovers.manage", "takeovers.manage@1/cancel", map[string]any{"id": uuid.NewString()})
	if result.failure == nil || result.failure.Code != ErrCodeConflict {
		t.Fatalf("unknown cancel = %+v, want conflict", result.failure)
	}
	result = f.studio(f.viewerID, "viewer", "acme.test", "takeovers.manage", "takeovers.manage@1/cancel", map[string]any{"id": uuid.NewString()})
	if result.failure == nil || result.failure.Code != ErrCodeForbidden {
		t.Fatalf("viewer cancel = %+v, want forbidden", result.failure)
	}
}

func TestAuditWriteIsNamespaced(t *testing.T) {
	f := newServiceFixture(t)
	written := mustData(t, f.background("acme.test", "audit.write", "audit.write@1/write", map[string]any{
		"action": "package.jobs.refreshed", "resourceType": "job",
		"resourceId": "refresh", "metadata": map[string]any{"result": "ok"},
	}))
	if written["written"] != true {
		t.Fatalf("write = %+v", written)
	}
	var resource string
	var metadata map[string]any
	if err := f.pool.QueryRow(context.Background(), `SELECT resource_id,metadata FROM audit_logs WHERE action='package.jobs.refreshed'`).Scan(&resource, &metadata); err != nil {
		t.Fatal(err)
	}
	if resource != "refresh" || metadata["package_id"] != "acme.test" || metadata["result"] != "ok" {
		t.Fatalf("audit row = %s %+v", resource, metadata)
	}
	// Guests cannot forge core audit actions.
	result := f.background("acme.test", "audit.write", "audit.write@1/write", map[string]any{"action": "user.deleted", "resourceType": "user"})
	if result.failure == nil || result.failure.Code != ErrCodeInvalidInput {
		t.Fatalf("forged action = %+v, want invalid_input", result.failure)
	}
}

func insertPlayerCommandScreen(t *testing.T, pool *pgxpool.Pool, orgID, id uuid.UUID, generic, legacy string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Command Screen','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, id, orgID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash)VALUES($1,$2,$3,$4)`, uuid.New(), id, uuid.NewString(), make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,player_capabilities,display_control_capabilities)VALUES($1,$2::jsonb,$3::jsonb)`, id, generic, legacy); err != nil {
		t.Fatal(err)
	}
}

func serviceOrgID(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var orgID uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT id FROM organization_settings WHERE singleton`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	return orgID
}

func TestPlayerCommandQueuesThroughCapability(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	screenID := uuid.New()
	insertPlayerCommandScreen(t, f.pool, serviceOrgID(t, f.pool), screenID,
		`{"display.power":{"version":1,"provider":"hdmi_cec"}}`, `{}`)
	data := mustData(t, f.background("acme.display", "players.display-control", "players.display-control@1/display.power",
		map[string]any{"screenId": screenID.String(), "input": map[string]any{"state": "off"}}))
	if data["queued"] != true || data["commandType"] != "display_power_off" || data["screenId"] != screenID.String() {
		t.Fatalf("answer = %+v", data)
	}
	commandID, err := uuid.Parse(data["commandId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	var commandType, payload string
	var creator *uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT type,payload::text,created_by FROM player_commands WHERE id=$1`, commandID).Scan(&commandType, &payload, &creator); err != nil {
		t.Fatal(err)
	}
	if commandType != "display_power_off" || payload != "{}" || creator != nil {
		t.Fatalf("command = %s %s creator=%v", commandType, payload, creator)
	}
	var action string
	var auditUser *uuid.UUID
	var metadata map[string]any
	metadataRaw := []byte{}
	if err := f.pool.QueryRow(ctx, `SELECT action,user_id,metadata::text FROM audit_logs WHERE action='package.player.command_queued' AND resource_id=$1`, commandID.String()).Scan(&action, &auditUser, &metadataRaw); err != nil {
		t.Fatalf("package audit row: %v", err)
	}
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
		t.Fatal(err)
	}
	if auditUser != nil || metadata["package_id"] != "acme.display" || metadata["operation"] != "display.power" || metadata["command"] != "display_power_off" {
		t.Fatalf("audit = user %v metadata %v", auditUser, metadata)
	}
}

func TestPlayerCommandAcceptsLegacyReport(t *testing.T) {
	f := newServiceFixture(t)
	screenID := uuid.New()
	insertPlayerCommandScreen(t, f.pool, serviceOrgID(t, f.pool), screenID,
		`{}`, `{"power":"hdmi_cec"}`)
	data := mustData(t, f.background("acme.display", "players.display-control", "players.display-control@1/display.power",
		map[string]any{"screenId": screenID.String(), "input": map[string]any{"state": "on"}}))
	if data["commandType"] != "display_power_on" {
		t.Fatalf("answer = %+v", data)
	}
}

func TestPlayerCommandRefusesWithoutCapability(t *testing.T) {
	f := newServiceFixture(t)
	screenID := uuid.New()
	insertPlayerCommandScreen(t, f.pool, serviceOrgID(t, f.pool), screenID, `{}`, `{}`)
	result := f.background("acme.display", "players.display-control", "players.display-control@1/display.power",
		map[string]any{"screenId": screenID.String(), "input": map[string]any{"state": "on"}})
	if result.failure == nil || result.failure.Code != ErrCodeForbidden {
		t.Fatalf("result = %+v", result)
	}
	// A wrong-version generic report does not count either.
	badID := uuid.New()
	insertPlayerCommandScreen(t, f.pool, serviceOrgID(t, f.pool), badID,
		`{"display.power":{"version":2,"provider":"hdmi_cec"}}`, `{}`)
	result = f.background("acme.display", "players.display-control", "players.display-control@1/display.power",
		map[string]any{"screenId": badID.String(), "input": map[string]any{"state": "on"}})
	if result.failure == nil || result.failure.Code != ErrCodeForbidden {
		t.Fatalf("versioned result = %+v", result)
	}
}

func TestPlayerCommandValidationPaths(t *testing.T) {
	f := newServiceFixture(t)
	screenID := uuid.New()
	insertPlayerCommandScreen(t, f.pool, serviceOrgID(t, f.pool), screenID,
		`{"display.volume":{"version":1,"provider":"ddc_ci"}}`, `{}`)
	cases := []struct {
		name      string
		operation string
		input     map[string]any
		code      string
	}{
		{"bad state", "players.display-control@1/display.power", map[string]any{"screenId": screenID.String(), "input": map[string]any{"state": "dim"}}, ErrCodeInvalidInput},
		{"missing input", "players.display-control@1/display.power", map[string]any{"screenId": screenID.String()}, ErrCodeInvalidInput},
		{"missing screen", "players.display-control@1/display.power", map[string]any{"screenId": uuid.NewString(), "input": map[string]any{"state": "on"}}, ErrCodeNotFound},
		{"volume high", "players.display-control@1/display.volume", map[string]any{"screenId": screenID.String(), "input": map[string]any{"volume": float64(101)}}, ErrCodeInvalidInput},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := f.background("acme.display", "players.display-control", tc.operation, tc.input)
			if result.failure == nil || result.failure.Code != tc.code {
				t.Fatalf("result = %+v", result)
			}
		})
	}
	// The valid volume call queues with its payload intact.
	data := mustData(t, f.background("acme.display", "players.display-control", "players.display-control@1/display.volume",
		map[string]any{"screenId": screenID.String(), "input": map[string]any{"volume": float64(42)}}))
	if data["commandType"] != "display_set_volume" {
		t.Fatalf("answer = %+v", data)
	}
	var payload string
	if err := f.pool.QueryRow(context.Background(), `SELECT payload::text FROM player_commands WHERE id=$1`, data["commandId"].(string)).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload != `{"volume": 42}` {
		t.Fatalf("payload = %s", payload)
	}
}

func TestPlayerCommandStudioRole(t *testing.T) {
	f := newServiceFixture(t)
	screenID := uuid.New()
	insertPlayerCommandScreen(t, f.pool, serviceOrgID(t, f.pool), screenID,
		`{"display.mute":{"version":1,"provider":"network"}}`, `{}`)
	denied := f.studio(f.viewerID, "viewer", "acme.display", "players.display-control", "players.display-control@1/display.mute",
		map[string]any{"screenId": screenID.String(), "input": map[string]any{"muted": true}})
	if denied.failure == nil || denied.failure.Code != ErrCodeForbidden {
		t.Fatalf("viewer result = %+v", denied)
	}
	data := mustData(t, f.studio(f.ownerID, "owner", "acme.display", "players.display-control", "players.display-control@1/display.mute",
		map[string]any{"screenId": screenID.String(), "input": map[string]any{"muted": true}}))
	if data["commandType"] != "display_mute" {
		t.Fatalf("answer = %+v", data)
	}
	var creator *uuid.UUID
	if err := f.pool.QueryRow(context.Background(), `SELECT created_by FROM player_commands WHERE id=$1`, data["commandId"].(string)).Scan(&creator); err != nil {
		t.Fatal(err)
	}
	if creator == nil || *creator != f.ownerID {
		t.Fatalf("creator = %v, want the studio actor", creator)
	}
}
