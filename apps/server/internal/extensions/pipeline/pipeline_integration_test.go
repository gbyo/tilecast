package pipeline

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/catalog"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/github"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/registry"
)

const (
	pipelineOwner = "acme"
	pipelineRepo  = "tilecast-athletics"
	pipelinePID   = "acme.athletics"
	pipelineRange = ">=1.2.0 <2.0.0"
	pipelineTile  = "1.5.0"
	pipelineSign  = "https://github.com/acme/tilecast-athletics/.github/workflows/release.yml@refs/tags/v2.4.1"
)

func pipelineManifest(t *testing.T, oci, version string) string {
	t.Helper()
	return `{
  "apiVersion": 1,
  "packageId": "` + pipelinePID + `",
  "packageVersion": "` + version + `",
  "name": "Athletics",
  "description": "Scoreboards and schedules.",
  "publisher": {"id": "acme", "name": "Acme Athletics"},
  "repository": "https://github.com/acme/tilecast-athletics",
  "license": "MIT",
  "tilecast": {"version": "` + pipelineRange + `"},
  "distribution": {"oci": "` + oci + `"},
  "contributions": [
    {"type": "widget", "path": "./widgets/scoreboard"},
    {"type": "dataSource", "path": "./data-sources/schedule"}
  ]
}`
}

