package pipeline

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/github"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/registry"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// publicFixtureGitHub and publicFixtureRegistry serve one package under its
// own repository identity, so a third-party package passes through the same
// resolver and registry client a public installation uses. Only the network
// endpoints and the Sigstore bundle check are replaced; the resolver, manifest
// cross-checks, compatibility gate, and installer are production code.
type publicFixtureGitHub struct {
	owner, repo, tag, manifest string
	latestPublished            bool
}

func (f *publicFixtureGitHub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/repos/" + f.owner + "/" + f.repo
		switch path := r.URL.Path; {
		case path == base:
			fmt.Fprint(w, `{"default_branch":"main","private":false}`)
		case path == base+"/releases/latest":
			// GitHub's latest-release endpoint omits drafts and prereleases.
			if !f.latestPublished {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			fmt.Fprintf(w, `{"tag_name":%q,"name":%q,"published_at":"2026-10-20T12:00:00Z"}`, f.tag, f.tag)
		case path == base+"/contents/tilecast.package.json":
			if r.URL.Query().Get("ref") != f.tag {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			fmt.Fprintf(w, `{"type":"file","encoding":"base64","content":%q}`, base64.StdEncoding.EncodeToString([]byte(f.manifest)))
		case strings.HasPrefix(path, base+"/attestations/"):
			fmt.Fprint(w, `{"attestations":[{"bundle":{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}}]}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

type publicFixtureVerifier struct {
	owner, repo, signer string
	seen                []string
}

func (v *publicFixtureVerifier) Verify(bundleJSON []byte, digest, owner, repo string) (string, error) {
	if owner != v.owner || repo != v.repo || len(bundleJSON) == 0 {
		return "", errors.New("attestation checked for the wrong repository")
	}
	v.seen = append(v.seen, digest)
	return v.signer, nil
}

func publicFixtureRegistry(layout, owner, repo, tag, digest string) http.Handler {
	prefix := "/v2/" + owner + "/" + repo + "/"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/" {
			return
		}
		trimmed, ok := strings.CutPrefix(r.URL.Path, prefix)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		reference, isManifest := "", false
		if rest, found := strings.CutPrefix(trimmed, "manifests/"); found {
			reference, isManifest = rest, true
		} else if rest, found := strings.CutPrefix(trimmed, "blobs/"); found {
			reference = rest
		} else {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if reference == tag {
			reference = digest
		}
		data, err := os.ReadFile(filepath.Join(layout, "blobs", "sha256", strings.TrimPrefix(reference, "sha256:")))
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Docker-Content-Digest", reference)
		if isManifest {
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
		}
		w.Write(data)
	})
}

// TestPublicInstallPathAcceptsExternalPackageFixture runs a real built
// package through the custom-repository install path: public repository
// resolution, latest-release lookup, release-tag manifest cross-check, OCI
// resolution, provenance check, compatibility gate, install review and a fresh
// re-resolution at install. Set TILECAST_EXTERNAL_PACKAGE_FIXTURE to the
// package's build/oci layout.
func TestPublicInstallPathAcceptsExternalPackageFixture(t *testing.T) {
	layoutPath := os.Getenv("TILECAST_EXTERNAL_PACKAGE_FIXTURE")
	if layoutPath == "" {
		t.Skip("TILECAST_EXTERNAL_PACKAGE_FIXTURE is not set")
	}
	f := newPipelineFixture(t)
	ctx := context.Background()
	original, err := packages.VerifyLayout(layoutPath)
	if err != nil {
		t.Fatal(err)
	}
	owner, repo, found := strings.Cut(strings.TrimPrefix(original.Manifest.Repository, "https://github.com/"), "/")
	if !found {
		t.Fatalf("repository %q is not a GitHub address", original.Manifest.Repository)
	}
	tag := "v" + original.Manifest.PackageVersion
	signer := fmt.Sprintf("https://github.com/%s/%s/.github/workflows/release.yml@refs/tags/%s", owner, repo, tag)
	content, err := os.ReadFile(filepath.Join(layoutPath, "blobs", "sha256", strings.TrimPrefix(original.ContentDigests[0], "sha256:")))
	if err != nil {
		t.Fatal(err)
	}
	// serve builds a service whose fakes publish `manifest` (as the release
	// tag's tilecast.package.json and as the OCI config) under the package's
	// own repository identity.
	serve := func(t *testing.T, manifest packagemanifest.Manifest, serverVersion string, latestPublished bool) (*Service, *publicFixtureVerifier, string) {
		t.Helper()
		verifier := &publicFixtureVerifier{owner: owner, repo: repo, signer: signer}
		githubFake := &publicFixtureGitHub{owner: owner, repo: repo, tag: tag, latestPublished: latestPublished}
		githubServer := httptest.NewServer(githubFake.handler())
		t.Cleanup(githubServer.Close)
		layout := t.TempDir()
		digestHolder := new(string)
		registryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			publicFixtureRegistry(layout, owner, repo, tag, *digestHolder).ServeHTTP(w, r)
		}))
		t.Cleanup(registryServer.Close)
		manifest.Distribution.OCI = strings.TrimPrefix(registryServer.URL, "http://") + "/" + owner + "/" + repo
		config, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		digest, err := packages.WriteLayout(layout, config, content)
		if err != nil {
			t.Fatal(err)
		}
		*digestHolder = digest
		githubFake.manifest = string(config)
		client, err := github.NewClient(githubServer.URL, "")
		if err != nil {
			t.Fatal(err)
		}
		service := NewService(f.pool, f.installer, t.TempDir(), serverVersion,
			WithGitHub(client), WithRegistry(registry.NewRepository(registry.WithPlainHTTP())), WithAttestations(verifier))
		return service, verifier, digest
	}
	repositoryURL := original.Manifest.Repository

	t.Run("the draft range is shown as incompatible and cannot be installed", func(t *testing.T) {
		service, _, _ := serve(t, original.Manifest, "1.5.0", true)
		resolution, err := service.ResolveCustom(ctx, repositoryURL)
		if err != nil {
			t.Fatal(err)
		}
		if resolution.Compatible {
			t.Fatal("the draft package must not claim an existing Tilecast release")
		}
		if _, err := service.InstallCustom(ctx, repositoryURL, f.userID); err == nil {
			t.Fatal("an incompatible package installed")
		}
	})

	compatible := original.Manifest
	compatible.Tilecast.Version = ">=1.5.0 <2.0.0"

	t.Run("a draft or prerelease release is invisible to the resolver", func(t *testing.T) {
		service, _, _ := serve(t, compatible, "1.5.0", false)
		if _, err := service.ResolveCustom(ctx, repositoryURL); err == nil || !strings.Contains(err.Error(), "no published release") {
			t.Fatalf("resolve with no published release: %v", err)
		}
	})

	t.Run("the published release resolves, reviews, and installs with verified provenance", func(t *testing.T) {
		service, verifier, digest := serve(t, compatible, "1.5.0", true)
		resolution, err := service.ResolveCustom(ctx, repositoryURL)
		if err != nil {
			t.Fatal(err)
		}
		if !resolution.Compatible || resolution.Trust != installer.TrustVerified || resolution.Signer != signer {
			t.Fatalf("resolution: compatible=%v trust=%s signer=%s", resolution.Compatible, resolution.Trust, resolution.Signer)
		}
		if resolution.Digest != digest || resolution.ReleaseTag != tag || resolution.Manifest.PackageID != original.Manifest.PackageID {
			t.Fatalf("resolution identity: %+v", resolution)
		}
		for _, wanted := range []string{"signage.weeklywildcat.com"} {
			if resolution.Manifest.Capabilities == nil || resolution.Manifest.Capabilities.Network == nil ||
				!containsString(resolution.Manifest.Capabilities.Network.Hosts, wanted) {
				t.Fatalf("the reviewed network host %q is missing", wanted)
			}
		}
		installed, err := service.InstallCustom(ctx, repositoryURL, f.userID)
		if err != nil {
			t.Fatal(err)
		}
		if installed.Digest != digest || installed.Trust != installer.TrustVerified || installed.SourceKind != installer.SourceCustom {
			t.Fatalf("installed = %+v", installed)
		}
		if len(verifier.seen) < 2 {
			t.Fatalf("provenance was checked %d time(s); resolve and install each re-resolve", len(verifier.seen))
		}
		claims, err := f.installer.Contributions(ctx, installed.PackageID)
		if err != nil {
			t.Fatal(err)
		}
		plugins := 0
		for _, claim := range claims {
			if claim.Kind == "plugin" {
				plugins++
			}
		}
		if plugins != 1 {
			t.Fatalf("contributions = %+v", claims)
		}
		if err := f.installer.Remove(ctx, installed.PackageID, f.userID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("a Beta of the minimum core version satisfies the range and an older Beta does not", func(t *testing.T) {
		service, _, _ := serve(t, compatible, "1.5.0-beta.4", true)
		resolution, err := service.ResolveCustom(ctx, repositoryURL)
		if err != nil || !resolution.Compatible {
			t.Fatalf("Beta of the minimum core: %+v %v", resolution.Compatible, err)
		}
		service, _, _ = serve(t, compatible, "1.4.0-beta.9", true)
		resolution, err = service.ResolveCustom(ctx, repositoryURL)
		if err != nil || resolution.Compatible {
			t.Fatalf("older Beta: %+v %v", resolution.Compatible, err)
		}
	})
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
