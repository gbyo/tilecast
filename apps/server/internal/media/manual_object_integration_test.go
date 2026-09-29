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

// districtNoteCatalog builds a catalog containing a second manual_object Data Source that
// does not ship in the embedded default catalog. Its fields differ from School Status, so
// exercising it proves the manual_object adapter is generic: create, update, preview,
// projection, and field discovery must work with no provider-specific code.
func districtNoteCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	source := contentdefs.DataSourceDefinition{
		ID: "district-note", Version: 1, Name: "District Note", Category: "Test",
		AdapterID:           "manual_object",
		RequiresManifestV13: true,
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "headline", Label: "Headline", Control: "text", Required: true, MaxLength: 120, Default: "Welcome"},
			{Key: "detail", Label: "Detail", Control: "multiline_text", MaxLength: 500},
			{Key: "priority", Label: "Priority", Control: "select", Default: "normal", Options: []contentdefs.SelectOption{{Value: "normal", Label: "Normal"}, {Value: "high", Label: "High"}}},
		}},
		DefaultConfiguration: map[string]any{"headline": "Welcome", "priority": "normal"},
		OutputSchema: contentdefs.OutputSchema{Kind: "object", Fields: []contentdefs.OutputField{
			{Key: "headline", Label: "Headline", Type: "text", Required: true},
			{Key: "detail", Label: "Detail", Type: "text"},
			{Key: "priority", Label: "Priority", Type: "text"},
			{Key: "updatedAt", Label: "Updated time", Type: "datetime", Required: true},
		}},
	}
	builtin := contentdefs.MustLoad()
	dataSources := append(append([]contentdefs.DataSourceDefinition(nil), builtin.DataSources...), source)
	catalog, err := contentdefs.New(builtin.Widgets, dataSources)
	if err != nil {
		t.Fatalf("build district-note catalog: %v", err)
	}
	return catalog
}