func pipelineContent(t *testing.T) []byte {
	t.Helper()
	var raw bytes.Buffer
	gzipWriter := gzip.NewWriter(&raw)
	tarWriter := tar.NewWriter(gzipWriter)
	for name, body := range map[string]string{
		"widgets/scoreboard/tilecast.widget.json":        `{"apiVersion":1,"id":"scoreboard"}`,
		"data-sources/schedule/tilecast.datasource.json": `{"apiVersion":1,"id":"schedule"}`,
	} {
		if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return raw.Bytes()
}

// fakeGitHub serves the repository, release, manifest, and attestation
// endpoints the pipeline reads. Behaviors mutate per test.
type fakeGitHub struct {
	t            *testing.T
	manifest     string
	releaseTag   string
	private      bool
	noRelease    bool
	noManifest   bool
	status       int
	attestations int
}

func (f *fakeGitHub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		path := r.URL.Path
		base := "/repos/" + pipelineOwner + "/" + pipelineRepo
		switch {
		case path == base:
			private := "false"
			if f.private {
				private = "true"
			}
			fmt.Fprintf(w, `{"default_branch":"main","private":%s}`, private)
		case path == base+"/releases/latest":
			if f.noRelease {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			fmt.Fprintf(w, `{"tag_name":%q,"name":%q,"published_at":"2026-01-02T03:04:05Z"}`,
				f.releaseTag, f.releaseTag)
		case path == base+"/contents/tilecast.package.json":
			if f.noManifest {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			fmt.Fprintf(w, `{"type":"file","encoding":"base64","content":%q}`,
				base64.StdEncoding.EncodeToString([]byte(f.manifest)))
		case strings.HasPrefix(path, base+"/attestations/"):
			out := []string{}
			for i := 0; i < f.attestations; i++ {
				out = append(out, `{"bundle":{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}}`)
			}
			fmt.Fprintf(w, `{"attestations":[%s]}`, strings.Join(out, ","))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

// fakeRegistry serves one layout's blobs by digest or tag.
type fakeRegistry struct {
	t      *testing.T
	layout string
	tags   map[string]string
}

func (f *fakeRegistry) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/v2/" {
			w.WriteHeader(http.StatusOK)
			return
		}
		trimmed, found := strings.CutPrefix(path, "/v2/acme/tilecast-athletics/")
		if !found {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		reference := ""
		isManifest := false
		if rest, ok := strings.CutPrefix(trimmed, "manifests/"); ok {
			reference, isManifest = rest, true
		} else if rest, ok := strings.CutPrefix(trimmed, "blobs/"); ok {
			reference = rest
		} else {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		digest := reference
		if !strings.HasPrefix(reference, "sha256:") {
			mapped, ok := f.tags[reference]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			digest = mapped
		}
		data, err := os.ReadFile(filepath.Join(f.layout, "blobs", "sha256", strings.TrimPrefix(digest, "sha256:")))
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Docker-Content-Digest", digest)
		if isManifest {
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		w.Write(data)
	})
}

type stubVerifier struct {
	f *pipelineFixture
}

func (s stubVerifier) Verify(bundleJSON []byte, digest, owner, repo string) (string, error) {
	s.f.verifyCalls++
	if s.f.verifyErr != nil {
		return "", s.f.verifyErr
	}
	if owner == "" || repo == "" || digest == "" || len(bundleJSON) == 0 {
		return "", errors.New("stub verifier got empty input")
	}
	return pipelineSign, nil
}

type stubCatalog struct {
	f *pipelineFixture
}

func (s stubCatalog) ListingFor(ctx context.Context, packageID string) (catalog.Listing, catalog.Cached, error) {
	if s.f.listErr != nil {
		return catalog.Listing{}, catalog.Cached{}, s.f.listErr
	}
	if packageID != s.f.listing.PackageID {
		return catalog.Listing{}, catalog.Cached{}, catalog.ErrUnknownPackage
	}
	return s.f.listing, catalog.Cached{}, nil
}

func (s stubCatalog) Refresh(ctx context.Context) error {
	s.f.refreshCalls++
	return s.f.refreshErr
}

type pipelineFixture struct {
	pool         *pgxpool.Pool
	service      *Service
	installer    *installer.Service
	userID       uuid.UUID
	github       *fakeGitHub
	registry     *fakeRegistry
	oci          string
	digest       string
	verifyErr    error
	verifyCalls  int
	listing      catalog.Listing
	listErr      error
	refreshErr   error
	refreshCalls int
}

func newPipelineFixture(t *testing.T, options ...Option) *pipelineFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users,installed_packages,custom_package_sources CASCADE`); err != nil {
		t.Fatal(err)
	}
	f := &pipelineFixture{pool: pool, userID: uuid.New(), registry: &fakeRegistry{t: t, tags: map[string]string{}}}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Pipeline Test',$1)`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','pipeline-owner','unused','owner',TRUE)`, f.userID); err != nil {
		t.Fatal(err)
	}
	registryServer := httptest.NewServer(f.registry.handler())
	t.Cleanup(registryServer.Close)
	f.oci = strings.TrimPrefix(registryServer.URL, "http://") + "/acme/tilecast-athletics"
	f.github = &fakeGitHub{t: t, releaseTag: "v2.4.1", attestations: 1}
	githubServer := httptest.NewServer(f.github.handler())
	t.Cleanup(githubServer.Close)
	githubClient, err := github.NewClient(githubServer.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	f.rebuild(t, "2.4.1", "v2.4.1")
	f.installer = installer.NewService(pool, pipelineTile)
	options = append([]Option{
		WithGitHub(githubClient),
		WithRegistry(registry.NewRepository(registry.WithPlainHTTP())),
		WithAttestations(stubVerifier{f: f}),
		WithCatalog(stubCatalog{f: f}),
	}, options...)
	f.service = NewService(pool, f.installer, t.TempDir(), pipelineTile, options...)
	return f
}

// rebuild publishes version under tag on both fakes: the manifest names
// the fake registry, the layout carries it, and the tag maps to the
// layout digest.
func (f *pipelineFixture) rebuild(t *testing.T, version, tag string) {
	t.Helper()
	f.github.manifest = pipelineManifest(t, f.oci, version)
	f.github.releaseTag = tag
	layout := t.TempDir()
	digest, err := packages.WriteLayout(layout, []byte(f.github.manifest), pipelineContent(t))
	if err != nil {
		t.Fatal(err)
	}
	f.registry.layout = layout
	f.registry.tags = map[string]string{tag: digest}
	f.digest = digest
}

func (f *pipelineFixture) catalogListing() catalog.Listing {
	return catalog.Listing{
		PackageID: pipelinePID, Version: "2.4.1", Name: "Athletics",
		Publisher: catalog.Publisher{ID: "acme", Name: "Acme"},
		License:   "MIT", TilecastRange: pipelineRange,
		OCI: f.oci, Digest: f.digest,
		Repository: "https://github.com/acme/tilecast-athletics",
	}
}

func TestResolveCustom(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	resolution, err := f.service.ResolveCustom(ctx, "https://github.com/acme/tilecast-athletics")
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Manifest.PackageID != pipelinePID || resolution.Manifest.PackageVersion != "2.4.1" {
		t.Fatalf("manifest = %+v", resolution.Manifest)
	}
	if resolution.Digest != f.digest {
		t.Fatalf("digest = %s, want %s", resolution.Digest, f.digest)
	}
	if resolution.Signer != pipelineSign || resolution.Trust != installer.TrustVerified {
		t.Fatalf("trust = %s %s", resolution.Signer, resolution.Trust)
	}
	if !resolution.Compatible {
		t.Fatal("resolution should be compatible with Tilecast 1.5.0")
	}
	if resolution.ReleaseTag != "v2.4.1" || resolution.RepositoryURL != "https://github.com/acme/tilecast-athletics" {
		t.Fatalf("resolution = %+v", resolution)
	}
	// Resolution persists nothing.
	if _, err := f.installer.Get(ctx, pipelinePID); !errors.Is(err, installer.ErrNotFound) {
		t.Fatalf("Get = %v, want ErrNotFound", err)
	}
}

func TestResolveCustomErrors(t *testing.T) {
	ctx := context.Background()
	for name, mutate := range map[string]struct {
		url  string
		fake func(*pipelineFixture)
		want error
	}{
		"bad URL": {url: "https://gitlab.com/acme/x", want: ErrInvalidRepository},
		"private": {
			url:  "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) { f.github.private = true },
			want: ErrRepositoryPrivate,
		},
		"no release": {
			url:  "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) { f.github.noRelease = true },
			want: ErrNoRelease,
		},
		"no manifest": {
			url:  "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) { f.github.noManifest = true },
			want: ErrNoManifest,
		},
		"invalid manifest": {
			url: "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) {
				f.github.manifest = `{"apiVersion":1,"packageId":"tilecast.evil"}`
			},
			want: ErrManifestInvalid,
		},
		"unknown tag": {
			url: "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) {
				f.github.releaseTag = "v9.9.9"
			},
			want: ErrNoPublishedPackage,
		},
		"unusable tag": {
			url: "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) {
				f.github.releaseTag = "release/2.4.1"
			},
			want: ErrTagUnusable,
		},
		"unsigned": {
			url: "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) {
				f.github.attestations = 0
			},
			want: ErrPackageUnsigned,
		},
		"github down": {
			url: "https://github.com/acme/tilecast-athletics",
			fake: func(f *pipelineFixture) {
				f.github.status = http.StatusInternalServerError
			},
			want: ErrUpstream,
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newPipelineFixture(t)
			if mutate.fake != nil {
				mutate.fake(f)
			}
			if _, err := f.service.ResolveCustom(ctx, mutate.url); !errors.Is(err, mutate.want) {
				t.Fatalf("err = %v, want %v", err, mutate.want)
			}
		})
	}
}

