package media

// Plugin-owned Data Source providers are contributed at startup; core owns
// the provider mechanics and never names the provider. These tests prove the
// generic contract with a stub, then prove the Forms contribution honors it
// with real rows.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	formsserver "github.com/tilecast/tilecast/plugins/forms/server"
)

// stubProvider is a minimal plugin-owned provider for the generic contract.
type stubProvider struct{}

func (stubProvider) ProviderID() string { return "stub" }
func (stubProvider) Traits() plugin.DataSourceTraits {
	return plugin.DataSourceTraits{RecordBased: true, Temporal: true, Numeric: true, ProducesFields: true}
}
func (stubProvider) NormalizeConfiguration(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "{}" {
		return nil, errors.New("stub configuration is empty")
	}
	return raw, nil
}
func (stubProvider) FieldsFromConfig(raw json.RawMessage) []plugin.DataSourceField {
	var decoded struct {
		Fields []plugin.DataSourceField `json:"fields"`
	}
	_ = json.Unmarshal(raw, &decoded)
	return decoded.Fields
}
func (stubProvider) Catalog() (string, string, string) { return "Stub", "Test", "A test provider." }
func (stubProvider) CanonicalEditor() string           { return "/plugins/stub/:id" }
func (stubProvider) CanonicalCreator() string          { return "/plugins/stub/new" }
func (stubProvider) ManagedExternally() bool           { return true }
func (stubProvider) HiddenFromGallery() bool           { return true }
func (stubProvider) ExternalMessage(action string) string {
	return "stub sources are managed elsewhere (" + action + ")"
}

func setupContributionDB(t *testing.T) (context.Context, *pgxpool.Pool, uuid.UUID) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) })
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `TRUNCATE data_sources,data_source_refresh_states,organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	var orgID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO organization_settings(singleton,organization_name) VALUES(TRUE,'Contrib') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Owner','owner','x','owner') RETURNING id`, uuid.New()).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	return ctx, pool, userID
}

