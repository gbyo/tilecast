package backup

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

func TestRestoreDiscardsInterruptedUploadsOnly(t *testing.T) {
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
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE upload_sessions, organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Upload Restore", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	sessions := map[string]string{"pending": uuid.NewString(), "uploading": uuid.NewString(), "finalized": uuid.NewString()}
	for status, id := range sessions {
		if _, err = pool.Exec(ctx, `INSERT INTO upload_sessions(id,organization_id,created_by,original_filename,declared_mime_type,expected_size,temporary_storage_key,status,expires_at) VALUES($1,$2,$3,'a.png','image/png',10,$4,$5,now()+interval '1 hour')`, id, org, owner.User.ID, "uploads/"+id, status); err != nil {
			t.Fatal(err)
		}
	}
	if err = discardInterruptedUploads(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	var remaining []string
	rows, err := pool.Query(ctx, `SELECT status FROM upload_sessions ORDER BY status`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var status string
		if err := rows.Scan(&status); err != nil {
			t.Fatal(err)
		}
		remaining = append(remaining, status)
	}
	rows.Close()
	if len(remaining) != 1 || remaining[0] != "finalized" {
		t.Fatalf("sessions after restore = %v, want only the finalized one", remaining)
	}
}
