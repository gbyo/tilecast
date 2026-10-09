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
			{Kind: "plugin", ID: "acme.athletics", Path: "./plugin"},
			{Kind: "widget", ID: "acme.athletics.scoreboard", Path: "./widgets/scoreboard"},
			{Kind: "dataSource", ID: "acme.athletics.schedule", Path: "./data-sources/schedule"},
		},
	}
}

func TestActivateInstallUpdateRollbackRemove(t *testing.T) {
	f := newInstallerFixture(t, WithUnsignedDevelopmentAllowed())
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
	if len(contributions) != 3 {
		t.Fatalf("contributions = %d, want 3", len(contributions))
	}

	update := testActivation("2.5.0", testDigestV2)
	update.SourceKind = SourceMarketplace
	update.SourceReference = "marketplace:acme.athletics"
	update.RegistryReference = "registry.example.test/acme/athletics"
	update.SignerIdentity = ""
	update.Trust = TrustUnsignedDevelopment
	updated, err := f.service.Activate(ctx, update)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != "2.5.0" || !updated.HasPrevious ||
		updated.SourceKind != SourceMarketplace ||
		updated.Trust != TrustUnsignedDevelopment {
		t.Fatalf("update = %+v", updated)
	}

	rolledBack, err := f.service.Rollback(ctx, "acme.athletics", f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack.Version != "2.4.1" ||
		rolledBack.Digest != testDigestV1 ||
		rolledBack.HasPrevious ||
		rolledBack.SourceKind != SourceCustom ||
		rolledBack.SourceReference != "https://github.com/acme/tilecast-athletics" ||
		rolledBack.RegistryReference != "ghcr.io/acme/tilecast-athletics" ||
		rolledBack.SignerIdentity != "https://github.com/acme/tilecast-athletics/.github/workflows/release.yml" ||
		rolledBack.Trust != TrustVerified {
		t.Fatalf("rollback did not restore full provenance: %+v", rolledBack)
	}
	contributions, err = f.service.Contributions(ctx, "acme.athletics")
	if err != nil {
		t.Fatal(err)
	}
	if len(contributions) != 3 {
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
	activation.SignerIdentity = ""
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

func TestActivateBindsDerivedContributionsToManifest(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()

	missing := testActivation("2.4.1", testDigestV1)
	missing.Contributions = missing.Contributions[1:]
	if _, err := f.service.Activate(ctx, missing); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing declaration = %v, want ErrInvalid", err)
	}

	undeclared := testActivation("2.4.1", testDigestV1)
	undeclared.Contributions[1].Path = "./widgets/other"
	if _, err := f.service.Activate(ctx, undeclared); !errors.Is(err, ErrInvalid) {
		t.Fatalf("undeclared path = %v, want ErrInvalid", err)
	}

	wrongKind := testActivation("2.4.1", testDigestV1)
	wrongKind.Contributions[1].Kind = "dataSource"
	if _, err := f.service.Activate(ctx, wrongKind); !errors.Is(err, ErrInvalid) {
		t.Fatalf("undeclared kind/path pair = %v, want ErrInvalid", err)
	}
}

func TestActivateEnforcesTrustSignerConsistency(t *testing.T) {
	ctx := context.Background()

	verified := newInstallerFixture(t)
	activation := testActivation("2.4.1", testDigestV1)
	activation.SignerIdentity = ""
	if _, err := verified.service.Activate(ctx, activation); !errors.Is(err, ErrInvalid) {
		t.Fatalf("verified without signer = %v, want ErrInvalid", err)
	}

	development := newInstallerFixture(t, WithUnsignedDevelopmentAllowed())
	activation = testActivation("2.4.1", testDigestV1)
	activation.Trust = TrustUnsignedDevelopment
	if _, err := development.service.Activate(ctx, activation); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unsigned with signer = %v, want ErrInvalid", err)
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
			SignerIdentity:    "https://github.com/other/tilecast-club/.github/workflows/release.yml",
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
		SignerIdentity:    "https://github.com/other/tilecast-club/.github/workflows/release.yml",
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

func TestRemoveBlockedByContributedContent(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()

	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}
	var organizationID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM organization_settings LIMIT 1`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	widgetID := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)
		VALUES($1,$2,'Widget','widget','widget.json','application/json',$3,10,'ready',$4)`,
		widgetID, organizationID, make([]byte, 32), f.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO widgets(asset_id,provider,configuration)
		VALUES($1,'acme.athletics.scoreboard','{}'::jsonb)`, widgetID); err != nil {
		t.Fatal(err)
	}
	dataSourceID := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)
		VALUES($1,$2,'Schedule','acme.athletics.schedule','{}'::jsonb,$3)`, dataSourceID, organizationID, f.userID); err != nil {
		t.Fatal(err)
	}

	err := f.service.Remove(ctx, "acme.athletics", f.userID)
	var inUse *InUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("remove with contributed content err = %#v", err)
	}
	if len(inUse.Resources) != 2 || inUse.Resources[0].Kind != "widget" || inUse.Resources[1].Kind != "data_source" {
		t.Fatalf("resources = %+v", inUse.Resources)
	}
	if inUse.Resources[0].Count != 1 || inUse.Resources[0].Label != "Widget" || inUse.Resources[0].Resolution != "delete" {
		t.Fatalf("Widget resource = %+v", inUse.Resources[0])
	}
	if got := inUse.Error(); got != "Athletics cannot be removed while 1 Widget remain." {
		t.Fatalf("message = %q", got)
	}
	// The blocked removal deletes nothing.
	if _, err := f.service.Get(ctx, "acme.athletics"); err != nil {
		t.Fatalf("blocked removal deleted the installation: %v", err)
	}

	if _, err := f.pool.Exec(ctx, `DELETE FROM widgets WHERE asset_id=$1`, widgetID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM assets WHERE id=$1`, widgetID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM data_sources WHERE id=$1`, dataSourceID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Remove(ctx, "acme.athletics", f.userID); err != nil {
		t.Fatalf("remove after cleanup: %v", err)
	}
}

func TestUpdateBlockedByDroppedContributionInUse(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()

	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}
	var organizationID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM organization_settings LIMIT 1`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	dataSourceID := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)
		VALUES($1,$2,'Schedule','acme.athletics.schedule','{}'::jsonb,$3)`, dataSourceID, organizationID, f.userID); err != nil {
		t.Fatal(err)
	}

	dropped := testActivation("2.5.0", testDigestV2)
	// The update drops the plugin and data-source contributions. The
	// manifest and the derived list agree on the surviving widget; the
	// blocker comes from the dropped schedule still being in use.
	dropped.Manifest.Contributions = dropped.Manifest.Contributions[1:2]
	dropped.Contributions = []Contribution{
		{Kind: "widget", ID: "acme.athletics.scoreboard", Path: "./widgets/scoreboard"},
	}
	err := func() error {
		_, err := f.service.Activate(ctx, dropped)
		return err
	}()
	var inUse *InUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("update dropping an in-use contribution err = %#v", err)
	}
	if inUse.Action != "updated" || len(inUse.Resources) != 1 || inUse.Resources[0].Kind != "data_source" {
		t.Fatalf("in-use = %+v", inUse)
	}
	if got := inUse.Error(); got != "Athletics cannot be updated while 1 Data Source remain." {
		t.Fatalf("message = %q", got)
	}
	// The blocked update keeps the previous version active.
	installed, err := f.service.Get(ctx, "acme.athletics")
	if err != nil {
		t.Fatal(err)
	}
	if installed.Version != "2.4.1" {
		t.Fatalf("version = %s after blocked update", installed.Version)
	}
}

