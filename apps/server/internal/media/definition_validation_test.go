package media

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestSchoolStatusDefinitionValidationIsGeneric(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("school-status")
	if !ok {
		t.Fatal("School Status definition is missing")
	}
	normalizer := definitionConfigNormalizer{schema: definition.ConfigurationSchema}
	normalized, err := normalizer.Normalize(context.Background(), json.RawMessage(`{
		"status":"Delayed","message":"Opening at 10:00 AM","severity":"notice",
		"effectiveAt":"","expiresAt":""
	}`))
	if err != nil {
		t.Fatal(err)
	}
	values := normalized.(map[string]any)
	if values["severity"] != "notice" {
		t.Fatalf("unexpected normalized configuration: %#v", values)
	}
	if _, err = normalizer.Normalize(context.Background(), json.RawMessage(`{"status":"Open","message":"Normal","severity":"invalid","unknown":true}`)); err == nil {
		t.Fatal("unknown key or invalid enum was accepted")
	}
}

func TestStatusMessageDefinitionAndRolesAreGeneric(t *testing.T) {
	catalog := contentdefs.MustLoad()
	status, ok := catalog.DataSource("status-message")
	if !ok || status.AdapterID != "manual_object" {
		t.Fatalf("Status Message must use the generic manual_object adapter: %+v", status)
	}
	old, ok := catalog.DataSource("school-status")
	if !ok || !old.Deprecation.Deprecated || old.Deprecation.Replacement != "status-message" {
		t.Fatalf("School Status must remain available as a deprecated source: %+v", old)
	}
	roles := map[string]string{}
	for _, field := range status.OutputSchema.Fields {
		roles[field.Key] = field.Role
	}
	for key, want := range map[string]string{
		"status": "status", "message": "message", "severity": "severity",
		"effectiveAt": "effective_at", "expiresAt": "expires_at", "updatedAt": "updated_at",
	} {
		if roles[key] != want {
			t.Errorf("field %q role = %q, want %q", key, roles[key], want)
		}
	}
	fields := outputDataSourceFields(status.OutputSchema, nil)
	projected := map[string]string{}
	for _, field := range fields {
		projected[field.Key] = field.Role
	}
	if projected["status"] != "status" || projected["updatedAt"] != "updated_at" {
		t.Fatalf("field discovery dropped semantic roles: %#v", projected)
	}
}

func TestManualObjectPreviewUsesTheSelectedDateForGeneratedTimestamp(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("status-message")
	if !ok {
		t.Fatal("Status Message definition is missing")
	}
	updatedAt := previewTimeOrNow("2026-09-24", "UTC", time.Now())
	payload := manualObjectPayload(definition, map[string]any{"status": "Delayed", "message": "Opening late"}, updatedAt)
	if got := payload.Datasets[0].Values["updatedAt"]; got != "2026-09-24T00:00:00Z" {
		t.Fatalf("preview updatedAt = %q", got)
	}
}
