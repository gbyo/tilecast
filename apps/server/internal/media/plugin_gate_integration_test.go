package media

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// pluginWidgetCatalog builds a synthetic catalog with one plugin-owned
// Widget definition: provider emergency_alerts_siren from the stable
// emergency_alerts identity (directory plugins/emergency-alerts/).
func pluginWidgetCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	configVersion := 7
	definition := contentdefs.WidgetDefinition{
		ID: "emergency_alerts_siren", Version: 1, ConfigVersion: &configVersion, APIVersion: 1,
		Source: contentdefs.PluginSource("emergency_alerts"),
		Name:   "Siren", Description: "Siren.", Category: "Essentials", Icon: "layout",
		Runtime: "native",
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "title", Label: "Title", Control: "text", MaxLength: 80, Default: "Siren"},
		}},
		DefaultConfiguration:      map[string]any{"title": "Siren"},
		PresentationSchemaVersion: 1,
		RequiredCapabilities:      map[string]int{"content.text": 1},
		EmptyStateBehavior:        "text",
		Compatibility:             &contentdefs.Compatibility{Fallback: "none"},
		Component: &contentdefs.ComponentSpec{
			Type: "emergencyalerts.siren", Version: 1, TagName: "tc-widget-emergencyalerts-siren",
			Entrypoint:     "./runtime/index.ts",
			ConfigTemplate: json.RawMessage(`{"title":{"$config":"title","default":""}}`),
			Empty:          "render",
		},
	}
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{definition}, nil)
	if err != nil {
		t.Fatalf("build plugin Widget catalog: %v", err)
	}
	return catalog
}

func TestWidgetConfigVersionUsesPluginDefinition(t *testing.T) {
	service := &Service{definitions: pluginWidgetCatalog(t)}
	if got := service.widgetConfigVersion("emergency_alerts_siren"); got != 7 {
		t.Fatalf("plugin Widget config version = %d, want 7", got)
	}
	if got := service.widgetConfigVersion("unknown_legacy_widget"); got != 1 {
		t.Fatalf("unknown legacy Widget config version = %d, want 1", got)
	}
}

// fakePluginGate stands in for the plugins service (which media cannot
// import): it allows creation only for plugins in its installed set.
type fakePluginGate struct {
	installed map[string]bool
	// failure, when set, is returned for every lock, standing in for a
	// database error inside the installation lookup.
	failure error
}

func (g fakePluginGate) LockPluginSource(ctx context.Context, tx pgx.Tx, pluginID string) error {
	if g.failure != nil {
		return g.failure
	}
	if !g.installed[pluginID] {
		return plugin.ErrNotInstalled
	}
	return nil
}

func withPluginGateDatabase(t *testing.T, run func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID)) {
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
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE data_source_refresh_states,data_sources,widgets,website_assets,asset_variants,assets,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "District", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, nil, Config{})
	run(ctx, pool, service, owner.User.ID)
}

func pluginWidgetInput() WidgetInput {
	raw, _ := json.Marshal(map[string]any{"title": "Siren test"})
	return WidgetInput{Provider: "emergency_alerts_siren", Name: "Siren", Description: "Siren.", Configuration: raw}
}

func TestCreatePluginWidgetRefusedWhenPluginMissing(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginWidgetCatalog(t))
		service.SetPluginSourceGate(fakePluginGate{installed: map[string]bool{}})
		if _, err := service.CreateWidget(ctx, userID, pluginWidgetInput()); err == nil {
			t.Fatal("created a plugin-owned Widget while its plugin is missing")
		} else {
			var unavailable *PluginUnavailableError
			if !errors.As(err, &unavailable) || unavailable.PluginID != "emergency_alerts" {
				t.Fatalf("wrong error for missing plugin: %#v", err)
			}
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM widgets WHERE provider='emergency_alerts_siren'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("refused creation left %d rows (%v)", count, err)
		}
	})
}

func TestCreatePluginWidgetGateFailureIsNotReportedAsMissingPlugin(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginWidgetCatalog(t))
		lookupFailed := errors.New("installation lookup failed")
		service.SetPluginSourceGate(fakePluginGate{failure: lookupFailed})
		_, err := service.CreateWidget(ctx, userID, pluginWidgetInput())
		var unavailable *PluginUnavailableError
		if errors.As(err, &unavailable) || !errors.Is(err, lookupFailed) {
			t.Fatalf("gate failure = %#v, want the lookup error, not PluginUnavailableError", err)
		}
	})
}

func TestCreatePluginWidgetFailsClosedWithoutAGate(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginWidgetCatalog(t))
		var unavailable *PluginUnavailableError
		if _, err := service.CreateWidget(ctx, userID, pluginWidgetInput()); !errors.As(err, &unavailable) {
			t.Fatalf("unwired gate allowed plugin-owned creation: %#v", err)
		}
	})
}

func TestCreatePluginWidgetAllowedWhenPluginInstalled(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginWidgetCatalog(t))
		service.SetPluginSourceGate(fakePluginGate{installed: map[string]bool{"emergency_alerts": true}})
		asset, err := service.CreateWidget(ctx, userID, pluginWidgetInput())
		if err != nil {
			t.Fatalf("installed plugin-owned creation refused: %v", err)
		}
		if asset.Widget == nil || asset.Widget.Provider != "emergency_alerts_siren" {
			t.Fatalf("unexpected created Widget: %+v", asset.Widget)
		}
	})
}