func TestManualObjectSourceIsGeneric(t *testing.T) {
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
	service := NewService(pool, nil, Config{Website: WebsitePolicy{DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500}, SourceFetch: SourceFetchPolicy{AllowPrivateNetworks: true, Timeout: 5 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour}})
	service.SetContentDefinitions(districtNoteCatalog(t))
	user := owner.User.ID

	// 1. Create validates config from the definition and stores a typed object payload.
	createRaw, _ := json.Marshal(map[string]any{"headline": "Two-hour delay", "detail": "Buses run late.", "priority": "high"})
	dataSource, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "district-note", Name: "District Status", Configuration: createRaw})
	if err != nil {
		t.Fatalf("create manual object source: %v", err)
	}

	// 2. Projection into Data Document v1 uses the declared output fields, converts the
	//    configured values, and generates updatedAt because the definition declares it.
	projected, err := service.PlayerTypedDataSourceConfiguration(ctx, dataSource.ID, "district-note", dataSource.Configuration)
	if err != nil {
		t.Fatalf("project manual object payload: %v", err)
	}
	var payload TypedDatasetPayload
	if err := json.Unmarshal(projected, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Datasets) != 1 || payload.Datasets[0].Kind != "object" {
		t.Fatalf("unexpected payload shape: %#v", payload)
	}
	values := payload.Datasets[0].Values
	if values["headline"] != "Two-hour delay" || values["detail"] != "Buses run late." || values["priority"] != "high" {
		t.Fatalf("configured values were not projected: %#v", values)
	}
	if values["updatedAt"] == "" {
		t.Fatal("declared generated field updatedAt was not populated")
	}

	// 2a. The generic Status Message definition projects an object document and
	//     exposes semantic roles without a source-specific adapter branch.
	statusRaw, _ := json.Marshal(map[string]any{
		"status": "Delayed", "message": "Opening at ten.", "severity": "warning",
		"effectiveAt": "", "expiresAt": "",
	})
	statusSource, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "status-message", Name: "Status Message", Configuration: statusRaw})
	if err != nil {
		t.Fatalf("create Status Message source: %v", err)
	}
	statusProjected, err := service.PlayerTypedDataSourceConfiguration(ctx, statusSource.ID, "status-message", statusSource.Configuration)
	if err != nil {
		t.Fatalf("project Status Message payload: %v", err)
	}
	var statusPayload TypedDatasetPayload
	if err := json.Unmarshal(statusProjected, &statusPayload); err != nil {
		t.Fatal(err)
	}
	if got := statusPayload.Datasets[0].Values["message"]; got != "Opening at ten." {
		t.Fatalf("Status Message projection lost its message: %q", got)
	}
	statusDetail, err := service.GetDataSourceDetail(ctx, statusSource.ID)
	if err != nil {
		t.Fatal(err)
	}
	roles := map[string]string{}
	for _, field := range statusDetail.Fields {
		roles[field.Key] = field.Role
	}
	for key, want := range map[string]string{"status": "status", "message": "message", "severity": "severity", "updatedAt": "updated_at"} {
		if roles[key] != want {
			t.Errorf("Status Message field %q role = %q, want %q", key, roles[key], want)
		}
	}

	// Saved School Status uses the same generic projector after deprecation.
	schoolRaw, _ := json.Marshal(map[string]any{
		"status": "Open", "message": "School is operating normally.", "severity": "normal",
		"effectiveAt": "", "expiresAt": "",
	})
	schoolSource, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "school-status", Name: "Saved School Status", Configuration: schoolRaw})
	if err != nil {
		t.Fatalf("preserve School Status source: %v", err)
	}
	schoolProjected, err := service.PlayerTypedDataSourceConfiguration(ctx, schoolSource.ID, "school-status", schoolSource.Configuration)
	if err != nil {
		t.Fatalf("project saved School Status source: %v", err)
	}
	var schoolPayload TypedDatasetPayload
	if err := json.Unmarshal(schoolProjected, &schoolPayload); err != nil {
		t.Fatal(err)
	}
	if got := schoolPayload.Datasets[0].Values["status"]; got != "Open" {
		t.Fatalf("saved School Status projection failed: %q", got)
	}

	// 3. Studio preview by id returns the same typed payload.
	preview, err := service.PreviewDataSourceByID(ctx, dataSource.ID, "")
	if err != nil {
		t.Fatalf("preview by id: %v", err)
	}
	previewPayload, ok := preview.(TypedDatasetPayload)
	if !ok || len(previewPayload.Datasets) != 1 || previewPayload.Datasets[0].Values["headline"] != "Two-hour delay" {
		t.Fatalf("preview did not match stored payload: %#v", preview)
	}

	// 4. Unsaved Studio preview projects the same way straight from a configuration.
	unsaved, err := service.ManualObjectPreview(ctx, "district-note", createRaw)
	if err != nil || unsaved.Datasets[0].Values["priority"] != "high" {
		t.Fatalf("unsaved preview failed: %v %#v", err, unsaved)
	}

	// 5. Field discovery derives selectable fields from the output schema, with no entry
	//    in the legacy provider switch.
	detail, err := service.GetDataSourceDetail(ctx, dataSource.ID)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]string{}
	for _, field := range detail.Fields {
		keys[field.Key] = field.Type
	}
	for _, want := range []string{"headline", "detail", "priority", "updatedAt"} {
		if _, ok := keys[want]; !ok {
			t.Fatalf("field %q missing from definition-driven discovery: %#v", want, keys)
		}
	}

	// 6. Updating the configuration updates the stored payload.
	updateRaw, _ := json.Marshal(map[string]any{"headline": "All clear", "detail": "Normal operations.", "priority": "normal"})
	if _, err := service.UpdateDataSource(ctx, dataSource.ID, user, DataSourceInput{Provider: "district-note", Name: "District Status", Configuration: updateRaw}); err != nil {
		t.Fatalf("update manual object source: %v", err)
	}
	updated, err := service.PlayerTypedDataSourceConfiguration(ctx, dataSource.ID, "district-note", updateRaw)
	if err != nil {
		t.Fatal(err)
	}
	var updatedPayload TypedDatasetPayload
	if err := json.Unmarshal(updated, &updatedPayload); err != nil {
		t.Fatal(err)
	}
	if updatedPayload.Datasets[0].Values["headline"] != "All clear" {
		t.Fatalf("update did not refresh the stored payload: %#v", updatedPayload.Datasets[0].Values)
	}
}