func TestResolveCustomIncompatible(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	manifest := strings.Replace(pipelineManifest(t, f.oci, "2.4.1"), pipelineRange, ">=99.0.0", 1)
	f.github.manifest = manifest
	layout := t.TempDir()
	digest, err := packages.WriteLayout(layout, []byte(manifest), pipelineContent(t))
	if err != nil {
		t.Fatal(err)
	}
	f.registry.layout = layout
	f.registry.tags = map[string]string{"v2.4.1": digest}
	resolution, err := f.service.ResolveCustom(ctx, "https://github.com/acme/tilecast-athletics")
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Compatible {
		t.Fatal("resolution should be incompatible")
	}
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); !errors.Is(err, installer.ErrIncompatible) {
		t.Fatalf("install err = %v, want ErrIncompatible", err)
	}
}

func TestInstallCrossCheckRange(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	// The published manifest narrows the compatibility range the review
	// showed: the cross-check refuses the drift.
	other := t.TempDir()
	manifest := strings.Replace(pipelineManifest(t, f.oci, "2.4.1"), pipelineRange, ">=99.0.0", 1)
	digest, err := packages.WriteLayout(other, []byte(manifest), pipelineContent(t))
	if err != nil {
		t.Fatal(err)
	}
	f.registry.layout = other
	f.registry.tags = map[string]string{"v2.4.1": digest}
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); !errors.Is(err, ErrCrossCheck) {
		t.Fatalf("err = %v, want ErrCrossCheck", err)
	}
}

func TestInstallCustom(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	installed, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Version != "2.4.1" || installed.Digest != f.digest {
		t.Fatalf("installed = %+v", installed)
	}
	if installed.SourceKind != installer.SourceCustom || installed.Trust != installer.TrustVerified {
		t.Fatalf("installed = %+v", installed)
	}
	source, err := f.service.CustomSource(ctx, pipelinePID)
	if err != nil {
		t.Fatal(err)
	}
	if source.Owner != "acme" || source.Name != "tilecast-athletics" || source.ResolvedDigest != f.digest {
		t.Fatalf("source = %+v", source)
	}
	contributions, err := f.installer.Contributions(ctx, pipelinePID)
	if err != nil {
		t.Fatal(err)
	}
	if len(contributions) != 2 {
		t.Fatalf("contributions = %+v", contributions)
	}
	// Installing retained the bytes, so the local lookup serves them
	// without the registry; an unretained digest is an error, not a pull.
	if dir, err := f.service.LocalContentDir(ctx, "", f.digest); err != nil || dir == "" {
		t.Fatalf("LocalContentDir = %q, %v", dir, err)
	}
	if _, err := f.service.LocalContentDir(ctx, "", "sha256:"+strings.Repeat("1", 64)); err == nil {
		t.Fatal("LocalContentDir answered for an unretained digest")
	}
	entries, err := f.service.CustomEntries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !entries[0].Installed || entries[0].InstalledVersion != "2.4.1" {
		t.Fatalf("entries = %+v", entries)
	}
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); !errors.Is(err, ErrAlreadyInstalled) {
		t.Fatalf("reinstall err = %v, want ErrAlreadyInstalled", err)
	}
}

