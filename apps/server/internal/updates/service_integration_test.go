package updates

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestGitHubReleaseCheckStoresJSONDocuments(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE update_provider_state,player_releases CASCADE`); err != nil {
		t.Fatal(err)
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		SchemaVersion:            1,
		Product:                  "tilecast-player",
		ApplicationID:            ApplicationID,
		VersionCode:              CurrentVersionCode + 1,
		VersionName:              "0.11.0",
		Channel:                  "stable",
		MinimumSDK:               SupportedMinSDK,
		APKAssetName:             "tilecast-player.apk",
		APKSizeBytes:             1024,
		APKSHA256:                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		SigningCertificateSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		ReleaseNotes:             "Integration release",
	}
	rawManifest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, rawManifest)))
	provider := &integrationProvider{
		result: ProviderResult{
			ETag: `"release-etag"`,
			Releases: []ProviderRelease{{
				ID:          110,
				Tag:         "player-v0.11.0",
				PublishedAt: time.Now().UTC(),
				Assets: []Asset{
					{Name: "tilecast-player-update.json", URL: "manifest", Size: int64(len(rawManifest))},
					{Name: "tilecast-player-update.json.sig", URL: "signature", Size: int64(len(signature))},
					{Name: "tilecast-player.apk", URL: "apk", Size: manifest.APKSizeBytes},
				},
			}},
		},
		downloads: map[string][]byte{"manifest": rawManifest, "signature": signature},
	}
	service, err := NewService(pool, provider, Config{
		Root:             t.TempDir(),
		TrustedPublicKey: base64.StdEncoding.EncodeToString(publicKey),
		MaxAPKBytes:      10 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Check(ctx); err != nil {
		t.Fatalf("first release check: %v", err)
	}
	if err = service.Check(ctx); err != nil {
		t.Fatalf("second release check: %v", err)
	}

	var responseType, manifestType, storedVersion string
	if err = pool.QueryRow(ctx, `SELECT jsonb_typeof(response) FROM update_provider_state WHERE provider='github'`).Scan(&responseType); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT jsonb_typeof(manifest),manifest->>'versionName' FROM player_releases WHERE github_release_id=110`).Scan(&manifestType, &storedVersion); err != nil {
		t.Fatal(err)
	}
	if responseType != "array" || manifestType != "object" || storedVersion != manifest.VersionName {
		t.Fatalf("response=%q manifest=%q version=%q", responseType, manifestType, storedVersion)
	}
}

