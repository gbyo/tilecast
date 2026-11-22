package services

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplev3"
)

// A bundled Plugin Manifest API 3 plugin calls the one service registry the
// extension packages call. These tests hold it to that: the same operations,
// contexts, authorization, and audit, with the caller identity bound by the
// host.

type bundledFixture struct {
	*serviceFixture
	plugins *plugins.Service
	sample  *samplev3.Plugin
	secrets *pluginsecrets.Store
}

func newBundledFixture(t *testing.T) *bundledFixture {
	t.Helper()
	f := newServiceFixture(t)
	ring, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(context.Background(), `TRUNCATE plugin_secret_deks CASCADE`); err != nil {
		t.Fatal(err)
	}
	secrets := pluginsecrets.NewStore(f.pool, ring, nil)
	sample := samplev3.New()
	service := plugins.NewService(f.pool, nil, plugins.WithPlugins(sample), plugins.WithSecrets(secrets))
	f.dispatcher.deps.Plugins = service
	service.SetServiceCaller(f.dispatcher)
	if _, _, err := service.Install(context.Background(), samplev3.ID, f.ownerID); err != nil {
		t.Fatal(err)
	}
	return &bundledFixture{serviceFixture: f, plugins: service, sample: sample, secrets: secrets}
}

func (b *bundledFixture) call(t *testing.T, call Call) callResult {
	t.Helper()
	data, denial, failure := b.dispatcher.Call(context.Background(), call)
	return callResult{data: data, denial: denial, failure: failure}
}

func bundledGrants(ids ...string) []packagemanifest.ServiceGrant {
	grants := []packagemanifest.ServiceGrant{}
	for _, id := range ids {
		grants = append(grants, packagemanifest.ServiceGrant{ID: id, Version: 1})
	}
	return grants
}

func (b *bundledFixture) owner(t *testing.T) *Actor {
	t.Helper()
	return &Actor{UserID: b.ownerID, Role: "owner", Capabilities: builtinActor("owner").Capabilities}
}

func TestBundledAndPackageCallsGetTheSameDecisions(t *testing.T) {
	b := newBundledFixture(t)
	ctx := context.Background()
	org := serviceOrgID(t, b.pool)
	inScope, outOfScope := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{inScope, outOfScope} {
		insertPlayerCommandScreen(t, b.pool, org, id, `{}`, `{}`)
	}
	location := uuid.New()
	if _, err := b.pool.Exec(ctx, `INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Main')`, location, org); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `UPDATE screens SET location_id=$1 WHERE id=$2`, location, inScope); err != nil {
		t.Fatal(err)
	}
	scoped := uuid.New()
	for _, query := range []string{
		`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Scoped','bundled-scoped','unused','administrator',TRUE)`,
		`INSERT INTO user_screen_access(user_id,mode) VALUES($1,'restricted')`,
	} {
		if _, err := b.pool.Exec(ctx, query, scoped); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.pool.Exec(ctx, `INSERT INTO user_screen_scopes(user_id,scope_type,scope_id) VALUES($1,'location',$2)`, scoped, location); err != nil {
		t.Fatal(err)
	}
	actor := &Actor{UserID: scoped, Role: "administrator", Capabilities: builtinActor("administrator").Capabilities}
	input := func(id uuid.UUID) []byte { return []byte(`{"id":"` + id.String() + `"}`) }

	for _, operation := range []struct {
		name  string
		input []byte
	}{{"screens.read@1/get", input(outOfScope)}, {"screens.read@1/get", input(inScope)}, {"organization.read@1/get", nil}} {
		pkg := b.call(t, Call{PackageID: "acme.display", Context: ContextStudio, Actor: actor,
			Grants: bundledGrants("screens.read", "organization.read"), Operation: operation.name, Input: operation.input})
		bundled := b.call(t, Call{PluginID: samplev3.ID, Context: ContextStudio, Actor: actor,
			Grants: bundledGrants("screens.read", "organization.read"), Operation: operation.name, Input: operation.input})
		encodePkg, _ := json.Marshal([]any{pkg.data, pkg.denial, pkg.failure})
		encodeBundled, _ := json.Marshal([]any{bundled.data, bundled.denial, bundled.failure})
		if string(encodePkg) != string(encodeBundled) {
			t.Errorf("%s %s: package and bundled calls differ\n package: %s\n bundled: %s", operation.name, operation.input, encodePkg, encodeBundled)
		}
	}
	// The out-of-scope screen reads as not found for both, the dashboard's rule.
	hidden := b.call(t, Call{PluginID: samplev3.ID, Context: ContextStudio, Actor: actor, Grants: bundledGrants("screens.read"),
		Operation: "screens.read@1/get", Input: input(outOfScope)})
	if hidden.failure == nil || hidden.failure.Code != ErrCodeNotFound {
		t.Fatalf("a scoped operator's bundled call = %+v", hidden)
	}
	// Contexts are the registry's: an operator-only operation refuses a
	// background call from either caller.
	for _, call := range []Call{
		{PackageID: "acme.display", Context: ContextBackground},
		{PluginID: samplev3.ID, Context: ContextBackground},
	} {
		call.Grants, call.Operation, call.Input = bundledGrants(), "targets.resolve@2/options", []byte(`{}`)
		call.Grants = []packagemanifest.ServiceGrant{{ID: "targets.resolve", Version: 2}}
		if result := b.call(t, call); result.denial == nil || result.denial.Kind != DenialForbiddenContext {
			t.Errorf("%+v: %+v", call, result)
		}
	}
}