func TestInstallCustomUnsigned(t *testing.T) {
	ctx := context.Background()
	t.Run("refused by default", func(t *testing.T) {
		f := newPipelineFixture(t)
		f.github.attestations = 0
		if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); !errors.Is(err, ErrPackageUnsigned) {
			t.Fatalf("err = %v, want ErrPackageUnsigned", err)
		}
	})
	t.Run("allowed in development", func(t *testing.T) {
		f := newPipelineFixture(t, WithAllowUnsigned())
		f.github.attestations = 0
		f.installer = installer.NewService(f.pool, pipelineTile, installer.WithUnsignedDevelopmentAllowed())
		f.service.installer = f.installer
		installed, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID)
		if err != nil {
			t.Fatal(err)
		}
		if installed.Trust != installer.TrustUnsignedDevelopment || installed.SignerIdentity != "" {
			t.Fatalf("installed = %+v", installed)
		}
	})
	t.Run("installer still refuses without its own allowance", func(t *testing.T) {
		f := newPipelineFixture(t, WithAllowUnsigned())
		f.github.attestations = 0
		if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); !errors.Is(err, installer.ErrUnsignedRejected) {
			t.Fatalf("err = %v, want ErrUnsignedRejected", err)
		}
	})
}

func TestInstallCrossCheck(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	// The registry publishes a different version than the repository
	// manifest declares.
	other := t.TempDir()
	manifest := strings.Replace(pipelineManifest(t, f.oci, "2.4.1"), `"2.4.1"`, `"9.9.9"`, 1)
	digest, err := packages.WriteLayout(other, []byte(manifest), pipelineContent(t))
	if err != nil {
		t.Fatal(err)
	}
	f.registry.layout = other
	f.registry.tags = map[string]string{"v2.4.1": digest}
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); !errors.Is(err, ErrCrossCheck) {
		t.Fatalf("err = %v, want ErrCrossCheck", err)
	}
}

