package backup

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestSnapshotPackagesPinsActivations(t *testing.T) {
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
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Backup Test',$1)`, uuid.New()); err != nil {
		t.Fatal(err)
	}

	empty, err := snapshotPackages(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("snapshot without packages = %d, want 0", len(empty))
	}

	digest := "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err = pool.Exec(ctx, `INSERT INTO installed_packages(organization_id,package_id,
		package_version,digest,source_kind,source_reference,registry_reference,
		signer_identity,trust_state,manifest)
		SELECT id,'acme.athletics','2.4.1',$1,'custom',
		'https://github.com/acme/tilecast-athletics','ghcr.io/acme/tilecast-athletics',
		'https://github.com/acme/tilecast-athletics/.github/workflows/release.yml',
		'verified','{}' FROM organization_settings WHERE singleton`, digest); err != nil {
		t.Fatal(err)
	}
	records, err := snapshotPackages(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("snapshot = %d records, want 1", len(records))
	}
	record := records[0]
	if record.PackageID != "acme.athletics" || record.PackageVersion != "2.4.1" ||
		record.Digest != digest || record.SourceKind != "custom" ||
		record.RegistryReference != "ghcr.io/acme/tilecast-athletics" ||
		record.SignerIdentity == "" || record.TrustState != "verified" {
		t.Fatalf("snapshot record = %+v", record)
	}
}