func TestLinuxGitHubReleaseSyncAndCache(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE update_provider_state,player_releases CASCADE`); err != nil {
		t.Fatal(err)
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	artifact := []byte("production-shaped AppImage bytes")
	digest := sha256.Sum256(artifact)
	manifest := Manifest{
		SchemaVersion:     1,
		Product:           "tilecast-player",
		Platform:          PlatformLinux,
		VersionCode:       2004,
		VersionName:       "0.2.4",
		Channel:           "stable",
		ArtifactAssetName: LinuxArtifactName,
		ArtifactSizeBytes: int64(len(artifact)),
		ArtifactSHA256:    hex.EncodeToString(digest[:]),
		ReleaseNotes:      "Linux Studio update integration release",
	}
	rawManifest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, rawManifest)))
	provider := &integrationProvider{
		result: ProviderResult{
			ETag: `"linux-release-etag"`,
			Releases: []ProviderRelease{{
				ID:          204,
				Tag:         "player-linux-v0.2.4",
				PublishedAt: time.Now().UTC(),
				Assets: []Asset{
					{Name: "tilecast-player-update-linux.json", URL: "linux-manifest", Size: int64(len(rawManifest))},
					{Name: "tilecast-player-update-linux.json.sig", URL: "linux-signature", Size: int64(len(signature))},
					{Name: LinuxArtifactName, URL: "linux-appimage", Size: int64(len(artifact))},
				},
			}},
		},
		downloads: map[string][]byte{
			"linux-manifest":  rawManifest,
			"linux-signature": signature,
		},
		artifacts: map[string][]byte{"linux-appimage": artifact},
	}
	service, err := NewService(pool, provider, Config{
		Root:             t.TempDir(),
		TrustedPublicKey: base64.StdEncoding.EncodeToString(publicKey),
		MaxAPKBytes:      10 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Check(ctx); err != nil {
		t.Fatalf("sync Linux release: %v", err)
	}

	var releaseID uuid.UUID
	var platform, versionName, cacheStatus, verificationStatus, artifactURL string
	var versionCode int64
	if err = pool.QueryRow(ctx, `SELECT id,platform,version_code,version_name,cache_status,verification_status,apk_download_url FROM player_releases WHERE github_release_id=204`).Scan(&releaseID, &platform, &versionCode, &versionName, &cacheStatus, &verificationStatus, &artifactURL); err != nil {
		t.Fatal(err)
	}
	if platform != PlatformLinux || versionCode != 2004 || versionName != "0.2.4" || cacheStatus != "missing" || verificationStatus != "verified_manifest" || artifactURL != "linux-appimage" {
		t.Fatalf("unexpected synchronized release: platform=%q code=%d name=%q cache=%q verification=%q url=%q", platform, versionCode, versionName, cacheStatus, verificationStatus, artifactURL)
	}

	if err = service.Cache(ctx, releaseID); err != nil {
		t.Fatalf("cache Linux release: %v", err)
	}
	var downloadedBytes int64
	if err = pool.QueryRow(ctx, `SELECT cache_downloaded_bytes FROM player_releases WHERE id=$1`, releaseID).Scan(&downloadedBytes); err != nil {
		t.Fatal(err)
	}
	if downloadedBytes != int64(len(artifact)) {
		t.Fatalf("download progress = %d, want %d", downloadedBytes, len(artifact))
	}
	path, size, hash, cachedFamily, err := service.ArtifactPath(ctx, releaseID)
	if err != nil {
		t.Fatal(err)
	}
	cached, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(cached, artifact) || size != int64(len(artifact)) || hash != manifest.ArtifactSHA256 || cachedFamily != FamilyElectronLinux {
		t.Fatalf("cached artifact mismatch: bytes=%q size=%d hash=%q family=%q", cached, size, hash, cachedFamily)
	}
}

type integrationProvider struct {
	result    ProviderResult
	downloads map[string][]byte
	artifacts map[string][]byte
}

func (p *integrationProvider) Releases(context.Context, string) (ProviderResult, error) {
	return p.result, nil
}

func (p *integrationProvider) Download(_ context.Context, rawURL string, _ int64) ([]byte, error) {
	value, ok := p.downloads[rawURL]
	if !ok {
		return nil, errors.New("asset not found")
	}
	return value, nil
}

func (p *integrationProvider) Open(_ context.Context, rawURL string) (*http.Response, error) {
	value, ok := p.artifacts[rawURL]
	if !ok {
		return nil, errors.New("asset not found")
	}
	return &http.Response{
		StatusCode:    http.StatusOK,
		ContentLength: int64(len(value)),
		Body:          io.NopCloser(bytes.NewReader(value)),
	}, nil
}

// A Tilecast Edge GitHub release carries one signed envelope and archive per
// architecture. Each becomes its own release of the edge family, with the
// exact envelope bytes kept for the screens to verify; an envelope whose
// archive is missing is not imported.
func TestEdgeGitHubReleaseImportsEachArchitecture(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE update_provider_state,player_releases CASCADE`); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	assets := []Asset{}
	downloads := map[string][]byte{}
	artifacts := map[string][]byte{}
	envelopes := map[string][]byte{}
	for _, arch := range []string{"x86_64", "aarch64"} {
		archive := []byte("edge release archive for " + arch)
		digest := sha256.Sum256(archive)
		envelope := Manifest{SchemaVersion: 1, Product: EdgeProduct, PlayerFamily: FamilyEdge, Platform: PlatformLinux, Arch: arch, VersionName: "0.2.0", VersionCode: 2000, Channel: "stable", ArtifactAssetName: EdgeArtifactName("0.2.0", arch), ArtifactSizeBytes: int64(len(archive)), ArtifactSHA256: hex.EncodeToString(digest[:]), ReleaseManifestSHA256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", SBOMSHA256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", StateSchemaVersion: 6}
		raw, _ := json.Marshal(envelope)
		// Indented bytes: the stored copy must be these bytes, not jsonb's.
		var indented bytes.Buffer
		_ = json.Indent(&indented, raw, "", "  ")
		raw = indented.Bytes()
		envelopes[arch] = raw
		signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, raw)))
		manifestName := "tilecast-edge-update-" + arch + ".json"
		assets = append(assets,
			Asset{Name: manifestName, URL: manifestName, Size: int64(len(raw))},
			Asset{Name: manifestName + ".sig", URL: manifestName + ".sig", Size: int64(len(signature))},
		)
		downloads[manifestName] = raw
		downloads[manifestName+".sig"] = signature
		if arch == "x86_64" {
			assets = append(assets, Asset{Name: envelope.ArtifactAssetName, URL: "archive-" + arch, Size: int64(len(archive))})
			artifacts["archive-"+arch] = archive
		}
	}
	provider := &integrationProvider{
		result:    ProviderResult{ETag: `"edge"`, Releases: []ProviderRelease{{ID: 300, Tag: "edge-v0.2.0", PublishedAt: time.Now().UTC(), Assets: assets}}},
		downloads: downloads,
		artifacts: artifacts,
	}
	service, err := NewService(pool, provider, Config{Root: t.TempDir(), TrustedPublicKey: base64.StdEncoding.EncodeToString(publicKey), MaxAPKBytes: 10 << 20})
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Check(ctx); err != nil {
		t.Fatalf("sync edge release: %v", err)
	}
	var id uuid.UUID
	var family, architecture, name string
	var stored []byte
	var schema int
	if err = pool.QueryRow(ctx, `SELECT id,player_family,architecture,apk_name,manifest_bytes,state_schema_version FROM player_releases WHERE github_release_id=300`).Scan(&id, &family, &architecture, &name, &stored, &schema); err != nil {
		t.Fatal(err)
	}
	if family != FamilyEdge || architecture != "x86_64" || name != "tilecast-edge-0.2.0-x86_64.tar.zst" || !bytes.Equal(stored, envelopes["x86_64"]) || schema != 6 {
		t.Fatalf("unexpected edge release: %s %s %s schema=%d exact=%v", family, architecture, name, schema, bytes.Equal(stored, envelopes["x86_64"]))
	}
	var count int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM player_releases WHERE github_release_id=300`).Scan(&count)
	if count != 1 {
		t.Fatalf("the aarch64 envelope without its archive must not import: %d rows", count)
	}
	if err = service.Cache(ctx, id); err != nil {
		t.Fatalf("cache edge release: %v", err)
	}
	path, _, _, cachedFamily, err := service.ArtifactPath(ctx, id)
	if err != nil || cachedFamily != FamilyEdge || len(path) < 8 || path[len(path)-8:] != ".tar.zst" {
		t.Fatalf("edge artifact path: %q %q %v", path, cachedFamily, err)
	}
}
