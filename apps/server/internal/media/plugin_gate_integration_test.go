package media

import (
	"context"
	"encoding/json"
	"errors"
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
	definition := contentdefs.WidgetDefinition{
		ID: "emergency_alerts_siren", Version: 1, APIVersion: 1,
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
