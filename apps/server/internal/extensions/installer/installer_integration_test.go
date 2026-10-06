package installer

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

const testManifest = `{
  "apiVersion": 1,
  "packageId": "acme.athletics",
  "packageVersion": "2.4.1",
  "name": "Athletics",
  "description": "Scoreboards, schedules and game information.",
  "publisher": {"id": "acme", "name": "Acme Athletics"},
  "repository": "https://github.com/acme/tilecast-athletics",
  "license": "MIT",
  "tilecast": {"version": ">=1.2.0 <2.0.0"},
  "distribution": {"oci": "ghcr.io/acme/tilecast-athletics"},
  "contributions": [
    {"type": "plugin", "path": "./plugin"},
    {"type": "widget", "path": "./widgets/scoreboard"},
    {"type": "dataSource", "path": "./data-sources/schedule"}
  ]
}`

const (
	testDigestV1 = "sha256:" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testDigestV2 = "sha256:" + "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
)

type installerFixture struct {
	pool    *pgxpool.Pool
	service *Service
	userID  uuid.UUID
}

func newInstallerFixture(t *testing.T, options ...Option) *installerFixture {
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
	f := &installerFixture{pool: pool, userID: uuid.New()}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Package Test',$1)`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','package-owner','unused','owner',TRUE)`, f.userID); err != nil {
		t.Fatal(err)
	}
	f.service = NewService(pool, "1.5.0", options...)
	return f
}

func testActivation(version, digest string) Activation {
	manifest, err := packagemanifest.Parse([]byte(strings.Replace(testManifest, `"2.4.1"`, `"`+version+`"`, 1)))
	if err != nil {
		panic(err)
	}
	return Activation{
		Manifest:          manifest,
		Digest:            digest,
		SourceKind:        SourceCustom,
		SourceReference:   "https://github.com/acme/tilecast-athletics",
		RegistryReference: "ghcr.io/acme/tilecast-athletics",
		SignerIdentity:    "https://github.com/acme/tilecast-athletics/.github/workflows/release.yml",
		Trust:             TrustVerified,
		Contributions: []Contribution{
			{Kind: "widget", ID: "acme.athletics.scoreboard", Path: "./widgets/scoreboard"},
			{Kind: "dataSource", ID: "acme.athletics.schedule", Path: "./data-sources/schedule"},
		},
	}
}

func TestActivateInstallUpdateRollbackRemove(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()

	installed, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1))
	if err != nil {
		t.Fatal(err)
	}
	if installed.Version != "2.4.1" || installed.Digest != testDigestV1 || installed.HasPrevious {
		t.Fatalf("install = %+v", installed)
	}
	contributions, err := f.service.Contributions(ctx, "acme.athletics")
	if err != nil {
		t.Fatal(err)
	}
	if len(contributions) != 2 {
		t.Fatalf("contributions = %d, want 2", len(contributions))
	}

	updated, err := f.service.Activate(ctx, testActivation("2.5.0", testDigestV2))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != "2.5.0" || !updated.HasPrevious {
		t.Fatalf("update = %+v", updated)
	}

	rolledBack, err := f.service.Rollback(ctx, "acme.athletics", f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack.Version != "2.4.1" || rolledBack.Digest != testDigestV1 || rolledBack.HasPrevious {
		t.Fatalf("rollback = %+v", rolledBack)
	}
	contributions, err = f.service.Contributions(ctx, "acme.athletics")
	if err != nil {
		t.Fatal(err)
	}
	if len(contributions) != 2 || contributions[0].ID != "acme.athletics.schedule" {
		t.Fatalf("contributions after rollback = %+v", contributions)
	}

	if err := f.service.Remove(ctx, "acme.athletics", f.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Get(ctx, "acme.athletics"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after remove = %v, want ErrNotFound", err)
	}
	listed, err := f.service.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 0 {
		t.Fatalf("List after remove = %d, want 0", len(listed))
	}
}

func TestActivateRefusesIncompatibleUnsignedForeignAndColliding(t *testing.T) {
	f := newInstallerFixture(t, WithReserved(func(kind, id string) (string, bool) {
		if id == "acme.athletics.schedule" {
			return "release data source acme.athletics.schedule", true
		}
		return "", false
	}))
	ctx := context.Background()

	// Incompatible with the running release.
	activation := testActivation("2.4.1", testDigestV1)
	activation.Manifest.Tilecast.Version = ">=9.0.0"
	if _, err := f.service.Activate(ctx, activation); !errors.Is(err, ErrIncompatible) {
		t.Fatalf("incompatible = %v, want ErrIncompatible", err)
	}

	// Unsigned without the development allowance.
	activation = testActivation("2.4.1", testDigestV1)
	activation.Trust = TrustUnsignedDevelopment
	if _, err := f.service.Activate(ctx, activation); !errors.Is(err, ErrUnsignedRejected) {
		t.Fatalf("unsigned = %v, want ErrUnsignedRejected", err)
	}

	// Contribution outside the package namespace.
	activation = testActivation("2.4.1", testDigestV1)
	activation.Contributions[0].ID = "other.scoreboard"
	if _, err := f.service.Activate(ctx, activation); !errors.Is(err, ErrNamespace) {
		t.Fatalf("foreign = %v, want ErrNamespace", err)
	}

	// Contribution the release already supplies.
	activation = testActivation("2.4.1", testDigestV1)
	if _, err := f.service.Activate(ctx, activation); !errors.Is(err, ErrCollision) {
		t.Fatalf("reserved = %v, want ErrCollision", err)
	}

	// Floating tags and malformed digests never persist.
	activation = testActivation("2.4.1", testDigestV1)
	activation.Contributions = activation.Contributions[1:]
	activation.Digest = "v2.4.1"
	if _, err := f.service.Activate(ctx, activation); !errors.Is(err, ErrInvalid) {
		t.Fatalf("tag digest = %v, want ErrInvalid", err)
	}

	// Nothing above may have left rows behind.
	listed, err := f.service.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 0 {
		t.Fatalf("List after refused activations = %d, want 0", len(listed))
	}
}

func TestActivateRefusesPackageToPackageCollision(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()
	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}
	other := `{
  "apiVersion": 1,
  "packageId": "other.club",
  "packageVersion": "1.0.0",
  "name": "Club",
  "description": "Another package claiming the same Widget.",
  "publisher": {"id": "other", "name": "Other"},
  "repository": "https://github.com/other/tilecast-club",
  "license": "MIT",
  "tilecast": {"version": ">=1.0.0"},
  "distribution": {"oci": "ghcr.io/other/tilecast-club"},
  "contributions": [{"type": "widget", "path": "./widgets/scoreboard"}]
}`
	manifest, err := packagemanifest.Parse([]byte(other))
	if err != nil {
		t.Fatal(err)
	}
	second := func() Activation {
		return Activation{
			Manifest:          manifest,
			Digest:            testDigestV2,
			SourceKind:        SourceCustom,
			SourceReference:   "https://github.com/other/tilecast-club",
			RegistryReference: "ghcr.io/other/tilecast-club",
			Trust:             TrustVerified,
			Contributions: []Contribution{
				{Kind: "widget", ID: "other.club.scoreboard", Path: "./widgets/scoreboard"},
			},
		}
	}
	// A foreign ID fails the namespace rule before any collision check.
	foreign := second()
	foreign.Contributions = []Contribution{
		{Kind: "widget", ID: "acme.athletics.scoreboard", Path: "./widgets/foreign"},
	}
	if _, err := f.service.Activate(ctx, foreign); !errors.Is(err, ErrNamespace) {
		t.Fatalf("foreign id = %v, want ErrNamespace", err)
	}
	// The same shape inside its own namespace installs cleanly.
	if _, err := f.service.Activate(ctx, second()); err != nil {
		t.Fatalf("second package install = %v", err)
	}
	// A third package whose own namespace contains the same Widget identity
	// collides at the row: one identity, one supplier.
	third, err := packagemanifest.Parse([]byte(strings.Replace(other,
		`"packageId": "other.club"`, `"packageId": "other.club.scoreboard"`, 1)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Activate(ctx, Activation{
		Manifest:          third,
		Digest:            testDigestV1,
		SourceKind:        SourceCustom,
		SourceReference:   "https://github.com/other/tilecast-club",
		RegistryReference: "ghcr.io/other/tilecast-club",
		Trust:             TrustVerified,
		Contributions: []Contribution{
			{Kind: "widget", ID: "other.club.scoreboard", Path: "./widgets/scoreboard"},
		},
	}); !errors.Is(err, ErrCollision) {
		t.Fatalf("package collision = %v, want ErrCollision", err)
	}
}

func TestRollbackNeedsPreviousActivation(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()
	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Rollback(ctx, "acme.athletics", f.userID); !errors.Is(err, ErrNoRollback) {
		t.Fatalf("rollback without update = %v, want ErrNoRollback", err)
	}
	if _, err := f.service.Rollback(ctx, "no.such", f.userID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rollback unknown = %v, want ErrNotFound", err)
	}
}

func TestUnsignedDevelopmentInstallsWhenAllowed(t *testing.T) {
	f := newInstallerFixture(t, WithUnsignedDevelopmentAllowed())
	ctx := context.Background()
	activation := testActivation("2.4.1", testDigestV1)
	activation.Trust = TrustUnsignedDevelopment
	activation.SignerIdentity = ""
	installed, err := f.service.Activate(ctx, activation)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Trust != TrustUnsignedDevelopment {
		t.Fatalf("trust = %s", installed.Trust)
	}
}

func TestActivationWritesAuditRecords(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()
	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Activate(ctx, testActivation("2.5.0", testDigestV2)); err != nil {
		t.Fatal(err)
	}
	var actions []string
	rows, err := f.pool.Query(ctx, `SELECT action FROM audit_logs WHERE resource_type='package' ORDER BY action, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(actions) != 2 || actions[0] != "package.installed" || actions[1] != "package.updated" {
		t.Fatalf("audit actions = %v", actions)
	}
	var digest string
	if err := f.pool.QueryRow(ctx, `SELECT metadata->>'digest' FROM audit_logs WHERE action='package.updated'`).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if digest != testDigestV2 {
		t.Fatalf("audit digest = %s", digest)
	}
}