// pluginDataSourceCatalog builds a synthetic catalog with one plugin-owned
// Data Source definition: provider emergency_alerts_intake from the stable
// emergency_alerts identity (directory plugins/emergency-alerts/).
func pluginDataSourceCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	definition := contentdefs.DataSourceDefinition{
		ID: "emergency_alerts_intake", Version: 1,
		Source: contentdefs.PluginSource("emergency_alerts"),
		Name:   "Intake", Description: "Intake.", Category: "Essentials", Icon: "layout",
		ConfigurationSchema:  contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{}},
		DefaultConfiguration: map[string]any{},
		OutputSchema: contentdefs.OutputSchema{Kind: "records", Fields: []contentdefs.OutputField{
			{Key: "title", Label: "Title", Type: "text"},
		}},
		AdapterID:       "manual_records",
		RefreshBehavior: "manual",
	}
	catalog, err := contentdefs.New(nil, []contentdefs.DataSourceDefinition{definition})
	if err != nil {
		t.Fatalf("build plugin Data Source catalog: %v", err)
	}
	return catalog
}

func pluginDataSourceInput() DataSourceInput {
	return DataSourceInput{Provider: "emergency_alerts_intake", Name: "Intake", Description: "Intake.", Configuration: json.RawMessage(`{}`)}
}

func TestCreatePluginDataSourceRefusedWhenPluginMissing(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginDataSourceCatalog(t))
		service.SetPluginSourceGate(fakePluginGate{installed: map[string]bool{}})
		if _, err := service.CreateDataSource(ctx, userID, pluginDataSourceInput()); err == nil {
			t.Fatal("created a plugin-owned Data Source while its plugin is missing")
		} else {
			var unavailable *PluginUnavailableError
			if !errors.As(err, &unavailable) || unavailable.PluginID != "emergency_alerts" {
				t.Fatalf("wrong error for missing plugin: %#v", err)
			}
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM data_sources WHERE provider='emergency_alerts_intake'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("refused creation left %d rows (%v)", count, err)
		}
	})
}

func TestCreatePluginDataSourceFailsClosedWithoutAGate(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginDataSourceCatalog(t))
		var unavailable *PluginUnavailableError
		if _, err := service.CreateDataSource(ctx, userID, pluginDataSourceInput()); !errors.As(err, &unavailable) {
			t.Fatalf("unwired gate allowed plugin-owned creation: %#v", err)
		}
	})
}

func TestCreatePluginDataSourceAllowedWhenPluginInstalled(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginDataSourceCatalog(t))
		service.SetPluginSourceGate(fakePluginGate{installed: map[string]bool{"emergency_alerts": true}})
		source, err := service.CreateDataSource(ctx, userID, pluginDataSourceInput())
		if err != nil {
			t.Fatalf("installed plugin-owned creation refused: %v", err)
		}
		if source.Provider != "emergency_alerts_intake" {
			t.Fatalf("unexpected created Data Source: %+v", source)
		}
	})
}

func TestRefreshWorkerLeavesMissingPluginSourcesInert(t *testing.T) {
	withPluginGateDatabase(t, func(ctx context.Context, pool *pgxpool.Pool, service *Service, userID uuid.UUID) {
		service.SetContentDefinitions(pluginDataSourceCatalog(t))
		service.SetPluginSourceGate(fakePluginGate{installed: map[string]bool{"emergency_alerts": true}})
		source, err := service.CreateDataSource(ctx, userID, pluginDataSourceInput())
		if err != nil {
			t.Fatal(err)
		}
		makeDue := func() time.Time {
			t.Helper()
			var attempted time.Time
			if err := pool.QueryRow(ctx, `UPDATE data_source_refresh_states SET next_refresh_at=now()-interval '1 second',last_attempt_at=now()-interval '1 hour'
				WHERE data_source_id=$1 RETURNING last_attempt_at`, source.ID).Scan(&attempted); err != nil {
				t.Fatal(err)
			}
			return attempted
		}
		worker := NewDataSourceRefreshWorker(service, slog.New(slog.NewTextHandler(io.Discard, nil)))

		// The plugin goes away while its row is preserved.
		service.SetPluginSourceGate(fakePluginGate{installed: map[string]bool{}})
		before := makeDue()
		if worked, err := worker.runOne(ctx); err != nil || !worked {
			t.Fatalf("inert pass = %v, %v", worked, err)
		}
		var attempted time.Time
		var deferred bool
		var locked *time.Time
		if err := pool.QueryRow(ctx, `SELECT last_attempt_at,next_refresh_at>now()+interval '4 minutes',locked_at FROM data_source_refresh_states WHERE data_source_id=$1`, source.ID).Scan(&attempted, &deferred, &locked); err != nil {
			t.Fatal(err)
		}
		if !attempted.Equal(before) || !deferred || locked != nil {
			t.Fatalf("inert row was touched: attempted %v (was %v), deferred %v, locked %v", attempted, before, deferred, locked)
		}

		// Reinstalling makes the same row refresh again.
		service.SetPluginSourceGate(fakePluginGate{installed: map[string]bool{"emergency_alerts": true}})
		before = makeDue()
		if worked, err := worker.runOne(ctx); err != nil || !worked {
			t.Fatalf("live pass = %v, %v", worked, err)
		}
		if err := pool.QueryRow(ctx, `SELECT last_attempt_at FROM data_source_refresh_states WHERE data_source_id=$1`, source.ID).Scan(&attempted); err != nil {
			t.Fatal(err)
		}
		if !attempted.After(before) {
			t.Fatalf("reinstalled row was not refreshed: attempted %v", attempted)
		}
	})
}
