package updates

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// updatesTestPool opens the package test database with empty release tables.
// The fixture lock serializes the tests that share those tables.
func updatesTestPool(t *testing.T) *pgxpool.Pool {
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
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`)
		lock.Release()
		lockPool.Close()
	})
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE update_provider_state,player_releases CASCADE`); err != nil {
		t.Fatal(err)
	}
	return pool
}

func newUpdatesService(t *testing.T, pool *pgxpool.Pool, f *releaseFixture, provider Provider) *Service {
	t.Helper()
	service, err := NewService(pool, provider, Config{Root: t.TempDir(), TrustedPublicKey: f.publicKey(), MaxAPKBytes: 10 << 20})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

type storedRelease struct {
	ID                    uuid.UUID
	Family, Arch, Channel string
	Name, Tag             string
	Code                  int64
}

func storedReleases(t *testing.T, pool *pgxpool.Pool) []storedRelease {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT id,player_family,architecture,channel,version_name,COALESCE(github_tag,''),version_code FROM player_releases ORDER BY version_code,player_family,architecture`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var stored []storedRelease
	for rows.Next() {
		var release storedRelease
		if err := rows.Scan(&release.ID, &release.Family, &release.Arch, &release.Channel, &release.Name, &release.Tag, &release.Code); err != nil {
			t.Fatal(err)
		}
		stored = append(stored, release)
	}
	return stored
}

func TestUnifiedReleaseImportsEveryFamilyFromOneGitHubRelease(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0-beta.1")
	provider := f.provider(f.release(2001, "v0.26.0-beta.1", true))
	service := newUpdatesService(t, pool, f, provider)

	if err := service.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored := storedReleases(t, pool)
	if len(stored) != 5 {
		t.Fatalf("stored %d player releases, want Android, Edge x2, and Windows x2: %+v", len(stored), stored)
	}
	for _, release := range stored {
		if release.Tag != "v0.26.0-beta.1" || release.Name != "0.26.0-beta.1" || release.Channel != "beta" || release.Code != 2600001 {
			t.Errorf("unexpected record: %+v", release)
		}
	}
	var safeError *string
	if err := pool.QueryRow(context.Background(), `SELECT safe_error FROM update_provider_state WHERE provider='github'`).Scan(&safeError); err != nil || safeError != nil {
		t.Fatalf("safe_error=%v err=%v", safeError, err)
	}
	// Android keeps the id a standalone Android release always had.
	var androidID uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT id FROM player_releases WHERE player_family='android'`).Scan(&androidID); err != nil || androidID != recordID(2001, FamilyAndroid, "") {
		t.Fatalf("android id=%s err=%v", androidID, err)
	}
}

