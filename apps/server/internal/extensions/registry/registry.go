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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/opencontainers/go-digest"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
	"oras.land/oras-go/v2/registry/remote"
	"oras.land/oras-go/v2/registry/remote/auth"
)

const (
	maxManifestBytes = 1 << 20
	maxPackageLayers = 64
	// The package format already caps each content layer at 256 MiB.
	// A separate aggregate ceiling prevents many individually valid layers
	// from filling the server disk during one pull.
	maxPackageBytes = 512 << 20

	dialTimeout           = 10 * time.Second
	tlsHandshakeTimeout   = 10 * time.Second
	responseHeaderTimeout = 30 * time.Second
	idleConnTimeout       = 90 * time.Second
)

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

// Pull fetches one Tilecast package artifact by immutable digest.
//
// The registry is deliberately not traversed as a generic OCI graph. The
// pinned root must be a package image manifest with no subject; only its
// config and bounded package-content layers are fetched. This keeps indexes,
// referrers, subjects, and other graph edges from expanding one install into
// unbounded network or disk work.
func (r *Repository) Pull(ctx context.Context, ref, artifactDigest, targetDir string) error {
	if !packagemanifest.ValidOCIReference(ref) {
		return fmt.Errorf("registry reference %q is invalid", ref)
	}
	if !packagemanifest.ValidDigest(artifactDigest) {
		return fmt.Errorf("digest %q is not pinned", artifactDigest)
	}
	if err := os.MkdirAll(filepath.Join(targetDir, "blobs", "sha256"), 0o755); err != nil {
		return err
	}

	repository, err := remote.NewRepository(ref)
	if err != nil {
		return fmt.Errorf("registry reference %q: %w", ref, err)
	}
	repository.PlainHTTP = r.plainHTTP
	repository.Client = &auth.Client{Client: registryHTTPClient()}

	manifestDescriptor, manifestBytes, manifest, err := fetchManifest(ctx, repository, artifactDigest)
	if err != nil {
		return err
	}
	if err := validatePackageManifest(manifestDescriptor, manifest); err != nil {
		return err
	}

	for _, described := range append([]ocispec.Descriptor{manifest.Config}, manifest.Layers...) {
		if err := copyBlob(ctx, repository, described, targetDir); err != nil {
			return err
		}
	}
	if err := writeLocalBlob(targetDir, manifestDescriptor, manifestBytes); err != nil {
		return err
	}
	return writeLayoutMetadata(targetDir, manifestDescriptor)
}

func registryHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{
		Timeout:   dialTimeout,
		KeepAlive: 30 * time.Second,
	}).DialContext
	transport.TLSHandshakeTimeout = tlsHandshakeTimeout
	transport.ResponseHeaderTimeout = responseHeaderTimeout
	transport.ExpectContinueTimeout = time.Second
	transport.IdleConnTimeout = idleConnTimeout
	// Do not set http.Client.Timeout: it includes streaming response bodies
	// and would turn a slow but healthy large package transfer into a failure.
	// Callers own the overall operation deadline through ctx.
	return &http.Client{Transport: transport}
}

func fetchManifest(
	ctx context.Context,
	repository *remote.Repository,
	artifactDigest string,
) (ocispec.Descriptor, []byte, ocispec.Manifest, error) {
	parsed, err := digest.Parse(artifactDigest)
	if err != nil {
		return ocispec.Descriptor{}, nil, ocispec.Manifest{}, err
	}
	described, reader, err := repository.Manifests().FetchReference(ctx, parsed.String())
	if err != nil {
		return ocispec.Descriptor{}, nil, ocispec.Manifest{}, fmt.Errorf("fetch manifest: %w", err)
	}
	defer reader.Close()

	body, err := io.ReadAll(io.LimitReader(reader, maxManifestBytes+1))
	if err != nil {
		return ocispec.Descriptor{}, nil, ocispec.Manifest{}, fmt.Errorf("read manifest: %w", err)
	}
	if len(body) > maxManifestBytes {
		return ocispec.Descriptor{}, nil, ocispec.Manifest{}, errors.New("manifest exceeds 1 MiB")
	}
	if described.Digest != parsed || digest.FromBytes(body) != parsed {
		return ocispec.Descriptor{}, nil, ocispec.Manifest{}, errors.New("manifest digest does not match the pinned digest")
	}
	if described.Size != int64(len(body)) {
		return ocispec.Descriptor{}, nil, ocispec.Manifest{}, errors.New("manifest size does not match its descriptor")
	}

	var manifest ocispec.Manifest
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return ocispec.Descriptor{}, nil, ocispec.Manifest{}, fmt.Errorf("manifest is corrupt: %w", err)
	}
	return described, body, manifest, nil
}