func insertSource(t *testing.T, ctx context.Context, pool *pgxpool.Pool, provider, configuration string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if err := pool.QueryRow(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,config_version,configuration)
		VALUES($1,(SELECT id FROM organization_settings WHERE singleton),'Test', $2, 1, $3::jsonb) RETURNING id`, id, provider, configuration).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestContributedProviderCatalogAndGuards(t *testing.T) {
	ctx, pool, userID := setupContributionDB(t)
	service := NewService(pool, nil, Config{})
	service.SetDataSourceProviders(stubProvider{})

	catalog := service.ProviderCatalog()
	var entry *ProviderCatalogEntry
	for i := range catalog {
		if catalog[i].ID == "stub" {
			entry = &catalog[i]
		}
	}
	if entry == nil {
		t.Fatal("contributed provider is missing from the catalog")
	}
	if entry.Label != "Stub" || entry.Group != "Test" {
		t.Fatalf("catalog copy mismatch: %+v", entry)
	}
	if entry.UIHints["canonicalEditor"] != "/plugins/stub/:id" || entry.UIHints["canonicalCreator"] != "/plugins/stub/new" || entry.UIHints["gallery"] != "hidden" {
		t.Fatalf("catalog hints mismatch: %+v", entry.UIHints)
	}

	if _, err := service.CreateDataSource(ctx, userID, DataSourceInput{Provider: "stub", Name: "X"}); err == nil || !strings.Contains(err.Error(), "stub sources are managed elsewhere (create)") {
		t.Fatalf("create guard err = %v", err)
	}
	id := insertSource(t, ctx, pool, "stub", `{"fields":[{"key":"a","label":"A","type":"text"}]}`)
	if _, err := service.UpdateDataSource(ctx, id, userID, DataSourceInput{Name: "Y"}); err == nil || !strings.Contains(err.Error(), "stub sources are managed elsewhere (update)") {
		t.Fatalf("update guard err = %v", err)
	}
	if _, err := service.DuplicateDataSource(ctx, id, userID); err == nil || !strings.Contains(err.Error(), "stub sources are managed elsewhere (duplicate)") {
		t.Fatalf("duplicate guard err = %v", err)
	}

	detail, err := service.GetDataSourceDetail(ctx, id)
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if len(detail.Fields) != 1 || detail.Fields[0].Key != "a" {
		t.Fatalf("contributed field discovery mismatch: %+v", detail.Fields)
	}

	if !service.dataSourceProviderAccepted("chart", "stub") {
		t.Fatal("record-based contributed provider should be chart-compatible")
	}
	if service.dataSourceProviderAccepted("chart", "unknown-provider") {
		t.Fatal("unknown provider must stay incompatible")
	}
}

func TestFormsContributionThroughGenericPaths(t *testing.T) {
	ctx, pool, userID := setupContributionDB(t)
	service := NewService(pool, nil, Config{})
	forms := formsserver.NewService()
	service.SetDataSourceProviders(forms)

	// The stored configuration mirrors what the Forms plugin writes: user
	// fields plus the synthetic record fields Widgets may select.
	configuration := `{"currentRevisionId":"` + uuid.NewString() + `","fields":[
		{"key":"title","label":"Title","type":"text"},
		{"key":"rank","label":"Rank","type":"integer"},
		{"key":"state","label":"State","type":"text"},
		{"key":"displayTitle","label":"Display title","type":"text"},
		{"key":"priority","label":"Priority","type":"integer"},
		{"key":"submittedAt","label":"Submitted at","type":"datetime"}],
		"views":[{"key":"approved","name":"Approved","fields":["title","rank"]}]}`
	id := insertSource(t, ctx, pool, "form", configuration)

	// Field discovery: user fields plus the synthetic record fields must be
	// selectable by Widgets, with declared types intact.
	detail, err := service.GetDataSourceDetail(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, field := range detail.Fields {
		got[field.Key] = field.Type
	}
	for _, key := range []string{"title", "rank", "state", "displayTitle", "priority", "submittedAt"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("expected field %q to be selectable, have %#v", key, got)
		}
	}
	if got["rank"] != "integer" {
		t.Fatalf("expected rank to be integer, got %q", got["rank"])
	}

	// Generic mutations refuse with the historical wording and point at the
	// plugin API.
	if _, err := service.CreateDataSource(ctx, userID, DataSourceInput{Provider: "form", Name: "X"}); err == nil || err.Error() != "form Data Sources are created through the forms API" {
		t.Fatalf("create guard err = %v", err)
	}
	if _, err := service.UpdateDataSource(ctx, id, userID, DataSourceInput{Name: "Y"}); err == nil || err.Error() != "form Data Sources are edited through the forms API" {
		t.Fatalf("update guard err = %v", err)
	}
	if _, err := service.DuplicateDataSource(ctx, id, userID); err == nil || err.Error() != "form Data Sources cannot be duplicated" {
		t.Fatalf("duplicate guard err = %v", err)
	}

	// Catalog: Forms stays compatible output with its canonical surfaces.
	catalog := service.ProviderCatalog()
	var entry *ProviderCatalogEntry
	for i := range catalog {
		if catalog[i].ID == "form" {
			entry = &catalog[i]
		}
	}
	if entry == nil {
		t.Fatal("form provider is missing from the catalog")
	}
	if entry.Label != "Form" || entry.Group != "Interactive" {
		t.Fatalf("form catalog copy changed: %+v", entry)
	}
	if entry.UIHints["canonicalEditor"] != "/plugins/forms/:id" || entry.UIHints["canonicalCreator"] != "/plugins/forms/new" || entry.UIHints["gallery"] != "hidden" {
		t.Fatalf("form catalog hints changed: %+v", entry.UIHints)
	}
	if !service.dataSourceProviderAccepted("chart", "form") || !service.dataSourceProviderAccepted("ticker", "form") {
		t.Fatal("form output must stay compatible with chart and ticker widgets")
	}

	// The Player projection serves the cached payload for the form provider.
	payload := `{"datasets":[{"id":"approved","kind":"records","fields":[],"records":[{"id":"r1","values":{"title":"Hi"}}]}]}`
	if _, err := pool.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,cached_payload) VALUES($1,$2::jsonb)`, id, payload); err != nil {
		t.Fatal(err)
	}
	projected, err := service.PlayerTypedDataSourceConfiguration(ctx, id, "form", nil)
	if err != nil {
		t.Fatalf("player projection: %v", err)
	}
	var decoded plugin.TypedDatasetPayload
	if err := json.Unmarshal(projected, &decoded); err != nil {
		t.Fatalf("decode player payload: %v", err)
	}
	if len(decoded.Datasets) != 1 || len(decoded.Datasets[0].Records) != 1 || decoded.Datasets[0].Records[0].Values["title"] != "Hi" {
		t.Fatalf("player payload mismatch: %s", projected)
	}
}
