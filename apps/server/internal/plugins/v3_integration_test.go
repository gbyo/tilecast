package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplev3"
)

// The sample API 3 plugin owns no table, route, or page. Everything below
// works for it only through the host's generic settings and instances.

type steppedClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *steppedClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *steppedClock) Set(at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = at
}

type v3Environment struct {
	installationEnvironment
	service *Service
	sample  *samplev3.Plugin
	clock   *steppedClock
	secrets *pluginsecrets.Store
	owner   context.Context
}

func withV3(t *testing.T, run func(v3Environment)) {
	t.Helper()
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, err := env.pool.Exec(env.ctx, `TRUNCATE plugin_secret_deks CASCADE`); err != nil {
			t.Fatal(err)
		}
		ring, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "kek.json"))
		if err != nil {
			t.Fatal(err)
		}
		secrets := pluginsecrets.NewStore(env.pool, ring, nil)
		clock := &steppedClock{now: time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)}
		sample := samplev3.New()
		service := NewService(env.pool, nil, WithPlugins(sample), WithSecrets(secrets), WithClock(clock))
		ownerCapabilities, _ := auth.BuiltinCapabilities("owner")
		owner := plugin.WithPrincipal(env.ctx, plugin.Principal{UserID: env.userID, Role: "owner", Capabilities: ownerCapabilities.Strings()})
		if _, _, err := service.Install(env.ctx, samplev3.ID, env.userID); err != nil {
			t.Fatal(err)
		}
		run(v3Environment{installationEnvironment: env, service: service, sample: sample, clock: clock, secrets: secrets, owner: owner})
	})
}

