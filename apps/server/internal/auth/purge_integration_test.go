package auth_test

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

func TestPurgeExpiredSessionsAndChallenges(t *testing.T) {
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
		t.Fatalf("apply migrations: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE mfa_challenges, sessions, organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Purge Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}

	// Live and expired session rows; the owner's own live session stays.
	expiredSession, liveSession := uuid.New(), uuid.New()
	for _, row := range []struct {
		id      uuid.UUID
		expires string
	}{{expiredSession, "now() - interval '1 minute'"}, {liveSession, "now() + interval '1 hour'"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,'csrf',`+row.expires+`)`,
			row.id, owner.User.ID, []byte(uuid.NewString())); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct {
		expires string
	}{{"now() - interval '1 minute'"}, {"now() + interval '5 minutes'"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO mfa_challenges(id,user_id,token_hash,purpose,expires_at) VALUES($1,$2,$3,'login',`+row.expires+`)`,
			uuid.New(), owner.User.ID, []byte(uuid.NewString())); err != nil {
			t.Fatal(err)
		}
	}

	service := auth.NewService(pool, time.Hour)
	if err := service.PurgeExpiredSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if err := service.PurgeExpiredChallenges(ctx); err != nil {
		t.Fatal(err)
	}
	var expired, live, challenges int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id=$1`, expiredSession).Scan(&expired); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id=$1`, liveSession).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mfa_challenges`).Scan(&challenges); err != nil {
		t.Fatal(err)
	}
	if expired != 0 || live != 1 {
		t.Fatalf("sessions: expired rows=%d live rows=%d, want 0 and 1", expired, live)
	}
	if challenges != 1 {
		t.Fatalf("challenges after purge = %d, want 1 (the live one)", challenges)
	}
}
