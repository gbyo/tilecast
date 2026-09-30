package media

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// TestNewDeclarativeWidgetNeedsNoCodeOrSchemaChange proves a brand-new release-defined
// Widget — present only in an injected catalog, absent from the embedded default, the
// database enumeration, and any Go provider switch — can be created and stored using
// existing generic paths. Combined with the open TypeScript provider unions and the
// definition-driven Studio gallery, a new declarative Widget requires no Android,
// TypeScript, Studio gallery, or database migration change.
func TestNewDeclarativeWidgetNeedsNoCodeOrSchemaChange(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Campus", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, nil, Config{Website: WebsitePolicy{DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500}, SourceFetch: SourceFetchPolicy{AllowPrivateNetworks: true, Timeout: 5 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour}})

	configVersion := 7
	widget := contentdefs.WidgetDefinition{
		ID: "campus-banner", Version: 1, ConfigVersion: &configVersion, Name: "Campus Banner", Category: "Test",
		Runtime: "native", PresentationSchemaVersion: 1,
		RequiredCapabilities: map[string]int{"layout.surface": 1, "content.text": 1},
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "heading", Label: "Heading", Control: "text", Required: true, MaxLength: 120, Default: "Welcome"},
		}},
		DefaultConfiguration: map[string]any{"heading": "Welcome"},
		PresentationTemplate: json.RawMessage(`{"type":"surface","children":[{"type":"text","binding":{"source":"literal","value":{"$config":"heading"}}}]}`),
	}
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{widget}, nil)
	if err != nil {
		t.Fatalf("build catalog with new declarative widget: %v", err)
	}
	service.SetContentDefinitions(catalog)

	asset, err := service.CreateWidget(ctx, owner.User.ID, WidgetInput{Provider: "campus-banner", Name: "Homecoming", Configuration: json.RawMessage(`{"heading":"Homecoming Friday"}`)})
	if err != nil {
		t.Fatalf("create new declarative widget: %v", err)
	}
	stored, err := service.GetAsset(ctx, asset.ID)
	if err != nil || stored.Widget == nil || stored.Widget.Provider != "campus-banner" {
		t.Fatalf("new declarative widget was not stored: %#v err=%v", stored.Widget, err)
	}
	if stored.Widget.ConfigVersion != configVersion {
		t.Fatalf("new declarative widget config version = %d, want %d", stored.Widget.ConfigVersion, configVersion)
	}
}