func (e v3Environment) screen(t *testing.T, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,
		device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
		VALUES($1,$2,$3,$4,'linux','Test','Display','Linux','1',1920,1080,1,'en-US','UTC')`, id, e.orgID, uuid.NewString(), name); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (e v3Environment) version(t *testing.T, screen uuid.UUID) int64 {
	t.Helper()
	var version int64
	if err := e.pool.QueryRow(e.ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screen).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}

func str(value string) *string { return &value }

func signWrite(title string, target plugin.Target, extra map[string]any) instanceWrite {
	configuration := map[string]any{"title": title}
	for key, value := range extra {
		configuration[key] = value
	}
	enabled := true
	return instanceWrite{Name: str(title), Enabled: &enabled, Target: &target, Configuration: configuration, Schedule: &plugin.InstanceSchedule{
		StartsAt: timePtr(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)), EndsAt: timePtr(time.Date(2026, 6, 2, 0, 0, 0, 0, time.UTC))}}
}

func timePtr(at time.Time) *time.Time { return &at }

func (e v3Environment) auditMetadata(t *testing.T, action string) string {
	t.Helper()
	rows, err := e.pool.Query(e.ctx, `SELECT coalesce(metadata::text,'')||coalesce(resource_name,'')||coalesce(summary,'') FROM audit_logs WHERE action=$1`, action)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var all strings.Builder
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			t.Fatal(err)
		}
		all.WriteString(text)
	}
	return all.String()
}

func TestV3SettingsRevisionsSecretsAndAudit(t *testing.T) {
	withV3(t, func(e v3Environment) {
		revision := int64(0)
		// Defaults read before anything is saved, secrets report only state.
		document, err := e.service.GetSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil)
		if err != nil || document.Revision != 0 || document.Values["refreshMinutes"] != 5 || document.Secrets["apiToken"] != pluginsecrets.StateNotSet {
			t.Fatalf("defaults = %+v %v", document, err)
		}
		// A write without a revision is refused: there is no convenience path.
		_, err = e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{"refreshMinutes": 10.0}})
		var explicit *plugin.APIError
		if !errors.As(err, &explicit) || explicit.Code != "expected_revision_required" {
			t.Fatalf("write without a revision = %v", err)
		}
		const secret = "tok-SECRET-value-123"
		document, err = e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{
			Values: map[string]any{"refreshMinutes": 10.0}, Secrets: map[string]string{"apiToken": secret}, ExpectedRevision: &revision})
		if err != nil || document.Revision != 1 || document.Secrets["apiToken"] != pluginsecrets.StateSet {
			t.Fatalf("first write = %+v %v", document, err)
		}
		encoded, _ := json.Marshal(document)
		if strings.Contains(string(encoded), secret) {
			t.Fatal("the settings document carries the secret")
		}
		// The audit event names the changed keys and never the value.
		audit := e.auditMetadata(t, "plugin.settings.updated")
		if !strings.Contains(audit, "refreshMinutes") || !strings.Contains(audit, "apiToken") || strings.Contains(audit, secret) {
			t.Fatalf("audit = %s", audit)
		}
		// Nothing in the database holds the plaintext.
		var stored bool
		if err := e.pool.QueryRow(e.ctx, `SELECT EXISTS(SELECT 1 FROM plugin_settings WHERE "values"::text LIKE '%'||$1||'%')
			OR EXISTS(SELECT 1 FROM plugin_secrets WHERE position($2::bytea in envelope)>0)`, secret, []byte(secret)).Scan(&stored); err != nil || stored {
			t.Fatalf("plaintext is stored: %v %v", stored, err)
		}
		// A secret is not an ordinary value, and an unknown key is refused.
		for name, write := range map[string]SettingsWrite{
			"secret as a value": {Values: map[string]any{"apiToken": "x"}, ExpectedRevision: &document.Revision},
			"unknown key":       {Values: map[string]any{"other": 1.0}, ExpectedRevision: &document.Revision},
			"out of range":      {Values: map[string]any{"refreshMinutes": 90.0}, ExpectedRevision: &document.Revision},
			"unknown secret":    {Secrets: map[string]string{"nope": "x"}, ExpectedRevision: &document.Revision},
		} {
			if _, err := e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID, write); !errors.Is(err, plugin.ErrInvalid) {
				t.Errorf("%s = %v", name, err)
			}
		}
		// A stale write changes nothing: not the value, not the secret.
		stale := int64(0)
		_, err = e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{
			Values: map[string]any{"refreshMinutes": 30.0}, Secrets: map[string]string{"apiToken": "replaced"}, ExpectedRevision: &stale})
		if !errors.As(err, &explicit) || explicit.Code != "plugin_settings_revision_conflict" {
			t.Fatalf("stale write = %v", err)
		}
		if value, err := e.secrets.Read(e.ctx, e.pool, pluginsecrets.SecretRef{PluginID: samplev3.ID, OwnerType: pluginsecrets.OwnerOrganization, OwnerID: e.orgID, Key: "apiToken"}); err != nil || value != secret {
			t.Fatalf("a stale write replaced the secret: %q %v", value, err)
		}
		// Clearing a secret removes it.
		document, err = e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{
			Values: map[string]any{"refreshMinutes": 10.0}, ClearSecrets: []string{"apiToken"}, ExpectedRevision: &document.Revision})
		if err != nil || document.Secrets["apiToken"] != pluginsecrets.StateNotSet {
			t.Fatalf("clear = %+v %v", document, err)
		}
	})
}

func TestV3SettingsInvalidateOnlyTheScreensTheyAffect(t *testing.T) {
	withV3(t, func(e v3Environment) {
		shown, other, bare := e.screen(t, "Shown"), e.screen(t, "Other"), e.screen(t, "Bare")
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID,
			signWrite("Sign", plugin.Target{Scope: plugin.TargetScreens, IDs: []uuid.UUID{shown, other}}, nil)); err != nil {
			t.Fatal(err)
		}
		projected, err := e.service.PlayerStateForScreen(e.ctx, shown, map[string]int{"player.clock": 1, "plugin.host": 2})
		if err != nil || len(projected) != 1 {
			t.Fatalf("project before first settings save: %v %v", projected, err)
		}
		var defaults map[string]any
		if err := json.Unmarshal(projected[0].State, &defaults); err != nil || defaults["refreshMinutes"] != 5.0 {
			t.Fatalf("projected settings defaults: %v %v", defaults, err)
		}
		before := map[string]int64{"shown": e.version(t, shown), "other": e.version(t, other), "bare": e.version(t, bare)}
		zero := int64(0)
		if _, err := e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID,
			SettingsWrite{Values: map[string]any{"refreshMinutes": 7.0}, ExpectedRevision: &zero}); err != nil {
			t.Fatal(err)
		}
		if e.version(t, shown) <= before["shown"] || e.version(t, other) <= before["other"] || e.version(t, bare) != before["bare"] {
			t.Fatal("an organization setting did not revise exactly the screens that receive an instance")
		}
		before["shown"], before["other"] = e.version(t, shown), e.version(t, other)
		if _, err := e.service.UpdateSettings(e.owner, samplev3.ID, scopeScreen, shown, e.userID,
			SettingsWrite{Values: map[string]any{"room": "Gym"}, ExpectedRevision: &zero}); err != nil {
			t.Fatal(err)
		}
		if e.version(t, shown) <= before["shown"] || e.version(t, other) != before["other"] {
			t.Fatal("a screen setting revised a screen it does not belong to")
		}
		// The projection carries the plugin's own settings and no secret.
		states, err := e.service.PlayerStateForScreen(e.ctx, shown, map[string]int{"player.clock": 1, "plugin.host": 2})
		if err != nil || len(states) != 1 {
			t.Fatalf("state = %v %v", states, err)
		}
		var state map[string]any
		_ = json.Unmarshal(states[0].State, &state)
		if state["room"] != "Gym" || state["refreshMinutes"] != 7.0 || state["title"] != "Sign" {
			t.Fatalf("state = %v", state)
		}
	})
}

type ownStateProjector struct{ *samplev3.Plugin }

func (ownStateProjector) ProjectPlayerState(context.Context, uuid.UUID) ([]plugin.PlayerState, error) {
	return nil, nil
}

func TestV3OrganizationSettingsInvalidateOwnProjectorScreens(t *testing.T) {
	withV3(t, func(e v3Environment) {
		e.service.hosted[0].plugin = ownStateProjector{e.sample}
		e.service.hosted[0].manifest.Instances = nil
		screen := e.screen(t, "Lobby")
		before := e.version(t, screen)
		zero := int64(0)
		if _, err := e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID,
			SettingsWrite{Values: map[string]any{"refreshMinutes": 7}, ExpectedRevision: &zero}); err != nil {
			t.Fatal(err)
		}
		if e.version(t, screen) <= before {
			t.Fatal("settings did not revise the screen served by the plugin's own projector")
		}
	})
}

func TestV3SettingsRequireSecretsOnCreateAndUpdate(t *testing.T) {
	withV3(t, func(e v3Environment) {
		e.service.hosted[0].manifest.Settings.Organization[0].Required = true
		zero := int64(0)
		write := SettingsWrite{ExpectedRevision: &zero}
		update := func(write SettingsWrite) (SettingsDocument, error) {
			return e.service.UpdateSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil, e.userID, write)
		}
		if _, err := update(write); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("omitted required secret: %v", err)
		}
		write.Secrets = map[string]string{"apiToken": "test-value"}
		saved, err := update(write)
		if err != nil {
			t.Fatal(err)
		}
		write = SettingsWrite{ExpectedRevision: &saved.Revision, ClearSecrets: []string{"apiToken"}}
		if _, err := update(write); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("cleared required secret: %v", err)
		}
		write.ClearSecrets = nil
		kept, err := update(write)
		if err != nil || kept.Revision != saved.Revision+1 || kept.Secrets["apiToken"] != pluginsecrets.StateSet {
			t.Fatalf("kept existing required secret: %+v %v", kept, err)
		}
	})
}

func TestV3InstanceSecretsReferencesAndDeletion(t *testing.T) {
	withV3(t, func(e v3Environment) {
		screen := e.screen(t, "Lobby")
		font, asset := e.libraryResources(t)
		const key = "KEY-never-in-audit-9f3"
		write := signWrite("Sign", plugin.Target{Scope: plugin.TargetScreens, IDs: []uuid.UUID{screen}},
			map[string]any{"fontId": font.String(), "logoAssetId": asset.String(), "contact": "reception@example.com"})
		write.Secrets = map[string]string{"accessKey": key}
		created, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, write)
		if err != nil {
			t.Fatal(err)
		}
		if created.Secrets["accessKey"] != pluginsecrets.StateSet || created.Revision != 1 {
			t.Fatalf("created = %+v", created)
		}
		encoded, _ := json.Marshal(created)
		if strings.Contains(string(encoded), key) {
			t.Fatal("the instance document carries the secret")
		}
		if audit := e.auditMetadata(t, "plugin.instance.created"); !strings.Contains(audit, "accessKey") || strings.Contains(audit, key) {
			t.Fatalf("audit = %s", audit)
		}
		// Neither the Player manifest state nor its entries can carry it.
		states, err := e.service.PlayerStateForScreen(e.ctx, screen, map[string]int{"player.clock": 1, "plugin.host": 2})
		if err != nil || len(states) != 1 || len(states[0].Fonts) != 1 || states[0].Fonts[0].ID != font {
			t.Fatalf("state = %+v %v", states, err)
		}
		if strings.Contains(string(states[0].State), key) {
			t.Fatal("Player state carries a secret")
		}
		// The instance reads its own secret through the typed client path.
		if value, err := e.service.ReadPluginSecret(e.ctx, samplev3.ID, plugin.ScopeInstance, created.ID, "accessKey"); err != nil || value != key {
			t.Fatalf("instance secret = %q %v", value, err)
		}
		// The library keeps the font and the media in use.
		var fontUsers, mediaUsers int
		_ = e.pool.QueryRow(e.ctx, `SELECT count(*) FROM font_references WHERE plugin_id=$1 AND font_id=$2`, samplev3.ID, font).Scan(&fontUsers)
		_ = e.pool.QueryRow(e.ctx, `SELECT count(*) FROM plugin_media_references WHERE plugin_id=$1 AND asset_id=$2`, samplev3.ID, asset).Scan(&mediaUsers)
		if fontUsers != 1 || mediaUsers != 1 {
			t.Fatalf("references: font %d media %d", fontUsers, mediaUsers)
		}
		storage, err := media.NewLocalStorage(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		library := media.NewService(e.pool, storage, media.Config{})
		if err := library.ArchiveAssets(e.ctx, []uuid.UUID{asset}, e.userID); err == nil {
			t.Fatal("the media library archived an asset a plugin instance uses")
		}
		// An update that changes only the title keeps the secret, and one that
		// is stale changes nothing at all, secrets and references included.
		next := signWrite("Renamed", plugin.Target{Scope: plugin.TargetScreens, IDs: []uuid.UUID{screen}}, map[string]any{"fontId": font.String(), "logoAssetId": asset.String()})
		revision := created.Revision
		next.ExpectedRevision = &revision
		updated, err := e.service.UpdateInstance(e.owner, samplev3.ID, "sign", created.ID, e.userID, next)
		if err != nil || updated.Revision != 2 || updated.Secrets["accessKey"] != pluginsecrets.StateSet {
			t.Fatalf("update = %+v %v", updated, err)
		}
		staleWrite := signWrite("Stale", plugin.Target{Scope: plugin.TargetAll, IDs: []uuid.UUID{}}, nil)
		staleWrite.ClearSecrets = []string{"accessKey"}
		staleWrite.ExpectedRevision = &revision
		if _, err := e.service.UpdateInstance(e.owner, samplev3.ID, "sign", created.ID, e.userID, staleWrite); err == nil {
			t.Fatal("a stale update was accepted")
		}
		current, _ := e.service.GetInstance(e.ctx, samplev3.ID, "sign", created.ID)
		if current.Name != "Renamed" || current.Secrets["accessKey"] != pluginsecrets.StateSet || *current.TargetScope != plugin.TargetScreens {
			t.Fatalf("a stale update changed the instance: %+v", current)
		}
		// Removal is blocked by every instance, and deleting releases everything.
		var inUse *InUseError
		if err := e.service.Remove(e.ctx, samplev3.ID, e.userID); !errors.As(err, &inUse) || inUse.Resources[0].Count != 1 {
			t.Fatalf("remove = %v", err)
		}
		if status, _, _ := e.service.statusFor(e.ctx, e.service.hosted[0]); status.count != 1 || !status.active {
			t.Fatalf("status = %+v", status)
		}
		if err := e.service.DeleteInstance(e.owner, samplev3.ID, "sign", created.ID, e.userID); err != nil {
			t.Fatal(err)
		}
		var left int
		_ = e.pool.QueryRow(e.ctx, `SELECT (SELECT count(*) FROM plugin_secrets)+(SELECT count(*) FROM font_references WHERE plugin_id=$1)+(SELECT count(*) FROM plugin_media_references)`, samplev3.ID).Scan(&left)
		if left != 0 {
			t.Fatalf("a deleted instance left %d rows behind", left)
		}
		if err := library.ArchiveAssets(e.ctx, []uuid.UUID{asset}, e.userID); err != nil {
			t.Fatalf("an unreferenced asset could not be archived: %v", err)
		}
	})
}

func (e v3Environment) libraryResources(t *testing.T) (font, asset uuid.UUID) {
	t.Helper()
	font, asset = uuid.New(), uuid.New()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO font_families(id,organization_id,family,source,created_by) VALUES($1,$2,'Lobster','upload',$3)`, font, e.orgID, e.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,origin,system_managed,created_by)
		VALUES($1,$2,'Logo','image','logo.png','image/png',$3,100,'ready','library',FALSE,$4)`, asset, e.orgID, make([]byte, 32), e.userID); err != nil {
		t.Fatal(err)
	}
	return font, asset
}

func TestV3PluginValidatesDomainMeaningAndKindsStayApart(t *testing.T) {
	withV3(t, func(e v3Environment) {
		screen := e.screen(t, "Lobby")
		bad := signWrite("Forbidden", plugin.Target{Scope: plugin.TargetScreens, IDs: []uuid.UUID{screen}}, nil)
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, bad); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("the plugin's rule = %v", err)
		}
		// A kind without screen targets takes none, and is never projected.
		note := instanceWrite{Name: str("Note"), Configuration: map[string]any{"text": "hello"}}
		created, err := e.service.CreateInstance(e.owner, samplev3.ID, "note", e.userID, note)
		if err != nil || created.TargetScope != nil {
			t.Fatalf("note = %+v %v", created, err)
		}
		withTarget := note
		withTarget.Target = &plugin.Target{Scope: plugin.TargetAll, IDs: []uuid.UUID{}}
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "note", e.userID, withTarget); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("a target on a kind without targets = %v", err)
		}
		// A kind with a priority range refuses a priority outside it, and a
		// kind without one refuses any.
		out := signWrite("Sign", plugin.Target{Scope: plugin.TargetAll, IDs: []uuid.UUID{}}, nil)
		high := 99
		out.Priority = &high
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, out); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("priority out of range = %v", err)
		}
		withPriority := note
		withPriority.Priority = &high
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "note", e.userID, withPriority); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("a priority on a kind without one = %v", err)
		}
		// A kind of another plugin or an unknown kind is not found.
		if _, err := e.service.GetInstance(e.ctx, samplev3.ID, "other", created.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown kind = %v", err)
		}
		if _, err := e.service.GetInstance(e.ctx, samplev3.ID, "sign", created.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("an instance of another kind = %v", err)
		}
		states, err := e.service.PlayerStateForScreen(e.ctx, screen, map[string]int{"player.clock": 1, "plugin.host": 2})
		if err != nil || len(states) != 0 {
			t.Fatalf("a kind without targets reached a Player: %v %v", states, err)
		}
	})
}

func TestV3WindowScheduleProjectsInsideItAndRevisesAtItsEdges(t *testing.T) {
	withV3(t, func(e v3Environment) {
		screen := e.screen(t, "Lobby")
		other := e.screen(t, "Elsewhere")
		write := signWrite("Sign", plugin.Target{Scope: plugin.TargetScreens, IDs: []uuid.UUID{screen}}, nil)
		write.Schedule = &plugin.InstanceSchedule{StartsAt: timePtr(e.clock.Now().Add(time.Hour)), EndsAt: timePtr(e.clock.Now().Add(2 * time.Hour))}
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, write); err != nil {
			t.Fatal(err)
		}
		project := func() int {
			states, err := e.service.PlayerStateForScreen(e.ctx, screen, map[string]int{"player.clock": 1, "plugin.host": 2})
			if err != nil {
				t.Fatal(err)
			}
			return len(states)
		}
		if project() != 0 {
			t.Fatal("projected before the window opens")
		}
		before, otherBefore := e.version(t, screen), e.version(t, other)
		e.clock.Set(e.clock.Now().Add(90 * time.Minute))
		if advanced, err := e.service.AdvanceSchedules(e.ctx); err != nil || advanced != 1 {
			t.Fatalf("advance = %d %v", advanced, err)
		}
		if project() != 1 || e.version(t, screen) <= before || e.version(t, other) != otherBefore {
			t.Fatal("the window opening did not revise exactly its screen")
		}
		// Inside the window the state expires with it, so an offline Player stops on time.
		states, _ := e.service.PlayerStateForScreen(e.ctx, screen, map[string]int{"player.clock": 1, "plugin.host": 2})
		if states[0].ValidUntil == nil || !states[0].ValidUntil.Equal(e.clock.Now().Add(30*time.Minute)) {
			t.Fatalf("validUntil = %v", states[0].ValidUntil)
		}
		inside := e.version(t, screen)
		e.clock.Set(e.clock.Now().Add(time.Hour))
		if _, err := e.service.AdvanceSchedules(e.ctx); err != nil {
			t.Fatal(err)
		}
		if project() != 0 || e.version(t, screen) <= inside {
			t.Fatal("the window closing did not revise its screen")
		}
		if advanced, _ := e.service.AdvanceSchedules(e.ctx); advanced != 0 {
			t.Fatal("a finished window is advanced again")
		}
		bad := signWrite("Bad", plugin.Target{Scope: plugin.TargetAll, IDs: []uuid.UUID{}}, nil)
		bad.Schedule = &plugin.InstanceSchedule{StartsAt: timePtr(e.clock.Now()), EndsAt: timePtr(e.clock.Now().Add(-time.Hour))}
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, bad); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("an inverted window = %v", err)
		}
		bad.Schedule = nil
		if _, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, bad); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("a missing window = %v", err)
		}
	})
}

func TestV3PersonalFieldsAreRemovedWhenRetentionEnds(t *testing.T) {
	withV3(t, func(e v3Environment) {
		font, asset := e.libraryResources(t)
		fields := e.service.hosted[0].manifest.Instances[0].Fields
		for i := range fields {
			switch fields[i].Control {
			case "font", "media_asset":
				fields[i].Personal = &configschema.Personal{RetentionDays: 1}
			}
		}
		initial := signWrite("Visitor", plugin.Target{Scope: plugin.TargetAll, IDs: []uuid.UUID{}},
			map[string]any{"contact": "a@example.com", "fontId": font.String(), "logoAssetId": asset.String()})
		created, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, initial)
		if err != nil {
			t.Fatal(err)
		}
		if removed, err := e.service.PurgePersonalData(e.ctx); err != nil || removed != 0 {
			t.Fatalf("an early purge removed %d: %v", removed, err)
		}
		e.clock.Set(e.clock.Now().Add(25 * time.Hour))
		if removed, err := e.service.PurgePersonalData(e.ctx); err != nil || removed != 3 {
			t.Fatalf("purge removed %d: %v", removed, err)
		}
		current, err := e.service.GetInstance(e.ctx, samplev3.ID, "sign", created.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, present := current.Configuration["contact"]; present || current.Configuration["title"] != "Visitor" {
			t.Fatalf("after retention: %v", current.Configuration)
		}
		var refs int
		if err := e.pool.QueryRow(e.ctx, `SELECT (SELECT count(*) FROM font_references WHERE owner_id=$1)
			+(SELECT count(*) FROM plugin_media_references WHERE owner_id=$1)`, created.ID).Scan(&refs); err != nil || refs != 0 {
			t.Fatalf("expired personal resource references: %d %v", refs, err)
		}
		initial.ExpectedRevision = &created.Revision
		var conflict *plugin.APIError
		_, err = e.service.UpdateInstance(e.owner, samplev3.ID, "sign", created.ID, e.userID, initial)
		if !errors.As(err, &conflict) || conflict.Code != "plugin_instance_revision_conflict" {
			t.Fatalf("stale update after retention: %v", err)
		}
	})
}

func TestV3RetentionKeepsSecretsOfOtherKindsAndScopes(t *testing.T) {
	withV3(t, func(e v3Environment) {
		manifest := &e.service.hosted[0].manifest
		field := configschema.Field{Key: "sharedToken", Label: "Shared token", Control: configschema.ControlSecret}
		personal := field
		personal.Personal = &configschema.Personal{RetentionDays: 1}
		manifest.Instances[0].Fields = append(manifest.Instances[0].Fields, personal)
		manifest.Instances[1].Fields = append(manifest.Instances[1].Fields, field)
		manifest.Settings.Organization = append(manifest.Settings.Organization, personal)
		manifest.Settings.Screen = append(manifest.Settings.Screen, field)
		screenID := e.screen(t, "Lobby")
		values := map[string]string{field.Key: "test-value"}
		sign := signWrite("Lobby", plugin.Target{Scope: plugin.TargetAll, IDs: []uuid.UUID{}}, nil)
		sign.Secrets = values
		first, err := e.service.CreateInstance(e.owner, samplev3.ID, "sign", e.userID, sign)
		if err != nil {
			t.Fatal(err)
		}
		second, err := e.service.CreateInstance(e.owner, samplev3.ID, "note", e.userID, instanceWrite{
			Name: str("Note"), Configuration: map[string]any{"text": "hello"}, Secrets: values})
		if err != nil {
			t.Fatal(err)
		}
		zero := int64(0)
		for scope, id := range map[string]uuid.UUID{scopeOrganization: uuid.Nil, scopeScreen: screenID} {
			if _, err := e.service.UpdateSettings(e.owner, samplev3.ID, scope, id, e.userID,
				SettingsWrite{Secrets: values, ExpectedRevision: &zero}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := e.pool.Exec(e.ctx, `UPDATE plugin_secrets SET updated_at=$1 WHERE plugin_id=$2`, e.clock.Now().Add(-48*time.Hour), samplev3.ID); err != nil {
			t.Fatal(err)
		}
		if n, err := e.service.PurgePersonalData(e.ctx); err != nil || n != 2 {
			t.Fatalf("expired secrets removed: %d %v", n, err)
		}
		for _, check := range []struct {
			owner string
			id    uuid.UUID
			want  pluginsecrets.State
		}{
			{pluginsecrets.OwnerInstance, first.ID, pluginsecrets.StateNotSet},
			{pluginsecrets.OwnerInstance, second.ID, pluginsecrets.StateSet},
			{pluginsecrets.OwnerOrganization, e.orgID, pluginsecrets.StateNotSet},
			{pluginsecrets.OwnerScreen, screenID, pluginsecrets.StateSet},
		} {
			states, err := e.secrets.States(e.ctx, e.pool, samplev3.ID, check.owner, check.id, []string{field.Key})
			if err != nil || states[field.Key] != check.want {
				t.Errorf("%s %s: %v %v, want %s", check.owner, check.id, states, err, check.want)
			}
		}
		org, err := e.service.GetSettings(e.owner, samplev3.ID, scopeOrganization, uuid.Nil)
		if err != nil || org.Revision != 2 {
			t.Fatalf("organization revision after secret retention: %+v %v", org, err)
		}
	})
}

// A bundled plugin's service call is bound to a host invocation for that
// plugin. It cannot run outside one, under another plugin's, or after it ended.
func TestV3ServiceCallsAreBoundToTheHostInvocation(t *testing.T) {
	withV3(t, func(e v3Environment) {
		var seen []BundledCall
		e.service.SetServiceCaller(callerFunc(func(_ context.Context, call BundledCall) (json.RawMessage, error) {
			seen = append(seen, call)
			return json.RawMessage(`{"name":"Install Test"}`), nil
		}))
		services := e.sample.Services()
		if services == nil {
			t.Fatal("the host did not give the plugin its client")
		}
		// No invocation: refused before the dispatcher.
		var denial *plugin.ServiceDenial
		if _, err := e.sample.Organization(e.ctx); !errors.As(err, &denial) || denial.Kind != "invalid_actor" {
			t.Fatalf("a call outside any invocation = %v", err)
		}
		// A studio invocation carries the operator and the plugin identity the host chose.
		ctx, done := e.service.operatorInvocation(e.owner, samplev3.ID)
		name, err := e.sample.Organization(ctx)
		done()
		if err != nil || name != "Install Test" || len(seen) != 1 {
			t.Fatalf("studio call = %q %v %d", name, err, len(seen))
		}
		if call := seen[0]; call.PluginID != samplev3.ID || call.Context != "studio" || call.Actor == nil || call.Actor.UserID != e.userID {
			t.Fatalf("the call was not bound to the host's identity: %+v", call)
		}
		// Background and system invocations never carry an operator.
		for context, issue := range map[string]func(context.Context, string) (context.Context, func()){
			"background": e.service.backgroundInvocation, "system": e.service.systemInvocation} {
			ctx, done := issue(e.owner, samplev3.ID)
			_, err := e.sample.Organization(ctx)
			done()
			last := seen[len(seen)-1]
			if err != nil || last.Context != context || last.Actor != nil {
				t.Errorf("%s call = %+v %v", context, last, err)
			}
		}
		// An invocation issued for another plugin does not work for this one.
		foreign, done := e.service.operatorInvocation(e.owner, "another_plugin")
		_, err = e.sample.Organization(foreign)
		done()
		if !errors.As(err, &denial) {
			t.Fatalf("another plugin's invocation = %v", err)
		}
		// An invocation that ended is dead even if its context lingers.
		stale, done := e.service.operatorInvocation(e.owner, samplev3.ID)
		done()
		if _, err := e.sample.Organization(stale); !errors.As(err, &denial) {
			t.Fatalf("an ended invocation = %v", err)
		}
		// The manifest decides which services exist for the plugin.
		ctx, done = e.service.operatorInvocation(e.owner, samplev3.ID)
		err = services.Call(ctx, "takeovers.manage@1/cancel", nil, nil)
		done()
		if !errors.As(err, &denial) || denial.Kind != "missing_grant" {
			t.Fatalf("an undeclared service = %v", err)
		}
	})
}

type callerFunc func(context.Context, BundledCall) (json.RawMessage, error)

func (f callerFunc) CallBundled(ctx context.Context, call BundledCall) (json.RawMessage, error) {
	return f(ctx, call)
}

func TestV3ScreenSettingsFollowScreenAccess(t *testing.T) {
	withV3(t, func(e v3Environment) {
		mine, theirs := e.screen(t, "Mine"), e.screen(t, "Theirs")
		operator := uuid.New()
		group := uuid.New()
		exec := func(query string, args ...any) {
			t.Helper()
			if _, err := e.pool.Exec(e.ctx, query, args...); err != nil {
				t.Fatal(err)
			}
		}
		exec(`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Scoped','scoped','unused','administrator',TRUE)`, operator)
		exec(`INSERT INTO user_content_access(user_id,library_mode,tag_mode) VALUES($1,'all','all')`, operator)
		exec(`INSERT INTO user_screen_access(user_id,mode) VALUES($1,'restricted')`, operator)
		exec(`INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Mine',$3)`, group, e.orgID, e.userID)
		exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, group, mine, e.userID)
		exec(`INSERT INTO user_screen_scopes(user_id,scope_type,scope_id) VALUES($1,'group',$2)`, operator, group)
		capabilities, _ := auth.BuiltinCapabilities("administrator")
		scoped := plugin.WithPrincipal(e.ctx, plugin.Principal{UserID: operator, Role: "administrator", Capabilities: capabilities.Strings()})
		zero := int64(0)
		write := SettingsWrite{Values: map[string]any{"room": "Gym"}, ExpectedRevision: &zero}
		if _, err := e.service.UpdateSettings(scoped, samplev3.ID, scopeScreen, mine, operator, write); err != nil {
			t.Fatalf("a screen in scope: %v", err)
		}
		_, err := e.service.UpdateSettings(scoped, samplev3.ID, scopeScreen, theirs, operator, write)
		var explicit *plugin.APIError
		if !errors.As(err, &explicit) || explicit.Status != http.StatusNotFound {
			t.Fatalf("a screen out of scope = %v", err)
		}
		if _, err := e.service.GetSettings(scoped, samplev3.ID, scopeScreen, theirs); err == nil {
			t.Fatal("a scoped operator read the settings of a screen it cannot reach")
		}
	})
}
