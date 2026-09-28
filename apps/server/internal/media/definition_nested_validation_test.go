package media

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// nestedValidationService boots a clean database with two manual sources:
// scores exposes label (text) and score (number); places exposes city
// (text). The sources have disjoint field keys so a test can prove which
// source a nested selection validated against.
func nestedValidationService(t *testing.T) (context.Context, *Service, uuid.UUID, string, string) {
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
	t.Cleanup(lockPool.Close)
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lock.Release)
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7422000)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lock.Exec(ctx, `SELECT pg_advisory_unlock(7422000)`) }) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `TRUNCATE data_source_refresh_states,data_sources,widgets,website_assets,asset_variants,assets,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Nested", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, nil, Config{Website: WebsitePolicy{DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500}, SourceFetch: SourceFetchPolicy{AllowPrivateNetworks: true, Timeout: 5 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour}})
	user := owner.User.ID

	scoresConfig, _ := json.Marshal(ManualSourceConfig{
		Columns: []ManualColumn{{Key: "label", Label: "Label", Type: "text"}, {Key: "score", Label: "Score", Type: "number"}, {Key: "happened", Label: "Happened", Type: "date"}},
		Rows:    []ManualRow{{ID: "d43f00ab-b7d9-4c39-a67b-24f7649c558d", Values: map[string]string{"label": "A", "score": "10", "happened": "2026-09-28"}}},
	})
	scores, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "manual", Name: "Scores", Configuration: scoresConfig})
	if err != nil {
		t.Fatalf("create scores source: %v", err)
	}
	placesConfig, _ := json.Marshal(ManualSourceConfig{
		Columns: []ManualColumn{{Key: "city", Label: "City", Type: "text"}},
		Rows:    []ManualRow{{ID: "e53f00ab-b7d9-4c39-a67b-24f7649c558e", Values: map[string]string{"city": "Springfield"}}},
	})
	places, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "manual", Name: "Places", Configuration: placesConfig})
	if err != nil {
		t.Fatalf("create places source: %v", err)
	}
	return ctx, service, user, scores.ID.String(), places.ID.String()
}

func nestedMetricsSchema(extra ...contentdefs.FieldDefinition) contentdefs.ConfigurationSchema {
	fields := []contentdefs.FieldDefinition{
		{Key: "dataSourceId", Label: "Data Source", Control: "data_source"},
		{Key: "metrics", Label: "Metrics", Control: "repeating_group", MaximumItems: 6, ItemFields: []contentdefs.FieldDefinition{
			{Key: "valueField", Label: "Value field", Control: "data_source_field", Required: true, DataSourceKey: "dataSourceId", DataSourceFieldTypes: []string{"number", "integer", "currency", "percent"}},
			{Key: "labelField", Label: "Label field", Control: "data_source_field", DataSourceKey: "dataSourceId"},
		}},
	}
	return contentdefs.ConfigurationSchema{Fields: append(fields, extra...)}
}

// TestNestedDataSourceFieldValidation proves the generic Server check walks
// repeating-group item fields with the same source-aware semantics as
// top-level fields: existence, type, explicit source resolution, ambiguous
// fail-closed behavior, indexed error paths, and malformed items.
func TestNestedDataSourceFieldValidation(t *testing.T) {
	ctx, service, userID, scoresID, placesID := nestedValidationService(t)

	normalize := func(schema contentdefs.ConfigurationSchema, raw string) error {
		normalizer := definitionConfigNormalizer{service: service, schema: schema}
		_, err := normalizer.Normalize(ctx, json.RawMessage(raw))
		return err
	}
	single := nestedMetricsSchema()
	valid := `{"dataSourceId":"` + scoresID + `","metrics":[{"valueField":"score","labelField":"label"}]}`
	if err := normalize(single, valid); err != nil {
		t.Fatalf("explicit valid nested selection was rejected: %v", err)
	}

	if err := normalize(single, `{"dataSourceId":"`+scoresID+`","metrics":[{"valueField":"label","labelField":"label"}]}`); err == nil || !strings.Contains(err.Error(), "requires a field of type") {
		t.Fatalf("expected a wrong nested field type to be rejected, got %v", err)
	}
	if err := normalize(single, `{"dataSourceId":"`+scoresID+`","metrics":[{"valueField":"missing","labelField":"label"}]}`); err == nil || !strings.Contains(err.Error(), "does not expose") {
		t.Fatalf("expected a missing nested field to be rejected, got %v", err)
	}
	if err := normalize(single, `{"dataSourceId":"`+scoresID+`","metrics":[{"valueField":"","labelField":"label"}]}`); err == nil {
		t.Fatal("expected a missing required nested selection to be rejected")
	}
	if err := normalize(single, `{"dataSourceId":"`+scoresID+`","metrics":[{"valueField":"score"},{"valueField":"missing"}]}`); err == nil || !strings.Contains(err.Error(), "metrics[1].") {
		t.Fatalf("expected the second item to fail with an indexed path, got %v", err)
	}
	if err := normalize(single, `{"dataSourceId":"`+scoresID+`","metrics":["oops"]}`); err == nil {
		t.Fatal("expected a malformed nested item to be rejected")
	}

	// Without an explicit key the relationship is ambiguous: a populated
	// selection fails closed instead of validating against the wrong source.
	ambiguousFields := []contentdefs.FieldDefinition{
		{Key: "dataSourceId", Label: "Data Source", Control: "data_source"},
		{Key: "secondSource", Label: "Second", Control: "data_source"},
		{Key: "metrics", Label: "Metrics", Control: "repeating_group", MaximumItems: 6, ItemFields: []contentdefs.FieldDefinition{
			{Key: "valueField", Label: "Value field", Control: "data_source_field", DataSourceFieldTypes: []string{"text"}},
		}},
	}
	ambiguous := contentdefs.ConfigurationSchema{Fields: ambiguousFields}
	if err := normalize(ambiguous, `{"dataSourceId":"`+scoresID+`","secondSource":"`+placesID+`","metrics":[{"valueField":"city"}]}`); err == nil || !strings.Contains(err.Error(), "does not identify which Data Source") {
		t.Fatalf("expected an ambiguous nested selection to fail closed, got %v", err)
	}
	if err := normalize(ambiguous, `{"dataSourceId":"`+scoresID+`","secondSource":"`+placesID+`","metrics":[{"valueField":""}]}`); err != nil {
		t.Fatalf("expected an empty ambiguous selection to be skipped, got %v", err)
	}

	// An explicit key selects the second source: city validates, score does not.
	keyedFields := []contentdefs.FieldDefinition{
		{Key: "dataSourceId", Label: "Data Source", Control: "data_source"},
		{Key: "secondSource", Label: "Second", Control: "data_source"},
		{Key: "metrics", Label: "Metrics", Control: "repeating_group", MaximumItems: 6, ItemFields: []contentdefs.FieldDefinition{
			{Key: "valueField", Label: "Value field", Control: "data_source_field", DataSourceKey: "secondSource", DataSourceFieldTypes: []string{"text"}},
		}},
	}
	keyed := contentdefs.ConfigurationSchema{Fields: keyedFields}
	if err := normalize(keyed, `{"dataSourceId":"`+scoresID+`","secondSource":"`+placesID+`","metrics":[{"valueField":"city"}]}`); err != nil {
		t.Fatalf("expected the explicit second source to validate city, got %v", err)
	}
	if err := normalize(keyed, `{"dataSourceId":"`+scoresID+`","secondSource":"`+placesID+`","metrics":[{"valueField":"score"}]}`); err == nil || !strings.Contains(err.Error(), "does not expose") {
		t.Fatalf("expected score to fail against the second source, got %v", err)
	}

	// End to end through the public API: Table columns are nested
	// data_source_field controls with an explicit key.
	tableRaw := json.RawMessage(`{"dataSourceId":"` + scoresID + `","columns":[{"field":"missing","label":"","align":"auto"}]}`)
	if _, err := service.CreateWidget(ctx, userID, WidgetInput{Provider: "table", Name: "Bad column", Configuration: tableRaw}); err == nil || !strings.Contains(err.Error(), "columns[0].") {
		t.Fatalf("expected table to reject a nested missing field with an indexed path, got %v", err)
	}
}
