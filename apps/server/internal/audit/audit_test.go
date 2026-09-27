package audit

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// TestNoDirectAuditInserts prohibits new direct INSERT INTO audit_logs calls
// in production code. The shared Record path enriches every row with
// attribution from context, so a hand-written INSERT silently drops the
// calling surface, the client, and the request ID. The one owned INSERT
// lives in this package's audit.go; every other production file must call
// Record instead.
func TestNoDirectAuditInserts(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	ownDir := filepath.Dir(file)
	// apps/server/internal/audit -> apps/server
	root := filepath.Join(ownDir, "..", "..")
	// legacyDirectWriters predate the shared path and migrate gradually as
	// their domains change. Every domain that new CLI functionality touches
	// must leave this list before that functionality ships. Files not listed
	// here must call audit.Record; the test fails otherwise.
	legacyDirectWriters := map[string]bool{
		"internal/approvals/approvals.go":           true,
		"internal/auth/mfa.go":                      true,
		"internal/auth/service.go":                  true,
		"internal/backup/worker.go":                 true,
		"internal/campaigns/service.go":             true,
		"internal/demo/builder.go":                  true,
		"internal/devices/credentials.go":           true,
		"internal/devices/locations.go":             true,
		"internal/devices/scopes.go":                true,
		"internal/devices/service.go":               true,
		"internal/fleetops/apply.go":                true,
		"internal/httpapi/activity_audit.go":        true,
		"internal/httpapi/activity_retention.go":    true,
		"internal/httpapi/airplay.go":               true,
		"internal/httpapi/airplay_reconcile.go":     true,
		"internal/httpapi/content_reviews.go":       true,
		"internal/httpapi/github_configuration.go":  true,
		"internal/httpapi/incident_api.go":          true,
		"internal/httpapi/integrations.go":          true,
		"internal/httpapi/login_background.go":      true,
		"internal/httpapi/notifications.go":         true,
		"internal/httpapi/operations.go":            true,
		"internal/httpapi/presentation_networks.go": true,
		"internal/httpapi/reliability.go":           true,
		"internal/httpapi/settings.go":              true,
		"internal/httpapi/updates.go":               true,
		"internal/httpapi/users.go":                 true,
		"internal/layouts/service.go":               true,
		"internal/media/datasources.go":             true,
		"internal/media/organization.go":            true,
		"internal/media/private_assets.go":          true,
		"internal/media/service.go":                 true,
		"internal/media/website.go":                 true,
		"internal/media/widget_apps.go":             true,
		"internal/media/widgets.go":                 true,
		"internal/playlists/service.go":             true,
		"internal/plugins/installation.go":          true,
		"internal/presentations/service.go":         true,
		"internal/scheduling/service.go":            true,
		"internal/settings/service.go":              true,
		"internal/span/service.go":                  true,
		"internal/takeovers/service.go":             true,
	}
	var offenders []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		if filepath.Dir(path) == ownDir && filepath.Base(path) == "audit.go" {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(strings.ToUpper(string(raw)), "INSERT INTO AUDIT_LOGS") {
			rel, _ := filepath.Rel(root, path)
			if !legacyDirectWriters[rel] {
				offenders = append(offenders, rel)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(offenders) > 0 {
		t.Fatalf("direct INSERT INTO audit_logs in production code; use audit.Record instead:\n%s", strings.Join(offenders, "\n"))
	}
}

type stubDB struct{}

func (stubDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

// TestRecordValidation rejects events without attribution.
func TestRecordValidation(t *testing.T) {
	var db stubDB
	if err := Record(context.Background(), db, Event{}); err == nil {
		t.Fatal("empty event succeeded, want an error")
	}
	if err := Record(context.Background(), db, Event{Action: "x"}); err == nil {
		t.Fatal("event without resource type succeeded, want an error")
	}
	system := Event{Action: "prune", ResourceType: "job", Surface: SurfaceSystem}
	if err := Record(context.Background(), db, system); err == nil {
		t.Fatal("system event without actor succeeded, want an error")
	}
}

// TestSurfaceDefaultsToStudio keeps the browser contract: requests without
// an explicit surface attribute to Studio.
func TestSurfaceDefaultsToStudio(t *testing.T) {
	if got := SurfaceFrom(context.Background()); got != SurfaceStudio {
		t.Fatalf("default surface = %q, want studio", got)
	}
	ctx := WithSurface(context.Background(), SurfaceCLI)
	if got := SurfaceFrom(ctx); got != SurfaceCLI {
		t.Fatalf("surface = %q, want cli", got)
	}
}

// TestPrincipalSuppliesHumanUser documents the attribution rule: the
// context principal supplies the human user for session, CLI, and MCP
// credentials alike, while system work names its actor explicitly.
func TestPrincipalSuppliesHumanUser(t *testing.T) {
	ctx := auth.WithPrincipal(context.Background(), auth.PrincipalFromSession(auth.Session{}))
	if _, ok := auth.PrincipalFrom(ctx); !ok {
		t.Fatal("principal missing from context")
	}
}
