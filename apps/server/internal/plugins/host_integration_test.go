package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleplugin"
)

// The sample plugin is known to no core code. Everything below works for it
// only through the contribution interfaces, which is the property that lets a
// new plugin be added as one directory.
func TestHostRunsAPluginThroughGenericContributions(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		sample := sampleplugin.New()
		service := NewService(env.pool, nil, WithPlugins(sample))

		// Catalog comes from the manifest; status from the plugin.
		entry, err := service.CatalogItem(env.ctx, sampleplugin.ID)
		if err != nil || entry.Installed || entry.Version != 2 || entry.ManagementPath != "/plugins/sample-tally" {
			t.Fatalf("catalog entry = %+v, %v", entry, err)
		}
		if _, known := Lookup(sampleplugin.ID); known {
			t.Fatal("the sample plugin must not be part of the bundled registry")
		}

		routes, err := service.Routes()
		if err != nil {
			t.Fatal(err)
		}
		handler := func(method, pattern string) plugin.Handler {
			for _, route := range routes {
				if route.Method == method && route.Pattern == pattern {
					return route.Handler
				}
			}
			t.Fatalf("route %s %s not registered", method, pattern)
			return nil
		}
		create := func(label string) (int, string) {
			t.Helper()
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"label":"`+label+`"}`))
			request = request.WithContext(plugin.WithPrincipal(env.ctx, plugin.Principal{UserID: env.userID, Role: "owner"}))
			recorder := httptest.NewRecorder()
			err := handler(http.MethodPost, "/plugins/sample-tally/items")(recorder, request)
			if err != nil {
				return 0, err.Error()
			}
			var body struct {
				Data sampleplugin.Item `json:"data"`
			}
			_ = json.Unmarshal(recorder.Body.Bytes(), &body)
			return recorder.Code, body.Data.ID.String()
		}

		// Installation gates configuration through the Installation service.
		if _, message := create("before install"); message != ErrPluginNotInstalled.Error() {
			t.Fatalf("create before install = %q", message)
		}
		before := env.manifestVersion(t)
		if _, created, err := service.Install(env.ctx, sampleplugin.ID, env.userID); err != nil || !created {
			t.Fatalf("install = %v, %v", created, err)
		}
		if env.manifestVersion(t) <= before {
			t.Fatal("installing a Player-facing plugin must revise manifests")
		}
		status, id := create("first")
		if status != http.StatusCreated {
			t.Fatalf("create = %d", status)
		}
		var audits int
		if err = env.pool.QueryRow(env.ctx, `SELECT count(*) FROM audit_logs WHERE action='plugin.sample_tally.created' AND resource_id=$1 AND user_id=$2`,
			id, env.userID).Scan(&audits); err != nil || audits != 1 {
			t.Fatalf("audit rows = %d, %v", audits, err)
		}

		entry, err = service.CatalogItem(env.ctx, sampleplugin.ID)
		if err != nil || !entry.Installed || !entry.Configured || !entry.Active || entry.InstanceCount != 1 {
			t.Fatalf("status after create = %+v, %v", entry, err)
		}

		// Projection is generic and limited to declared entry types.
		entries, err := service.ManifestForScreen(env.ctx, env.screenID)
		if err != nil || len(entries) != 1 || entries[0].Type != "sample_tally" {
			t.Fatalf("projection = %+v, %v", entries, err)
		}

		// Removal asks the plugin, reports its resolution, and deletes nothing.
		err = service.Remove(env.ctx, sampleplugin.ID, env.userID)
		var inUse *InUseError
		if !errors.As(err, &inUse) || len(inUse.Resources) != 1 || inUse.Resources[0].Label != "item" ||
			inUse.Resources[0].Resolution != "delete" || inUse.Resources[0].Kind != "sample_item" {
			t.Fatalf("remove while in use = %v", err)
		}
		if len(sample.Items()) != 1 {
			t.Fatal("a blocked removal must not delete plugin data")
		}

		// Background contributions.
		if workers := service.Workers(); len(workers) != 1 || workers[0].PluginID != sampleplugin.ID {
			t.Fatalf("workers = %+v", workers)
		}
		ctx, cancel := context.WithTimeout(env.ctx, 50*time.Millisecond)
		service.RunWorkers(ctx)
		cancel()
		if sample.WorkerRuns.Load() != 1 {
			t.Fatal("worker did not run")
		}
		service.RunMaintenance(env.ctx)
		if sample.MaintenanceRuns.Load() != 1 {
			t.Fatal("maintenance did not run")
		}
		section, ok := service.HeartbeatSections()["sampleTally"]
		if !ok {
			t.Fatal("heartbeat section not offered")
		}
		response, err := section.Handle(env.ctx, env.screenID, json.RawMessage(`{"seen":3}`))
		if err != nil || response["sampleTally"] == nil {
			t.Fatalf("heartbeat response = %v, %v", response, err)
		}

		// Uninstalled plugins neither project nor claim assets.
		deleteRequest := httptest.NewRequest(http.MethodDelete, "/", nil)
		deleteRequest.SetPathValue("id", id)
		deleteRequest = deleteRequest.WithContext(plugin.WithPrincipal(env.ctx, plugin.Principal{UserID: env.userID, Role: "owner"}))
		if err = handler(http.MethodDelete, "/plugins/sample-tally/items/{id}")(httptest.NewRecorder(), deleteRequest); err != nil {
			t.Fatal(err)
		}
		if err = service.Remove(env.ctx, sampleplugin.ID, env.userID); err != nil {
			t.Fatalf("remove after cleanup = %v", err)
		}
		entries, err = service.ManifestForScreen(env.ctx, env.screenID)
		if err != nil || len(entries) != 0 {
			t.Fatalf("projection while uninstalled = %+v, %v", entries, err)
		}
	})
}

func TestHostServicesAnswerForTheirPlugin(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		service := NewService(env.pool, nil, WithPlugins(sampleplugin.New()))
		host := service.hostFor(sampleplugin.ID)
		platforms, err := host.Screens.PairedPlatforms(env.ctx)
		if err != nil || platforms["linux"] != 1 {
			t.Fatalf("platforms = %v, %v", platforms, err)
		}
		organization, err := host.Organization.ID(env.ctx)
		if err != nil || organization != env.orgID {
			t.Fatalf("organization = %v, %v", organization, err)
		}
		tx, err := env.pool.Begin(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(env.ctx) //nolint:errcheck
		if err = host.Targets.ValidateInTx(env.ctx, tx, plugin.Target{Scope: plugin.TargetScreens, IDs: []uuid.UUID{env.screenID}}); err != nil {
			t.Fatalf("existing screen target rejected: %v", err)
		}
		if err = host.Targets.ValidateInTx(env.ctx, tx, plugin.Target{Scope: plugin.TargetScreens, IDs: []uuid.UUID{uuid.New()}}); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("missing screen target = %v", err)
		}
		if err = host.Installation.LockInTx(env.ctx, tx); !errors.Is(err, plugin.ErrNotInstalled) {
			t.Fatalf("lock while uninstalled = %v", err)
		}
	})
}

func TestHostRefusesUndeclaredContributions(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil || !strings.Contains(recovered.(error).Error(), "background workers") {
			t.Fatalf("recovered %v", recovered)
		}
	}()
	NewService(nil, nil, WithPlugins(undeclaredWorker{sampleplugin.New()}))
}

// undeclaredWorker hides the sample's manifest declaration of workers.
type undeclaredWorker struct{ *sampleplugin.Plugin }

func (u undeclaredWorker) Manifest() plugin.Manifest {
	manifest := u.Plugin.Manifest()
	manifest.Capabilities.BackgroundWorkers = false
	return manifest
}
