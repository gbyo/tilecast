package contributions

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/testdb"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, database.Migrate)) }

type contributionsFixture struct {
	pool      *pgxpool.Pool
	installer *installer.Service
	provider  *contentdefs.Provider
	service   *Service
	content   map[string]string
}

func newContributionsFixture(t *testing.T) *contributionsFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Contributions Test',$1)`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	release := contentdefs.MustLoad()
	provider := contentdefs.NewProvider(release)
	f := &contributionsFixture{
		pool:      pool,
		installer: installer.NewService(pool, versionForTest()),
		provider:  provider,
		content:   map[string]string{},
	}
	f.service = NewService(pool, f.installer, release, provider,
		func(_ context.Context, _, digest string) (string, error) {
			dir, ok := f.content[digest]
			if !ok {
				return "", errContentMissing
			}
			return dir, nil
		},
		func(string) bool { return true },
		func(*contentdefs.Catalog) error { return nil },
	)
	return f
}

var errContentMissing = errors.New("retained content is missing")

func versionForTest() string { return "0.0.0-test" }

// seedPackage installs one package row with the given manifest and writes
// its nested manifests into a content directory the fixture serves.
func (f *contributionsFixture) seedPackage(t *testing.T, packageID, digest string, manifest packagemanifest.Manifest, nested map[string]string) {
	t.Helper()
	ctx := context.Background()
	var organizationID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM organization_settings LIMIT 1`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(ctx, `INSERT INTO installed_packages(organization_id,package_id,package_version,digest,source_kind,source_reference,registry_reference,trust_state,manifest)
		VALUES($1,$2,$3,$4,'custom','https://github.com/acme/tilecast-test','ghcr.io/acme/tilecast-test','verified',$5)`,
		organizationID, packageID, manifest.PackageVersion, digest, encoded); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for path, document := range nested {
		full := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(document), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	f.content[digest] = dir
}

func testManifest(packageID string) packagemanifest.Manifest {
	manifest, err := packagemanifest.Parse([]byte(`{
  "apiVersion": 1,
  "packageId": "` + packageID + `",
  "packageVersion": "1.0.0",
  "name": "Test",
  "description": "Test package.",
  "publisher": {"id": "acme", "name": "Acme"},
  "repository": "https://github.com/acme/tilecast-test",
  "license": "MIT",
  "tilecast": {"version": ">=0.0.0"},
  "distribution": {"oci": "ghcr.io/acme/tilecast-test"},
  "contributions": [
    {"type": "widget", "path": "./widgets/scoreboard"},
    {"type": "dataSource", "path": "./data-sources/schedule"}
  ]
}`))
	if err != nil {
		panic(err)
	}
	return manifest
}

// releaseWidgetJSON renders a release component Widget as a package
// nested manifest with package-owned component identity.
func releaseWidgetJSON(t *testing.T, packageID, nestedID string) string {
	t.Helper()
	release := contentdefs.MustLoad()
	var template *contentdefs.WidgetDefinition
	for _, definition := range release.Widgets {
		if definition.Component != nil {
			definition := definition
			template = &definition
			break
		}
	}
	if template == nil {
		t.Fatal("release catalog has no component Widget")
	}
	encoded, err := json.Marshal(template)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["id"] = nestedID
	manifest["apiVersion"] = 1
	delete(manifest, "source")
	component, _ := manifest["component"].(map[string]any)
	component["type"] = packageID + "." + nestedID
	component["tagName"] = "pkg-" + nestedID
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// releaseDataSourceJSON renders a release manual_records Data Source as
// a package nested manifest.
func releaseDataSourceJSON(t *testing.T, nestedID string) string {
	t.Helper()
	release := contentdefs.MustLoad()
	definition, ok := release.DataSource("events")
	if !ok {
		t.Fatal("release catalog has no events Data Source")
	}
	encoded, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["id"] = nestedID
	manifest["apiVersion"] = 1
	delete(manifest, "source")
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

const (
	testDigestGood = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testDigestBad  = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func TestRebuildJoinsDefinitions(t *testing.T) {
	f := newContributionsFixture(t)
	before := f.provider.CatalogFingerprint()
	manifest := testManifest("acme.athletics")
	f.seedPackage(t, "acme.athletics", testDigestGood, manifest, map[string]string{
		"widgets/scoreboard/tilecast.widget.json":        releaseWidgetJSON(t, "acme.athletics", "scoreboard"),
		"data-sources/schedule/tilecast.datasource.json": releaseDataSourceJSON(t, "schedule"),
	})
	if err := f.service.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	widget, ok := f.provider.Widget("acme.athletics.scoreboard")
	if !ok {
		t.Fatal("provider lacks the external Widget")
	}
	if widget.Source.Kind != contentdefs.SourceKindPackage || widget.Source.PackageID != "acme.athletics" {
		t.Fatalf("Widget source = %+v", widget.Source)
	}
	source, ok := f.provider.DataSource("acme.athletics.schedule")
	if !ok {
		t.Fatal("provider lacks the external Data Source")
	}
	if source.AdapterID != "manual_records" {
		t.Fatalf("Data Source adapter = %q", source.AdapterID)
	}
	if f.provider.CatalogFingerprint() == before {
		t.Fatal("rebuild did not move the catalog fingerprint")
	}
	if providers := f.provider.Snapshot().PackageWidgetProviders("acme.athletics"); len(providers) != 1 {
		t.Fatalf("Widget providers = %v", providers)
	}
}

func TestRebuildSkipsInvalidPackage(t *testing.T) {
	f := newContributionsFixture(t)
	good := testManifest("acme.athletics")
	f.seedPackage(t, "acme.athletics", testDigestGood, good, map[string]string{
		"widgets/scoreboard/tilecast.widget.json":        releaseWidgetJSON(t, "acme.athletics", "scoreboard"),
		"data-sources/schedule/tilecast.datasource.json": releaseDataSourceJSON(t, "schedule"),
	})
	bad := testManifest("acme.broken")
	f.seedPackage(t, "acme.broken", testDigestBad, bad, map[string]string{
		"widgets/scoreboard/tilecast.widget.json":        releaseWidgetJSON(t, "acme.broken", "scoreboard"),
		"data-sources/schedule/tilecast.datasource.json": `{"apiVersion": 1, "id": "schedule", "adapterId": "weather"}`,
	})
	err := f.service.Rebuild(context.Background())
	if err == nil {
		t.Fatal("expected the invalid package to be reported")
	}
	if !SkipsOnly(err) {
		t.Fatalf("expected only skips, got %v", err)
	}
	var skip SkippedPackage
	if !errors.As(err, &skip) || skip.PackageID != "acme.broken" {
		t.Fatalf("expected a skip for acme.broken, got %v", err)
	}
	if _, ok := f.provider.DataSource("acme.broken.schedule"); ok {
		t.Fatal("provider serves the invalid package's Data Source")
	}
	if _, ok := f.provider.Widget("acme.athletics.scoreboard"); !ok {
		t.Fatal("provider skipped the valid package with the invalid one")
	}
}

func TestSkipsOnly(t *testing.T) {
	if !SkipsOnly(nil) {
		t.Fatal("nil is not skips-only")
	}
	skip := SkippedPackage{PackageID: "acme.x", Err: errors.New("boom")}
	if !SkipsOnly(skip) {
		t.Fatal("a single skip is not skips-only")
	}
	joined := errors.Join(skip, SkippedPackage{PackageID: "acme.y", Err: errors.New("bam")})
	if !SkipsOnly(joined) {
		t.Fatal("joined skips are not skips-only")
	}
	if SkipsOnly(errors.Join(skip, errors.New("hard"))) {
		t.Fatal("a hard error reports skips-only")
	}
	if SkipsOnly(errors.New("hard")) {
		t.Fatal("a hard error reports skips-only")
	}
	if SkipsOnly(sql.ErrNoRows) {
		t.Fatal("a storage error reports skips-only")
	}
}
