package externalplugins_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/execution"
	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
	"github.com/tilecast/tilecast/apps/server/internal/targeting"
	"github.com/tilecast/tilecast/apps/server/internal/testdb"
	externalplugin "github.com/tilecast/tilecast/packages/package-sdk/go/plugin"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, database.Migrate)) }

type payloads struct{ payload externalplugins.Payload }

func (p *payloads) CurrentPluginPayload(_ context.Context, pkg, id string, epoch uuid.UUID) (externalplugins.Payload, bool, error) {
	return p.payload, pkg == p.payload.PackageID && id == p.payload.Descriptor.ID && epoch == p.payload.ExecutionEpoch, nil
}

type fixture struct {
	ctx                           context.Context
	pool                          *pgxpool.Pool
	service                       *externalplugins.Service
	devices                       *devices.Service
	payloads                      *payloads
	call                          externalplugins.Invocation
	owner, org, group, locA, locB uuid.UUID
	screens                       []uuid.UUID
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	f := &fixture{ctx: context.Background(), owner: uuid.New(), org: uuid.New(), group: uuid.New(), locA: uuid.New(), locB: uuid.New(), screens: []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}}
	pool, err := pgxpool.New(f.ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	f.pool = pool
	t.Cleanup(pool.Close)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(f.ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`TRUNCATE organization_settings,users CASCADE`)
	exec(`INSERT INTO organization_settings(singleton,organization_name,id)VALUES(true,'External Plugin Test',$1)`, f.org)
	exec(`INSERT INTO users(id,name,username,password_hash,role)VALUES($1,'Owner','owner','unused','owner')`, f.owner)
	exec(`INSERT INTO locations(id,organization_id,name)VALUES($1,$3,'Location A'),($2,$3,'Location B')`, f.locA, f.locB, f.org)
	exec(`INSERT INTO screen_groups(id,organization_id,name,created_by)VALUES($1,$2,'Group A',$3)`, f.group, f.org, f.owner)
	for i, id := range f.screens {
		location := f.locA
		if i == 1 {
			location = f.locB
		}
		exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,location_id)
 VALUES($1,$2,$3,$4,'linux','Test','Test','none','1.0',1920,1080,1,'en','UTC',$5)`, id, f.org, uuid.NewString(), "Screen "+string(rune('A'+i)), location)
		exec(`INSERT INTO screen_player_status(screen_id,presentation_schema_versions,native_presentation_capabilities)VALUES($1,'{1,2,3}','{"plugin.external-runtime":1}')`, id)
	}
	exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, f.group, f.screens[0], f.owner)
	f.call = externalplugins.Invocation{PackageID: "acme.surface", Digest: "sha256:" + strings.Repeat("a", 64), Epoch: uuid.New(), Actor: &f.owner, ActorRole: "owner"}
	exec(`INSERT INTO installed_packages(organization_id,package_id,package_version,digest,source_kind,source_reference,registry_reference,trust_state,manifest,execution_epoch,storage_epoch)
 VALUES($1,$2,'1.0.0',$3,'custom','https://github.com/acme/surface','ghcr.io/acme/surface','verified','{}',$4,$5)`, f.org, f.call.PackageID, f.call.Digest, f.call.Epoch, uuid.New())
	exec(`INSERT INTO installed_package_contributions(organization_id,package_id,kind,contribution_id,contribution_path)VALUES($1,$2,'plugin',$3,'./plugin')`, f.org, f.call.PackageID, "acme.surface.corner")
	f.payloads = &payloads{payload: externalplugins.Payload{PackageID: f.call.PackageID, PackageDigest: f.call.Digest, ExecutionEpoch: f.call.Epoch, ContributionID: "acme.surface.corner",
		Descriptor: externalplugin.Manifest{APIVersion: 2, ID: "corner", DefinitionVersion: 1, Name: "Corner", Description: "Test surface.", Capabilities: externalplugin.Capabilities{PlayerManifest: true}, Runtime: externalplugin.Runtime{Surfaces: []string{"corner.bottom-left"}, Tier: "ambient"}}, FrameSHA256Hex: strings.Repeat("b", 64), FrameSize: 1000}}
	f.devices = devices.NewService(pool, devices.NewPresenceHub(), "")
	f.service = externalplugins.NewService(pool, f.payloads, f.devices, f.devices)
	return f
}

func TestUnsupportedPlayerStateDoesNotAdvancePlaybackManifest(t *testing.T) {
	f := newFixture(t)
	if _, err := f.pool.Exec(f.ctx, `UPDATE screen_player_status SET native_presentation_capabilities='{}' WHERE screen_id=$1`, f.screens[1]); err != nil {
		t.Fatal(err)
	}
	f.configure(t, targeting.Definition{Mode: "all"}, 0)
	f.publish(t, 1)
	if f.version(t, f.screens[1]) != 0 || f.version(t, f.screens[0]) != 2 {
		t.Fatal("external state advanced an unsupported Player's manifest")
	}
}

func (f *fixture) configure(t *testing.T, targets targeting.Definition, revision int64) externalplugins.View {
	t.Helper()
	view, err := f.service.Configure(f.ctx, f.call, externalplugins.ConfigureInput{ContributionID: "acme.surface.corner", Enabled: true, Configuration: json.RawMessage(`{"position":"bottom-left"}`), Targets: targets, ExpectedConfigurationRevision: revision})
	if err != nil {
		t.Fatal(err)
	}
	return view
}
func (f *fixture) publish(t *testing.T, revision int64) externalplugins.View {
	t.Helper()
	background := f.call
	background.Actor = nil
	background.ActorRole = ""
	view, err := f.service.Publish(f.ctx, background, externalplugins.PublishInput{ContributionID: "acme.surface.corner", ConfigurationRevision: revision, State: json.RawMessage(`{"count":12}`), ValidUntil: time.Now().UTC().Add(75 * time.Second).Truncate(time.Millisecond)})
	if err != nil {
		t.Fatal(err)
	}
	return view
}
func (f *fixture) version(t *testing.T, id uuid.UUID) int64 {
	t.Helper()
	var version int64
	if err := f.pool.QueryRow(f.ctx, `SELECT COALESCE((SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1),0)`, id).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}

func TestTargetedStateRevisionOwnershipAndAudit(t *testing.T) {
	f := newFixture(t)
	view := f.configure(t, targeting.Definition{Mode: "selected", ScreenIDs: []uuid.UUID{f.screens[0]}}, 0)
	if view.ConfigurationRevision != 1 || view.State != nil {
		t.Fatalf("initial configuration: %+v", view)
	}
	view = f.publish(t, 1)
	for i, id := range f.screens {
		entries, err := f.service.ManifestForScreen(f.ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if (i == 0 && len(entries) != 1) || (i != 0 && len(entries) != 0) {
			t.Fatalf("wrong target %d: %+v", i, entries)
		}
		if i != 0 && f.version(t, id) != 0 {
			t.Fatal("state invalidated an untargeted screen")
		}
	}
	before := f.version(t, f.screens[0])
	background := f.call
	background.Actor = nil
	if _, err := f.service.Publish(f.ctx, background, externalplugins.PublishInput{ContributionID: view.ContributionID, ConfigurationRevision: 1, State: view.State, ValidUntil: *view.ValidUntil}); err != nil {
		t.Fatal(err)
	}
	if f.version(t, f.screens[0]) != before {
		t.Fatal("identical publication manufactured a revision")
	}
	var audits int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM audit_logs WHERE action='package.plugin.configured'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("operator audit count=%d %v", audits, err)
	}
	f.configure(t, targeting.Definition{Mode: "selected", LocationIDs: []uuid.UUID{f.locA}}, 1)
	if f.version(t, f.screens[0]) != before+1 || f.version(t, f.screens[2]) != 1 || f.version(t, f.screens[1]) != 0 {
		t.Fatal("target change did not invalidate old and new union")
	}
	if _, err := f.service.Publish(f.ctx, background, externalplugins.PublishInput{ContributionID: view.ContributionID, ConfigurationRevision: 1, State: view.State, ValidUntil: *view.ValidUntil}); !errors.Is(err, externalplugins.ErrConflict) {
		t.Fatalf("stale poll accepted: %v", err)
	}
	if _, err := f.service.Get(f.ctx, f.call, "acme.other.corner"); !errors.Is(err, externalplugins.ErrNotFound) {
		t.Fatalf("cross-package state read: %v", err)
	}
	f.publish(t, 2)
	if _, err := f.pool.Exec(f.ctx, `UPDATE installed_packages SET execution_epoch=$2 WHERE package_id=$1`, f.call.PackageID, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Clear(f.ctx, background, view.ContributionID, 2); !errors.Is(err, execution.ErrChanged) {
		t.Fatalf("old activation cleared new state: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `DELETE FROM installed_packages WHERE package_id=$1`, f.call.PackageID); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM external_plugin_runtime_state`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("removal retained state: %d %v", remaining, err)
	}
}

