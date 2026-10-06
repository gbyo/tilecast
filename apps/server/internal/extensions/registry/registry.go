// Package registry fetches extension package artifacts from OCI
// registries by immutable digest.
//
// A pull resolves a registry reference plus a catalog-pinned digest into
// an OCI layout directory, which the layout verifier in
// internal/extensions/packages then checks before anything activates.
// Tags are never resolved here: the digest selects the manifest, and every
// blob verifies against its descriptor. Catalog signatures decide which
// digests are worth fetching; registry bytes stay untrusted until the
// verifier approves them.
package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/opencontainers/go-digest"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
	"oras.land/oras-go/v2"
	"oras.land/oras-go/v2/content/oci"
	"oras.land/oras-go/v2/registry/remote"
	"oras.land/oras-go/v2/registry/remote/auth"
)

// pullTimeout bounds one artifact pull, including content blobs.
const pullTimeout = 10 * time.Minute

// Fetcher pulls artifacts. The production implementation is Repository;
// tests substitute fakes.
type Fetcher interface {
	Pull(ctx context.Context, ref, artifactDigest, targetDir string) error
}

// Repository pulls from OCI registries.
type Repository struct {
	plainHTTP bool
}

// Option configures a Repository.
type Option func(*Repository)

// WithPlainHTTP allows cleartext registries. Tests and development only;
// production pulls stay https.
func WithPlainHTTP() Option {
	return func(r *Repository) { r.plainHTTP = true }
}

// NewRepository pulls anonymously. Authenticated registries arrive with
// private marketplace support.
func NewRepository(options ...Option) *Repository {
	repository := &Repository{}
	for _, option := range options {
		option(repository)
	}
	return repository
}

// Pull fetches the artifact at ref pinned to artifactDigest into targetDir
// as an OCI layout. The manifest is size-checked before any blob copies,
// so a hostile registry cannot fill the disk with an unbounded layer.
func (r *Repository) Pull(ctx context.Context, ref, artifactDigest, targetDir string) error {
	if !packagemanifest.ValidOCIReference(ref) {
		return fmt.Errorf("registry reference %q is invalid", ref)
	}
	if !packagemanifest.ValidDigest(artifactDigest) {
		return fmt.Errorf("digest %q is not pinned", artifactDigest)
	}
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return err
	}
	repository, err := remote.NewRepository(ref)
	if err != nil {
		return fmt.Errorf("registry reference %q: %w", ref, err)
	}
	repository.PlainHTTP = r.plainHTTP
	repository.Client = &auth.Client{Client: &http.Client{Timeout: pullTimeout}}
	manifest, err := fetchManifest(ctx, repository, artifactDigest)
	if err != nil {
		return err
	}
	if err := checkManifestSizes(manifest); err != nil {
		return err
	}
	store, err := oci.New(targetDir)
	if err != nil {
		return err
	}
	_, err = oras.Copy(ctx, repository, artifactDigest, store, artifactDigest, oras.DefaultCopyOptions)
	if err != nil {
		return fmt.Errorf("pull %s@%s: %w", ref, artifactDigest, err)
	}
	return nil
}

func fetchManifest(ctx context.Context, repository *remote.Repository, artifactDigest string) (ocispec.Manifest, error) {
	parsed, err := digest.Parse(artifactDigest)
	if err != nil {
		return ocispec.Manifest{}, err
	}
	_, reader, err := repository.Manifests().FetchReference(ctx, parsed.String())
	if err != nil {
		return ocispec.Manifest{}, fmt.Errorf("fetch manifest: %w", err)
	}
	defer reader.Close()
	// Manifests are small JSON documents; anything larger is hostile.
	body, err := io.ReadAll(io.LimitReader(reader, 1<<20+1))
	if err != nil {
		return ocispec.Manifest{}, fmt.Errorf("read manifest: %w", err)
	}
	if len(body) > 1<<20 {
		return ocispec.Manifest{}, errors.New("manifest exceeds 1 MiB")
	}
	var manifest ocispec.Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return ocispec.Manifest{}, fmt.Errorf("manifest is corrupt: %w", err)
	}
	return manifest, nil
}

// checkManifestSizes refuses an artifact whose declared blobs exceed the
// layout verifier's bounds before any byte copies.
func checkManifestSizes(manifest ocispec.Manifest) error {
	if manifest.Config.Size > 1<<20 {
		return fmt.Errorf("config blob declares %d bytes", manifest.Config.Size)
	}
	for _, layer := range manifest.Layers {
		if layer.Size > 256<<20 {
			return fmt.Errorf("content blob declares %d bytes", layer.Size)
		}
	}
	return nil
}
