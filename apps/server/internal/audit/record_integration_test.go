package audit

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// TestRecordEnrichesFromContext proves the shared path end to end: the row
// names the human user from the context principal, the calling surface, the
// client, and the request ID, with no per-call attribution plumbing.
func TestRecordEnrichesFromContext(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := pool.Exec(ctx, `TRUNCATE device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	authService := auth.NewService(pool, time.Hour)
	owner, err := authService.Setup(ctx, auth.SetupInput{
		OrganizationName: "Audit Test",
		OwnerName:        "Owner",
		Username:         "audit-owner",
		Password:         "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	userID := owner.User.ID
	ctx = auth.WithPrincipal(ctx, auth.Principal{
		User:           auth.User{ID: userID, Role: "owner"},
		CredentialKind: auth.CredentialKindSession,
	})
	ctx = WithSurface(ctx, SurfaceStudio)
	ctx = WithRequest(ctx, "req-123")
	ctx = WithClient(ctx, "studio-web", "instance-1")
	if err := Record(ctx, pool, Event{
		Action:       "screens.replaced",
		ResourceType: "screen",
		ResourceID:   uuid.NewString(),
		Summary:      "Replaced through the shared path",
		Metadata:     map[string]any{"source": "test"},
	}); err != nil {
		t.Fatal(err)
	}
	var got struct {
		userID   *uuid.UUID
		surface  string
		request  string
		client   string
		instance string
		result   string
	}
	if err := pool.QueryRow(ctx, `SELECT user_id,calling_surface,request_id,client_id,client_instance,result
		FROM audit_logs WHERE action='screens.replaced' ORDER BY created_at DESC LIMIT 1`).Scan(
		&got.userID, &got.surface, &got.request, &got.client, &got.instance, &got.result); err != nil {
		t.Fatal(err)
	}
	if got.userID == nil || *got.userID != userID {
		t.Fatalf("user_id = %v, want %v", got.userID, userID)
	}
	if got.surface != "studio" || got.request != "req-123" || got.client != "studio-web" || got.instance != "instance-1" {
		t.Fatalf("attribution = %+v, want studio/req-123/studio-web/instance-1", got)
	}
	if got.result != ResultSuccess {
		t.Fatalf("result = %q, want success", got.result)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM audit_logs WHERE action='screens.replaced'`); err != nil {
		t.Fatal(err)
	}
}