func TestRepeatedChecksDoNotReimportOrRedownloadCompleteReleases(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	provider := f.provider(f.release(2002, "v0.26.0", false))
	service := newUpdatesService(t, pool, f, provider)
	ctx := context.Background()
	if err := service.Check(ctx); err != nil {
		t.Fatal(err)
	}
	first := storedReleases(t, pool)
	downloaded := provider.downloads
	if downloaded != 10 {
		t.Fatalf("first check downloaded %d manifests and signatures, want 10", downloaded)
	}
	// Force a fresh response the way a changed ETag does.
	if _, err := pool.Exec(ctx, `UPDATE update_provider_state SET etag=NULL`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := service.Check(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if provider.downloads != downloaded {
		t.Fatalf("a complete release was downloaded again: %d -> %d", downloaded, provider.downloads)
	}
	second := storedReleases(t, pool)
	if len(second) != len(first) {
		t.Fatalf("repeat check changed the record count: %d -> %d", len(first), len(second))
	}
	for index := range first {
		if first[index].ID != second[index].ID {
			t.Errorf("record %d changed id", index)
		}
	}
}

// An invalid signed artifact is reported and never imported, and it does not
// stop the valid ones from the same GitHub release.
func TestInvalidFamilyIsReportedAndTheOthersStillImport(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	release := f.release(2003, "v0.26.0", false)
	f.corruptSignature(release, windowsGitHubManifestHead+"x86_64.json")
	service := newUpdatesService(t, pool, f, f.provider(release))
	ctx := context.Background()

	if err := service.Check(ctx); err != nil {
		t.Fatalf("a partly valid release must not fail the check: %v", err)
	}
	stored := storedReleases(t, pool)
	if len(stored) != 4 {
		t.Fatalf("stored %d, want the four valid families: %+v", len(stored), stored)
	}
	for _, release := range stored {
		if release.Family == FamilyWindows && release.Arch == "x86_64" {
			t.Fatal("the Windows release with a bad signature was imported")
		}
	}
	var safeError *string
	if err := pool.QueryRow(ctx, `SELECT safe_error FROM update_provider_state WHERE provider='github'`).Scan(&safeError); err != nil {
		t.Fatal(err)
	}
	if safeError == nil || !strings.Contains(*safeError, "windows x86_64") || !strings.Contains(*safeError, "v0.26.0") {
		t.Fatalf("the rejection was not recorded: %v", safeError)
	}
	// The release stays unresolved, so the next check reads it again; a
	// check never treats a rejection as imported.
	if err := service.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if len(storedReleases(t, pool)) != 4 {
		t.Fatal("a rejected family appeared on the next check")
	}
}

// A release with only some platforms still imports them: an optional family
// that is absent must not block the present ones.
func TestAbsentOptionalFamilyDoesNotBlockTheOthers(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	code, _ := VersionCode("0.26.0-beta.1")
	f.android("0.26.0-beta.1", code, "beta")
	f.edge("0.26.0-beta.1", "beta", "x86_64")
	f.edge("0.26.0-beta.1", "beta", "aarch64")
	service := newUpdatesService(t, pool, f, f.provider(f.release(2004, "v0.26.0-beta.1", true)))
	if err := service.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stored := storedReleases(t, pool); len(stored) != 3 {
		t.Fatalf("stored %d, want Android and both Edge architectures", len(stored))
	}
	var safeError *string
	_ = pool.QueryRow(context.Background(), `SELECT safe_error FROM update_provider_state WHERE provider='github'`).Scan(&safeError)
	if safeError != nil {
		t.Fatalf("an absent family is not an error: %s", *safeError)
	}
}

// Beta 1, Beta 2, Stable, then the next Beta must all import and keep their
// order: the case the old numbering could not hold, where a Beta and its
// Stable shared one version code and the unique index refused the second.
func TestBetaToBetaToStableReleasesAllImportInOrder(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	var releases []ProviderRelease
	// Newest first, as GitHub lists them, with a Server release between.
	for index, version := range []string{"0.26.1-beta.1", "0.26.0", "0.26.0-beta.2", "0.26.0-beta.1"} {
		f.unified(version)
		releases = append(releases, f.release(int64(3000-index), "v"+version, VersionChannel(version) == "beta"))
	}
	releases = append(releases[:1], append([]ProviderRelease{{ID: 3999, Tag: "server-v0.1.0", Assets: []Asset{{Name: "SHA256SUMS", URL: "x"}}}}, releases[1:]...)...)
	service := newUpdatesService(t, pool, f, f.provider(releases...))
	if err := service.Check(context.Background()); err != nil {
		t.Fatalf("check: %v", err)
	}
	var previous int64
	var names []string
	for _, release := range storedReleases(t, pool) {
		if release.Family != FamilyEdge || release.Arch != "x86_64" {
			continue
		}
		if release.Code <= previous {
			t.Fatalf("%s has code %d, not above %d", release.Name, release.Code, previous)
		}
		previous = release.Code
		names = append(names, release.Name)
	}
	if got := strings.Join(names, ","); got != "0.26.0-beta.1,0.26.0-beta.2,0.26.0,0.26.1-beta.1" {
		t.Fatalf("order = %s", got)
	}
	if got := len(storedReleases(t, pool)); got != 20 {
		t.Fatalf("stored %d, want 5 families for each of 4 releases", got)
	}
}

// Releases shipped before the unified release stay importable beside it: the
// standalone Android and Edge layouts, with their own legacy version codes.
func TestHistoricalStandaloneReleasesImportBesideAUnifiedRelease(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0-beta.1")
	unified := f.release(4001, "v0.26.0-beta.1", true)
	f.edge("0.2.1-preview.1", "beta", "x86_64")
	f.edge("0.2.1-preview.1", "beta", "aarch64")
	edge := f.release(4002, "edge-v0.2.1-preview.1", true)
	f.linux("0.17.0", 17000)
	linux := f.release(4003, "player-linux-v0.17.0", false)
	f.android("0.25.0", 46, "stable")
	android := f.release(4004, "player-v0.25.0", false)
	service := newUpdatesService(t, pool, f, f.provider(unified, edge, linux, android))
	if err := service.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	byTag := map[string]int{}
	for _, release := range storedReleases(t, pool) {
		byTag[release.Tag]++
	}
	want := map[string]int{"v0.26.0-beta.1": 5, "edge-v0.2.1-preview.1": 2, "player-linux-v0.17.0": 1, "player-v0.25.0": 1}
	for tag, count := range want {
		if byTag[tag] != count {
			t.Errorf("%s: %d records, want %d", tag, byTag[tag], count)
		}
	}
	// The legacy Android id is the one a release imported before this
	// change already has, so a database that holds it is not duplicated.
	var legacyID uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT id FROM player_releases WHERE github_tag='player-v0.25.0'`).Scan(&legacyID); err != nil || legacyID != uuid.NewSHA1(uuid.NameSpaceURL, []byte("github:4004")) {
		t.Fatalf("legacy android id = %s err=%v", legacyID, err)
	}
}

// A release whose family and architecture already exist in the database under
// the same version code is a duplicate, reported rather than overwritten.
func TestDuplicateVersionCodeIsReportedAndKeepsTheFirstRelease(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	first := f.release(5001, "v0.26.0", false)
	f.unified("0.26.0")
	duplicate := f.release(5002, "v0.26.0-republished", false)
	service := newUpdatesService(t, pool, f, f.provider(first, duplicate))
	if err := service.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored := storedReleases(t, pool)
	if len(stored) != 5 {
		t.Fatalf("stored %d, want only the first release's five families", len(stored))
	}
	for _, release := range stored {
		if release.Tag != "v0.26.0" {
			t.Errorf("duplicate replaced the first release: %+v", release)
		}
	}
	var safeError *string
	_ = pool.QueryRow(context.Background(), `SELECT safe_error FROM update_provider_state WHERE provider='github'`).Scan(&safeError)
	if safeError == nil {
		t.Fatal("the duplicate was not reported")
	}
}

// A long release history with Server and WPE releases ahead of the player
// releases must not break discovery, and must not bloat the stored response.
func TestNonPlayerReleasesAreNeitherAnErrorNorStored(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	var releases []ProviderRelease
	for index := range 120 {
		releases = append(releases, ProviderRelease{ID: int64(9000 + index), Tag: "wpe-2.54.0-prebuild", Assets: []Asset{{Name: "wpe.tar", URL: "wpe"}}})
	}
	releases = append(releases, f.release(5100, "v0.26.0", false))
	service := newUpdatesService(t, pool, f, f.provider(releases...))
	if err := service.Check(context.Background()); err != nil {
		t.Fatalf("a history of non-player releases failed the check: %v", err)
	}
	if got := len(storedReleases(t, pool)); got != 5 {
		t.Fatalf("stored %d, want 5", got)
	}
	var documented int
	if err := pool.QueryRow(context.Background(), `SELECT jsonb_array_length(response) FROM update_provider_state WHERE provider='github'`).Scan(&documented); err != nil || documented != 1 {
		t.Fatalf("stored response holds %d releases, want only the player release: %v", documented, err)
	}
}

func TestCheckFailsWhenNothingCanBeImported(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	release := f.release(5200, "v0.26.0", false)
	// Every manifest is signed by a different key than the server trusts.
	other := newReleaseFixture(t)
	service, err := NewService(pool, f.provider(release), Config{Root: t.TempDir(), TrustedPublicKey: other.publicKey(), MaxAPKBytes: 10 << 20})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Check(context.Background()); err == nil {
		t.Fatal("a release signed by an untrusted key was accepted")
	}
	if got := len(storedReleases(t, pool)); got != 0 {
		t.Fatalf("stored %d releases from an untrusted signer", got)
	}
}

// A direct upload follows the same ordering as a GitHub release: a Beta, the
// next Beta and Stable import in order, and an older or equal version is
// refused.
func TestDirectUploadFollowsTheUnifiedOrdering(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	service := newUpdatesService(t, pool, f, f.provider())
	ctx := context.Background()

	upload := func(version string) (ImportedRelease, error) {
		t.Helper()
		f.reset()
		f.windows(version, VersionChannel(version), "x86_64")
		var raw, signature []byte
		var artifact []byte
		var artifactName string
		for _, asset := range f.assets {
			switch {
			case asset.Name == windowsGitHubManifestHead+"x86_64.json":
				raw = f.downloads[asset.URL]
			case asset.Name == windowsGitHubManifestHead+"x86_64.json.sig":
				signature = f.downloads[asset.URL]
			default:
				artifact, artifactName = f.artifacts[asset.URL], asset.Name
			}
		}
		path := filepath.Join(t.TempDir(), artifactName)
		if err := os.WriteFile(path, artifact, 0o600); err != nil {
			t.Fatal(err)
		}
		return service.ImportUpload(ctx, path, artifactName, raw, signature, nil)
	}

	for _, version := range []string{"0.26.0-beta.1", "0.26.0-beta.2", "0.26.0", "0.26.1-beta.1"} {
		if result, err := upload(version); err != nil || result.Duplicate {
			t.Fatalf("%s: %+v %v", version, result, err)
		}
	}
	// A Beta cannot follow the Stable of its own version, and the same
	// version is a duplicate rather than a new release.
	if _, err := upload("0.26.0-beta.3"); err == nil || !strings.Contains(err.Error(), "newer than every imported release") {
		t.Fatalf("a Beta older than the newest import was accepted: %v", err)
	}
	if result, err := upload("0.26.1-beta.1"); err != nil || !result.Duplicate {
		t.Fatalf("the same version again must be a duplicate: %+v %v", result, err)
	}
	if got := len(storedReleases(t, pool)); got != 4 {
		t.Fatalf("stored %d releases, want 4", got)
	}
}

// A rejected asset is a status, not a failed check: the stored ETag stays, so an
// unchanged release list is neither downloaded nor verified again, and the
// recorded rejection survives a check that finds nothing changed.
func TestRejectionKeepsTheETagAndIsNotRetriedUntilTheListChanges(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	release := f.release(6001, "v0.26.0", false)
	f.corruptSignature(release, windowsGitHubManifestHead+"x86_64.json")
	provider := f.provider(release)
	service := newUpdatesService(t, pool, f, provider)
	ctx := context.Background()
	if err := service.Check(ctx); err != nil {
		t.Fatal(err)
	}
	var etag string
	var recorded *string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(etag,''),safe_error FROM update_provider_state WHERE provider='github'`).Scan(&etag, &recorded); err != nil {
		t.Fatal(err)
	}
	if etag != `"fixture"` || recorded == nil || !strings.HasPrefix(*recorded, rejectedPrefix) {
		t.Fatalf("etag=%q safe_error=%v", etag, recorded)
	}
	downloaded := provider.downloads
	for range 2 {
		if err := service.Check(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if provider.downloads != downloaded {
		t.Fatalf("an unchanged release list was downloaded again: %d -> %d", downloaded, provider.downloads)
	}
	if err := pool.QueryRow(ctx, `SELECT safe_error FROM update_provider_state WHERE provider='github'`).Scan(&recorded); err != nil || recorded == nil || !strings.HasPrefix(*recorded, rejectedPrefix) {
		t.Fatalf("the rejection was cleared by an unchanged check: %v %v", recorded, err)
	}
}

// A hotfix release that rebuilds one platform lists only that platform. The
// platforms it carries forward stay available from the release that built
// them, keep the version they shipped with, and are not offered as new.
func TestAHotfixKeepsTheCarriedForwardPlatformsAtTheirOwnVersion(t *testing.T) {
	pool := updatesTestPool(t)
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	original := f.release(6001, "v0.26.0", false)
	for _, arch := range []string{"x86_64", "aarch64"} {
		f.windows("0.26.1", "stable", arch)
	}
	hotfix := f.release(6002, "v0.26.1", false)
	service := newUpdatesService(t, pool, f, f.provider(hotfix, original))
	ctx := context.Background()
	if err := service.Check(ctx); err != nil {
		t.Fatal(err)
	}
	latest := func() map[string]storedRelease {
		newest := map[string]storedRelease{}
		for _, release := range storedReleases(t, pool) {
			key := release.Family + "/" + release.Arch
			if current, ok := newest[key]; !ok || release.Code > current.Code {
				newest[key] = release
			}
		}
		return newest
	}
	want := map[string][2]string{
		"android/":        {"0.26.0", "v0.26.0"},
		"edge/x86_64":     {"0.26.0", "v0.26.0"},
		"edge/aarch64":    {"0.26.0", "v0.26.0"},
		"windows/x86_64":  {"0.26.1", "v0.26.1"},
		"windows/aarch64": {"0.26.1", "v0.26.1"},
	}
	check := func(when string) {
		t.Helper()
		got := latest()
		if len(got) != len(want) {
			t.Fatalf("%s: newest releases = %+v", when, got)
		}
		for key, expected := range want {
			if got[key].Name != expected[0] || got[key].Tag != expected[1] {
				t.Errorf("%s: newest %s is %s from %s, want %s from %s", when, key, got[key].Name, got[key].Tag, expected[0], expected[1])
			}
		}
	}
	check("after the hotfix is imported")
	if got := len(storedReleases(t, pool)); got != 7 {
		t.Fatalf("stored %d, want the five of v0.26.0 and the two Windows builds of v0.26.1", got)
	}

	// Months later nothing has changed on GitHub, so no check re-imports
	// anything. Cleanup must still leave every platform's newest build in
	// place, and may remove only what a newer build supersedes.
	if _, err := pool.Exec(ctx, `UPDATE player_releases SET updated_at=now()-interval '200 days'`); err != nil {
		t.Fatal(err)
	}
	service.Cleanup(ctx, 90)
	check("after cleanup")
	var older int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player_releases WHERE player_family='windows' AND version_name='0.26.0'`).Scan(&older); err != nil || older != 0 {
		t.Fatalf("the superseded Windows 0.26.0 builds were kept: count=%d err=%v", older, err)
	}
	if got := len(storedReleases(t, pool)); got != 5 {
		t.Fatalf("stored %d after cleanup, want one newest build per platform", got)
	}
}