func TestCallersStayInTheirLanes(t *testing.T) {
	b := newBundledFixture(t)
	// A package cannot call a bundled-only service, even with a grant.
	for _, operation := range []string{"secrets.read@1/get", "settings.read@1/get"} {
		capability := operation[:len(operation)-len("@1/get")]
		result := b.call(t, Call{PackageID: "acme.display", Context: ContextBackground,
			Grants: bundledGrants(capability), Operation: operation, Input: []byte(`{"scope":"organization","key":"apiToken"}`)})
		if result.denial == nil || result.denial.Kind != DenialMissingGrant {
			t.Errorf("a package called %s: %+v", operation, result)
		}
	}
	// A package manifest cannot even request one.
	if err := ValidateGrants([]packagemanifest.ServiceGrant{{ID: "secrets.read", Version: 1}}); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("a package grant for a bundled-only service = %v", err)
	}
	// A bundled plugin cannot call a capability that keeps package attribution.
	for _, capability := range []string{"takeovers.manage", "managed-presentations.manage", "plugin-runtime.state", "audit.write", "players.display-control", "content.read"} {
		cap := capability
		found := false
		for _, entry := range All() {
			if entry.ID != cap {
				continue
			}
			found = true
			result := b.call(t, Call{PluginID: samplev3.ID, Context: ContextBackground,
				Grants: []packagemanifest.ServiceGrant{{ID: entry.ID, Version: entry.Version}}, Operation: entry.Operations[0].Name, Input: []byte(`{}`)})
			if result.denial == nil || result.denial.Kind != DenialMissingGrant {
				t.Errorf("a bundled plugin called %s: %+v", entry.Operations[0].Name, result)
			}
		}
		if !found {
			t.Errorf("capability %s is not in the registry", cap)
		}
	}
}

func TestBundledCallerIdentityAndContextCannotBeForged(t *testing.T) {
	b := newBundledFixture(t)
	grants := bundledGrants("organization.read")
	forged := []struct {
		name string
		call Call
	}{
		{"a bundled call that also names a package", Call{PluginID: samplev3.ID, PackageID: "acme.display", Context: ContextBackground}},
		{"a bundled call with a package epoch", Call{PluginID: samplev3.ID, ExecutionEpoch: uuid.New(), Context: ContextBackground}},
		{"a background call carrying an operator", Call{PluginID: samplev3.ID, Context: ContextBackground, Actor: b.owner(t)}},
		{"a system call carrying an operator", Call{PluginID: samplev3.ID, Context: ContextSystem, Actor: b.owner(t)}},
		{"a studio call with no operator", Call{PluginID: samplev3.ID, Context: ContextStudio}},
		{"an unknown context", Call{PluginID: samplev3.ID, Context: "admin"}},
	}
	for _, item := range forged {
		item.call.Grants, item.call.Operation = grants, "organization.read@1/get"
		if result := b.call(t, item.call); result.denial == nil {
			t.Errorf("%s was accepted: %+v", item.name, result)
		}
	}
}