func TestScreenGroupLocationAllResolutionAndExpiry(t *testing.T) {
	f := newFixture(t)
	for _, item := range []struct {
		targets targeting.Definition
		count   int
	}{
		{targeting.Definition{Mode: "selected", GroupIDs: []uuid.UUID{f.group}}, 1},
		{targeting.Definition{Mode: "selected", LocationIDs: []uuid.UUID{f.locA}}, 2},
		{targeting.Definition{Mode: "selected", ScreenIDs: []uuid.UUID{f.screens[2]}, GroupIDs: []uuid.UUID{f.group}, LocationIDs: []uuid.UUID{f.locB}}, 3},
		{targeting.Definition{Mode: "all"}, 3},
	} {
		if err := targeting.Validate(f.ctx, f.pool, item.targets); err != nil {
			t.Fatal(err)
		}
		ids, err := targeting.Resolve(f.ctx, f.pool, item.targets)
		if err != nil || len(ids) != item.count {
			t.Fatalf("targets %+v: %v %v", item.targets, ids, err)
		}
	}
	for _, invalid := range []targeting.Definition{{}, {Mode: "selected"}, {Mode: "all", ScreenIDs: f.screens}, {Mode: "selected", ScreenIDs: []uuid.UUID{uuid.New()}}, {Mode: "selected", GroupIDs: []uuid.UUID{f.group, f.group}}} {
		if err := targeting.Validate(f.ctx, f.pool, invalid); err == nil {
			t.Fatalf("invalid targets accepted: %+v", invalid)
		}
	}
	f.configure(t, targeting.Definition{Mode: "all"}, 0)
	f.publish(t, 1)
	if _, err := f.pool.Exec(f.ctx, `UPDATE external_plugin_runtime_state SET valid_until=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	entries, err := f.service.ManifestForScreen(f.ctx, f.screens[0])
	if err != nil || len(entries) != 0 {
		t.Fatalf("expired state projected: %+v %v", entries, err)
	}
}

func TestScopedTargetPickerAndConfiguration(t *testing.T) {
	f := newFixture(t)
	admin := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO users(id,name,username,password_hash,role)VALUES($1,'Scoped Admin','scoped','unused','administrator')`, admin); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO user_screen_scopes(user_id,scope_type,scope_id,created_by)VALUES($1,'location',$2,$3)`, admin, f.locA, f.owner); err != nil {
		t.Fatal(err)
	}
	call := f.call
	call.Actor = &admin
	call.ActorRole = "administrator"
	if _, err := f.service.Configure(f.ctx, call, externalplugins.ConfigureInput{ContributionID: "acme.surface.corner", Enabled: true, Configuration: json.RawMessage(`{}`), Targets: targeting.Definition{Mode: "all"}}); !errors.Is(err, devices.ErrOutOfScope) {
		t.Fatalf("scoped all accepted: %v", err)
	}
	for _, kind := range []string{"screen", "group", "location"} {
		page, err := f.devices.PluginTargetOptions(f.ctx, &admin, "administrator", devices.TargetOptionQuery{Kind: kind, PageSize: 1})
		if err != nil {
			t.Fatal(err)
		}
		want := 0
		if kind == "screen" {
			want = 2
		}
		if kind == "location" {
			want = 1
		}
		if page.Total != want || page.CanSelectAll || len(page.Items) > 1 {
			t.Fatalf("scoped picker %s: %+v", kind, page)
		}
	}
	if _, err := f.service.Configure(f.ctx, call, externalplugins.ConfigureInput{ContributionID: "acme.surface.corner", Enabled: true, Configuration: json.RawMessage(`{}`), Targets: targeting.Definition{Mode: "selected", LocationIDs: []uuid.UUID{f.locA}}}); err != nil {
		t.Fatal(err)
	}
	global := f.configure(t, targeting.Definition{Mode: "all"}, 1)
	for _, enabled := range []bool{true, false} {
		_, err := f.service.Configure(f.ctx, call, externalplugins.ConfigureInput{ContributionID: "acme.surface.corner", Enabled: enabled,
			Configuration: json.RawMessage(`{}`), Targets: targeting.Definition{Mode: "selected", LocationIDs: []uuid.UUID{f.locA}},
			ExpectedConfigurationRevision: global.ConfigurationRevision})
		if !errors.Is(err, devices.ErrOutOfScope) {
			t.Fatalf("scoped administrator changed global targets (enabled=%v): %v", enabled, err)
		}
	}
	retained, err := f.service.Get(f.ctx, f.call, "acme.surface.corner")
	if err != nil || !retained.Enabled || retained.ConfigurationRevision != global.ConfigurationRevision || retained.Targets.Mode != "all" {
		t.Fatalf("global configuration changed: %+v %v", retained, err)
	}
}

func TestConfigureAuthorizesThePreviousTargets(t *testing.T) {
	f := newFixture(t)
	f.configure(t, targeting.Definition{Mode: "all"}, 0)
	admin := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO users(id,name,username,password_hash,role)VALUES($1,'Scoped Admin','scoped','unused','administrator')`, admin); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO user_screen_scopes(user_id,scope_type,scope_id,created_by)VALUES($1,'location',$2,$3)`, admin, f.locA, f.owner); err != nil {
		t.Fatal(err)
	}
	call := f.call
	call.Actor = &admin
	call.ActorRole = "administrator"
	input := externalplugins.ConfigureInput{ContributionID: "acme.surface.corner", ExpectedConfigurationRevision: 1, Enabled: true, Configuration: json.RawMessage(`{"stolen":true}`), Targets: targeting.Definition{Mode: "selected", LocationIDs: []uuid.UUID{f.locA}}}
	if _, err := f.service.Configure(f.ctx, call, input); !errors.Is(err, devices.ErrOutOfScope) {
		t.Fatalf("scoped administrator rewrote an instance that targets screens outside the scope: %v", err)
	}
	view, err := f.service.Get(f.ctx, f.call, "acme.surface.corner")
	if err != nil || view.ConfigurationRevision != 1 || view.Targets == nil || view.Targets.Mode != "all" {
		t.Fatalf("refused configuration changed the instance: %+v %v", view, err)
	}
}

func TestInvalidPersistedStateSkipsOnlyItsEntry(t *testing.T) {
	f := newFixture(t)
	f.configure(t, targeting.Definition{Mode: "selected", ScreenIDs: []uuid.UUID{f.screens[0]}}, 0)
	f.publish(t, 1)
	deep := strings.Repeat(`{"x":`, 18) + `0` + strings.Repeat(`}`, 18)
	if _, err := f.pool.Exec(f.ctx, `UPDATE external_plugin_runtime_state SET state=$1::jsonb WHERE package_id=$2`, deep, f.call.PackageID); err != nil {
		t.Fatal(err)
	}
	entries, err := f.service.ManifestForScreen(f.ctx, f.screens[0])
	if err != nil || len(entries) != 0 {
		t.Fatalf("unreadable state must skip its entry, not fail the manifest: %+v %v", entries, err)
	}
}
