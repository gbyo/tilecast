package media

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// messageNoteCatalog adds a manual_object Data Source that exposes only a
// message, the smallest source Alert Banner must accept.
func messageNoteCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	source := contentdefs.DataSourceDefinition{
		ID: "message-note", Version: 1, Name: "Message Note", Category: "Test",
		AdapterID:           "manual_object",
		RequiresManifestV13: true,
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "message", Label: "Message", Control: "text", Required: true, MaxLength: 300, Default: "Welcome"},
		}},
		DefaultConfiguration: map[string]any{"message": "Welcome"},
		OutputSchema: contentdefs.OutputSchema{Kind: "object", Fields: []contentdefs.OutputField{
			{Key: "message", Label: "Message", Type: "text", Required: true},
			{Key: "updatedAt", Label: "Updated time", Type: "datetime", Required: true},
		}},
	}
	builtin := contentdefs.MustLoad()
	catalog, err := contentdefs.New(builtin.Widgets, append(append([]contentdefs.DataSourceDefinition(nil), builtin.DataSources...), source))
	if err != nil {
		t.Fatalf("build message-note catalog: %v", err)
	}
	return catalog
}

func widgetConfiguration(t *testing.T, service *Service, assetID string) map[string]any {
	t.Helper()
	var raw []byte
	if err := service.db.QueryRow(t.Context(), `SELECT configuration FROM widgets WHERE asset_id=$1`, assetID).Scan(&raw); err != nil {
		t.Fatalf("read widget configuration: %v", err)
	}
	var configuration map[string]any
	if err := json.Unmarshal(raw, &configuration); err != nil {
		t.Fatal(err)
	}
	return configuration
}

// TestStatusIsPanelOnlyAndAlertBannerNeedsOnlyAMessage proves the write path:
// Status cannot be created or updated into the banner style, and Alert Banner
// saves against a source that has no severity.
func TestStatusIsPanelOnlyAndAlertBannerNeedsOnlyAMessage(t *testing.T) {
	ctx, service, user, _, _ := nestedValidationService(t)
	service.SetContentDefinitions(messageNoteCatalog(t))

	statusRaw, _ := json.Marshal(map[string]any{"status": "Open", "message": "Normal hours.", "severity": "normal", "effectiveAt": "", "expiresAt": ""})
	full, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "status-message", Name: "Status Message", Configuration: statusRaw})
	if err != nil {
		t.Fatalf("create Status Message source: %v", err)
	}
	messageOnly, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "message-note", Name: "Message only", Configuration: json.RawMessage(`{"message":"Parking lot B is closed."}`)})
	if err != nil {
		t.Fatalf("create message-only source: %v", err)
	}

	statusConfig := func(style string) json.RawMessage {
		return json.RawMessage(`{"dataSourceId":"` + full.ID.String() + `","style":"` + style + `","statusField":"status","messageField":"message","severityField":"severity"}`)
	}
	refused := func(err error) bool {
		var configurationError *ConfigurationError
		return errors.As(err, &configurationError) && strings.Contains(err.Error(), "invalid selection")
	}

	// Create.
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "status", Name: "Banner Status", Configuration: statusConfig("banner")}); !refused(err) {
		t.Fatalf("creating a Status banner: error %v, want an invalid selection", err)
	}
	panel, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "status", Name: "Panel Status", Configuration: statusConfig("panel")})
	if err != nil {
		t.Fatalf("create panel Status: %v", err)
	}
	if got := widgetConfiguration(t, service, panel.ID.String())["style"]; got != "panel" {
		t.Fatalf("stored Status style = %v, want panel", got)
	}

	// Update.
	if _, err := service.UpdateWidget(ctx, panel.ID, user, WidgetInput{Provider: "status", Name: "Panel Status", Configuration: statusConfig("banner")}); !refused(err) {
		t.Fatalf("updating a Status to banner: error %v, want an invalid selection", err)
	}
	if got := widgetConfiguration(t, service, panel.ID.String())["style"]; got != "panel" {
		t.Fatalf("a refused update changed the stored style to %v", got)
	}

	// Alert Banner with no severity or label mapped.
	messageOnlyConfig := json.RawMessage(`{"dataSourceId":"` + messageOnly.ID.String() + `","messageField":"message","severityField":"","labelField":"","showSeverity":true}`)
	banner, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "alert-banner", Name: "Parking alert", Configuration: messageOnlyConfig})
	if err != nil {
		t.Fatalf("create a message-only Alert Banner: %v", err)
	}
	stored := widgetConfiguration(t, service, banner.ID.String())
	if stored["messageField"] != "message" || stored["severityField"] != "" || stored["labelField"] != "" {
		t.Fatalf("message-only mapping was not kept: %v", stored)
	}
	if _, err := service.UpdateWidget(ctx, banner.ID, user, WidgetInput{Provider: "alert-banner", Name: "Parking alert", Configuration: messageOnlyConfig}); err != nil {
		t.Fatalf("resave a message-only Alert Banner: %v", err)
	}

	// A mapped field the source does not expose is still refused; Studio's
	// automatic mapping clears it when a source without severity is chosen.
	mapped := json.RawMessage(`{"dataSourceId":"` + messageOnly.ID.String() + `","messageField":"message","severityField":"severity"}`)
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "alert-banner", Name: "Bad mapping", Configuration: mapped}); err == nil || !strings.Contains(err.Error(), "does not expose") {
		t.Fatalf("a severity field the source lacks: error %v, want does-not-expose", err)
	}

	// A richer source maps every optional field.
	richConfig := json.RawMessage(`{"dataSourceId":"` + full.ID.String() + `","messageField":"message","severityField":"severity","labelField":"status","showSeverity":true}`)
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "alert-banner", Name: "Weather alert", Configuration: richConfig}); err != nil {
		t.Fatalf("create a full Alert Banner: %v", err)
	}

	// Alert Banner has no style: it is not a second way to author Status.
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "alert-banner", Name: "Styled", Configuration: json.RawMessage(`{"dataSourceId":"` + full.ID.String() + `","style":"banner"}`)}); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("Alert Banner accepted a style: %v", err)
	}
}