func validatePackageManifest(described ocispec.Descriptor, manifest ocispec.Manifest) error {
	if described.MediaType != packages.MediaTypeOCIManifest {
		return fmt.Errorf("root media type %q is not a package manifest", described.MediaType)
	}
	if manifest.SchemaVersion != 2 || manifest.MediaType != packages.MediaTypeOCIManifest {
		return errors.New("root is not an OCI image manifest")
	}
	if manifest.ArtifactType != packages.ArtifactTilecastPackage {
		return fmt.Errorf("artifact type %q is not a Tilecast package", manifest.ArtifactType)
	}
	if manifest.Subject != nil {
		return errors.New("package manifests must not declare a subject")
	}
	if manifest.Config.MediaType != packages.MediaTypePackageConfig {
		return fmt.Errorf("config type %q is not a package manifest", manifest.Config.MediaType)
	}
	if err := validateBlobDescriptor(manifest.Config, packages.MaxConfigBytes); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if len(manifest.Layers) == 0 {
		return errors.New("package manifest has no content layers")
	}
	if len(manifest.Layers) > maxPackageLayers {
		return fmt.Errorf("package manifest has %d layers; maximum is %d", len(manifest.Layers), maxPackageLayers)
	}

	total := manifest.Config.Size
	for index, layer := range manifest.Layers {
		if layer.MediaType != packages.MediaTypePackageContent {
			return fmt.Errorf("layer %d type %q is not package content", index, layer.MediaType)
		}
		if err := validateBlobDescriptor(layer, packages.MaxContentBytes); err != nil {
			return fmt.Errorf("layer %d: %w", index, err)
		}
		if total > maxPackageBytes-layer.Size {
			return fmt.Errorf("package declares more than %d bytes", maxPackageBytes)
		}
		total += layer.Size
	}
	if total > maxPackageBytes {
		return fmt.Errorf("package declares %d bytes; maximum is %d", total, maxPackageBytes)
	}
	return nil
}

func validateBlobDescriptor(described ocispec.Descriptor, maxBytes int64) error {
	if !packagemanifest.ValidDigest(described.Digest.String()) {
		return fmt.Errorf("digest %q is not a pinned sha256 digest", described.Digest)
	}
	if described.Size < 0 {
		return errors.New("declared size is negative")
	}
	if described.Size > maxBytes {
		return fmt.Errorf("declares %d bytes; maximum is %d", described.Size, maxBytes)
	}
	return nil
}

func copyBlob(
	ctx context.Context,
	repository *remote.Repository,
	described ocispec.Descriptor,
	targetDir string,
) error {
	reader, err := repository.Fetch(ctx, described)
	if err != nil {
		return fmt.Errorf("fetch blob %s: %w", described.Digest, err)
	}
	defer reader.Close()

	blobDir := filepath.Join(targetDir, "blobs", "sha256")
	temp, err := os.CreateTemp(blobDir, ".pull-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName) //nolint:errcheck

	hasher := sha256.New()
	written, copyErr := io.Copy(
		io.MultiWriter(temp, hasher),
		io.LimitReader(reader, described.Size+1),
	)
	closeErr := temp.Close()
	if copyErr != nil {
		return fmt.Errorf("read blob %s: %w", described.Digest, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("write blob %s: %w", described.Digest, closeErr)
	}
	if written != described.Size {
		return fmt.Errorf("blob %s size mismatch", described.Digest)
	}
	actualDigest := "sha256:" + hex.EncodeToString(hasher.Sum(nil))
	if actualDigest != described.Digest.String() {
		return fmt.Errorf("blob %s digest mismatch", described.Digest)
	}

	finalPath, err := blobPath(targetDir, described.Digest.String())
	if err != nil {
		return err
	}
	if err := os.Chmod(tempName, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tempName, finalPath); err != nil {
		return fmt.Errorf("store blob %s: %w", described.Digest, err)
	}
	return nil
}

func writeLocalBlob(targetDir string, described ocispec.Descriptor, data []byte) error {
	if int64(len(data)) != described.Size || digest.FromBytes(data) != described.Digest {
		return fmt.Errorf("manifest %s failed local verification", described.Digest)
	}
	path, err := blobPath(targetDir, described.Digest.String())
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("store manifest %s: %w", described.Digest, err)
	}
	return nil
}

func blobPath(targetDir, value string) (string, error) {
	if !packagemanifest.ValidDigest(value) {
		return "", fmt.Errorf("digest %q is not a pinned sha256 digest", value)
	}
	encoded := strings.TrimPrefix(value, "sha256:")
	return filepath.Join(targetDir, "blobs", "sha256", encoded), nil
}

func writeLayoutMetadata(targetDir string, manifest ocispec.Descriptor) error {
	index := struct {
		SchemaVersion int                  `json:"schemaVersion"`
		MediaType     string               `json:"mediaType"`
		Manifests     []ocispec.Descriptor `json:"manifests"`
	}{
		SchemaVersion: 2,
		MediaType:     packages.MediaTypeOCIIndex,
		Manifests:     []ocispec.Descriptor{manifest},
	}
	indexJSON, err := json.Marshal(index)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(targetDir, "index.json"), indexJSON, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(
		filepath.Join(targetDir, "oci-layout"),
		[]byte("{\"imageLayoutVersion\":\"1.0.0\"}\n"),
		0o644,
	); err != nil {
		return err
	}
	return nil
}