func TestBundledSecretsAndSettingsReads(t *testing.T) {
	b := newBundledFixture(t)
	// Production requests name their calling surface; a test must too.
	ctx := audit.WithSurface(context.Background(), audit.SurfaceStudio)
	zero := int64(0)
	owner := plugin.WithPrincipal(ctx, plugin.Principal{UserID: b.ownerID, Role: "owner", Capabilities: builtinActor("owner").Capabilities.Strings()})
	if _, err := b.plugins.UpdateSettings(owner, samplev3.ID, "organization", uuid.Nil, b.ownerID, plugins.SettingsWrite{
		Values: map[string]any{"refreshMinutes": 15.0}, Secrets: map[string]string{"apiToken": "the-token"}, ExpectedRevision: &zero}); err != nil {
		t.Fatal(err)
	}
	read := func(contextName string, actor *Actor) callResult {
		return b.call(t, Call{PluginID: samplev3.ID, Context: contextName, Actor: actor,
			Grants: bundledGrants("secrets.read", "settings.read"), Operation: "secrets.read@1/get",
			Input: []byte(`{"scope":"organization","key":"apiToken"}`)})
	}
	// The secret is readable in the contexts the ADR allows, and nowhere else.
	for name, actor := range map[string]*Actor{ContextStudio: b.owner(t), ContextBackground: nil, ContextSystem: nil} {
		if data := mustData(t, read(name, actor)); data["value"] != "the-token" {
			t.Errorf("%s secret read = %v", name, data)
		}
	}
	// settings.read never returns a secret value, only its state.
	settings := mustData(t, b.call(t, Call{PluginID: samplev3.ID, Context: ContextBackground, Grants: bundledGrants("settings.read"),
		Operation: "settings.read@1/get", Input: []byte(`{"scope":"organization"}`)}))
	encoded, _ := json.Marshal(settings)
	if string(encoded) == "" || json.Valid(encoded) == false || contains(string(encoded), "the-token") {
		t.Fatalf("settings read = %s", encoded)
	}
	if values, _ := settings["values"].(map[string]any); values["refreshMinutes"] != 15.0 {
		t.Fatalf("settings values = %v", settings)
	}
	// A key the plugin does not declare as a secret is not found.
	if result := b.call(t, Call{PluginID: samplev3.ID, Context: ContextBackground, Grants: bundledGrants("secrets.read"),
		Operation: "secrets.read@1/get", Input: []byte(`{"scope":"organization","key":"refreshMinutes"}`)}); result.failure == nil || result.failure.Code != ErrCodeNotFound {
		t.Fatalf("a non-secret key = %+v", result)
	}
	// After a restore without the key, the value is unavailable, not an error to decode.
	other, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "other.json"))
	if err != nil {
		t.Fatal(err)
	}
	restored := plugins.NewService(b.pool, nil, plugins.WithPlugins(samplev3.New()), plugins.WithSecrets(pluginsecrets.NewStore(b.pool, other, nil)))
	b.dispatcher.deps.Plugins = restored
	result := read(ContextBackground, nil)
	if result.failure == nil || result.failure.Code != ErrCodeSecretUnavailable {
		t.Fatalf("a secret with no key = %+v", result)
	}
	// Other plugins' secrets are out of reach: the plugin is the one the host bound.
	b.dispatcher.deps.Plugins = b.plugins
	if result := b.call(t, Call{PluginID: "another_plugin", Context: ContextBackground, Grants: bundledGrants("secrets.read"),
		Operation: "secrets.read@1/get", Input: []byte(`{"scope":"organization","key":"apiToken"}`)}); result.failure == nil || result.failure.Code != ErrCodeSecretUnavailable {
		t.Fatalf("another plugin's call = %+v", result)
	}
}

func contains(text, part string) bool {
	for index := 0; index+len(part) <= len(text); index++ {
		if text[index:index+len(part)] == part {
			return true
		}
	}
	return false
}