// A Data Source keeps its stored configuration across an update. Changing its
// definition while saved sources use it would read them against a contract
// they were not created under, so the update is refused. An unchanged
// definition updates normally.
func TestUpdateBlockedByRedefinedDataSourceInUse(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()

	withSourceDigest := func(activation Activation, digest string) Activation {
		for index := range activation.Contributions {
			if activation.Contributions[index].Kind == "dataSource" {
				activation.Contributions[index].Digest = digest
			}
		}
		return activation
	}
	if _, err := f.service.Activate(ctx, withSourceDigest(testActivation("2.4.1", testDigestV1), "definition-1")); err != nil {
		t.Fatal(err)
	}
	var organizationID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM organization_settings LIMIT 1`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)
		VALUES($1,$2,'Schedule',$3,'{"city":"Northport"}'::jsonb,$4)`, uuid.New(), organizationID, "acme.athletics.schedule", f.userID); err != nil {
		t.Fatal(err)
	}

	redefined := withSourceDigest(testActivation("2.5.0", testDigestV2), "definition-2")
	_, err := f.service.Activate(ctx, redefined)
	var inUse *InUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("update redefining an in-use Data Source err = %#v", err)
	}
	if inUse.Action != "updated" || len(inUse.Resources) != 1 || inUse.Resources[0].Kind != "data_source" {
		t.Fatalf("in-use = %+v", inUse)
	}
	installed, err := f.service.Get(ctx, "acme.athletics")
	if err != nil {
		t.Fatal(err)
	}
	if installed.Version != "2.4.1" {
		t.Fatalf("version = %s after blocked redefinition", installed.Version)
	}

	// The same definition is not a redefinition, so the update proceeds.
	if _, err := f.service.Activate(ctx, withSourceDigest(testActivation("2.5.0", testDigestV2), "definition-1")); err != nil {
		t.Fatalf("update with an unchanged definition: %v", err)
	}
}