func TestUpdateFlow(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); err != nil {
		t.Fatal(err)
	}
	check, err := f.service.UpdateCheck(ctx, pipelinePID)
	if err != nil {
		t.Fatal(err)
	}
	if check.Available || !check.UpToDate {
		t.Fatalf("check = %+v, want up to date", check)
	}

	// A newer release publishes.
	f.rebuild(t, "2.5.0", "v2.5.0")
	check, err = f.service.UpdateCheck(ctx, pipelinePID)
	if err != nil {
		t.Fatal(err)
	}
	if !check.Available || check.Resolution.Digest != f.digest {
		t.Fatalf("check = %+v", check)
	}
	ids := map[string]string{}
	for _, item := range check.Contributions {
		ids[item.Kind] = item.ID
	}
	if len(check.Contributions) != 2 || ids["widget"] == "" || ids["dataSource"] == "" {
		t.Fatalf("update check contributions = %+v, want both with qualified IDs", check.Contributions)
	}
	if _, err := f.service.ApplyUpdate(ctx, pipelinePID, "sha256:"+strings.Repeat("0", 64), f.userID); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("stale apply err = %v, want ErrDigestMismatch", err)
	}
	result, err := f.service.ApplyUpdate(ctx, pipelinePID, f.digest, f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated || result.Installed.Version != "2.5.0" {
		t.Fatalf("result = %+v", result)
	}
	source, err := f.service.CustomSource(ctx, pipelinePID)
	if err != nil {
		t.Fatal(err)
	}
	if source.ResolvedDigest != f.digest || source.Manifest.PackageVersion != "2.5.0" {
		t.Fatalf("source = %+v", source)
	}
	// Applying again is a no-op.
	result, err = f.service.ApplyUpdate(ctx, pipelinePID, f.digest, f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Updated {
		t.Fatalf("result = %+v, want no-op", result)
	}
}

func TestInstallMarketplace(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	f.listing = f.catalogListing()
	installed, err := f.service.InstallMarketplace(ctx, pipelinePID, f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if installed.SourceKind != installer.SourceMarketplace || installed.Version != "2.4.1" {
		t.Fatalf("installed = %+v", installed)
	}
	if _, err := f.service.CustomSource(ctx, pipelinePID); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("source err = %v, want ErrNotInstalled", err)
	}
	// Marketplace updates refresh the catalog, then compare.
	f.rebuild(t, "2.5.0", "v2.5.0")
	f.listing = f.catalogListing()
	f.listing.Version = "2.5.0"
	check, err := f.service.UpdateCheck(ctx, pipelinePID)
	if err != nil {
		t.Fatal(err)
	}
	if f.refreshCalls != 1 {
		t.Fatalf("refresh calls = %d, want 1", f.refreshCalls)
	}
	if !check.Available {
		t.Fatalf("check = %+v, want available", check)
	}
	result, err := f.service.ApplyUpdate(ctx, pipelinePID, f.digest, f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated || result.Installed.Version != "2.5.0" {
		t.Fatalf("result = %+v", result)
	}
	// A non-GitHub listing repository refuses.
	f.listing.Repository = "https://example.com/acme/tilecast-athletics"
	if _, err := f.service.InstallMarketplace(ctx, "other.package", f.userID); !errors.Is(err, catalog.ErrUnknownPackage) {
		t.Fatalf("err = %v, want ErrUnknownPackage", err)
	}
}

func TestResolveMarketplace(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	f.listing = f.catalogListing()
	resolution, err := f.service.ResolveMarketplace(ctx, pipelinePID)
	if err != nil {
		t.Fatal(err)
	}
	// The review carries the published manifest, not the listing:
	// real contributions, pinned digest, and verified trust.
	if len(resolution.Manifest.Contributions) != 2 || resolution.Manifest.PackageVersion != "2.4.1" {
		t.Fatalf("manifest = %+v", resolution.Manifest)
	}
	if resolution.Digest != f.digest {
		t.Fatalf("digest = %s, want %s", resolution.Digest, f.digest)
	}
	if resolution.Signer != pipelineSign || resolution.Trust != installer.TrustVerified {
		t.Fatalf("trust = %s %s", resolution.Signer, resolution.Trust)
	}
	if !resolution.Compatible {
		t.Fatal("resolution should be compatible with Tilecast 1.5.0")
	}
	if _, err := f.service.CustomSource(ctx, pipelinePID); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("review installed a source: %v", err)
	}
	if _, err := f.service.ResolveMarketplace(ctx, "other.package"); !errors.Is(err, catalog.ErrUnknownPackage) {
		t.Fatalf("err = %v, want ErrUnknownPackage", err)
	}
}

func TestMarketplaceListingNotGitHub(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	f.listing = f.catalogListing()
	f.listing.Repository = "https://example.com/acme/tilecast-athletics"
	if _, err := f.service.InstallMarketplace(ctx, pipelinePID, f.userID); !errors.Is(err, ErrNotGitHub) {
		t.Fatalf("err = %v, want ErrNotGitHub", err)
	}
}

func TestRollbackAndRemove(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); err != nil {
		t.Fatal(err)
	}
	f.rebuild(t, "2.5.0", "v2.5.0")
	if _, err := f.service.ApplyUpdate(ctx, pipelinePID, f.digest, f.userID); err != nil {
		t.Fatal(err)
	}
	rolled, err := f.service.Rollback(ctx, pipelinePID, f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if rolled.Version != "2.4.1" {
		t.Fatalf("rolled = %+v", rolled)
	}
	if err := f.service.Remove(ctx, pipelinePID, f.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.installer.Get(ctx, pipelinePID); !errors.Is(err, installer.ErrNotFound) {
		t.Fatalf("Get = %v, want ErrNotFound", err)
	}
	// The custom source survives removal: the repository stays
	// available for reinstall.
	if _, err := f.service.CustomSource(ctx, pipelinePID); err != nil {
		t.Fatalf("source err = %v", err)
	}
}

func TestSourceConflict(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); err != nil {
		t.Fatal(err)
	}
	// The same repository now declares another package: one repository
	// supplies one package.
	manifest := strings.Replace(pipelineManifest(t, f.oci, "1.0.0"), pipelinePID, "acme.other", 1)
	f.github.manifest = manifest
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); !errors.Is(err, ErrSourceConflict) {
		t.Fatalf("err = %v, want ErrSourceConflict", err)
	}
}
