package httpapi

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// The target query runs through the ordinary pool, which prepares
// statements. It once passed an argument the SQL never referenced, and
// PostgreSQL refused to prepare it ("could not determine data type of
// parameter $1"), so every takeover activation answered 500.
func TestTakeoverTargetsResolveThroughAPreparedStatement(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	org := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Takeover Test',$1)`, org); err != nil {
		t.Fatal(err)
	}
	screen := func() uuid.UUID {
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Screen','linux','Test','Test','6.8','0.17.0',1920,1080,1,'en-US','UTC')`, id, org, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		return id
	}
	direct, member, other := screen(), screen(), screen()
	group := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name) VALUES($1,$2,'Lobby')`, group, org); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id) VALUES($1,$2)`, group, member); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	screens, err := takeoverScreens(ctx, tx, org, []uuid.UUID{direct}, []uuid.UUID{group})
	if err != nil {
		t.Fatalf("takeover targets: %v", err)
	}
	found := map[uuid.UUID]bool{}
	for _, id := range screens {
		found[id] = true
	}
	if len(screens) != 2 || !found[direct] || !found[member] || found[other] {
		t.Fatalf("targets resolved to %v, want %v and %v", screens, direct, member)
	}
	if none, err := takeoverScreens(ctx, tx, uuid.New(), []uuid.UUID{direct}, nil); err != nil || len(none) != 0 {
		t.Fatalf("another organization's screens: %v %v", none, err)
	}
}
