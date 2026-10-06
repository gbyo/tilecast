// Package packages defines the Tilecast extension package OCI artifact
// layout and verifies package bytes before anything activates.
//
// A package travels as a standard OCI image: a JSON config blob carrying
// the validated `tilecast.package.json`, and content blobs carrying the
// contribution files. The installer pins the artifact by its manifest
// digest; a floating tag is never executed or recorded. Remote registry
// transport arrives with the marketplace and custom-repository stages and
// feeds this same verifier, so local layouts, offline imports, and registry
// pulls share one digest-pinned activation path.
package packages

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Tilecast OCI media types, version 1.
const (
	// ArtifactTilecastPackage marks the image manifest as a Tilecast package.
	ArtifactTilecastPackage = "application/vnd.tilecast.package.v1+json"
	// MediaTypePackageConfig is the config blob: the package manifest JSON.
	MediaTypePackageConfig = "application/vnd.tilecast.package.config.v1+json"
	// MediaTypePackageContent is a content blob: a gzip tar of package files.
	MediaTypePackageContent = "application/vnd.tilecast.package.content.v1.tar+gzip"
	// MediaTypeOCIManifest and MediaTypeOCIIndex are the stock OCI types.
	MediaTypeOCIManifest = "application/vnd.oci.image.manifest.v1+json"
	MediaTypeOCIIndex    = "application/vnd.oci.image.index.v1+json"
)

// Verification bounds. Layouts are untrusted input until every digest
// verifies, so every document has a ceiling before it parses.
const (
	// MaxLayoutDocBytes caps oci-layout, index, and manifest documents.
	MaxLayoutDocBytes = 1 << 20
	// MaxConfigBytes caps the package manifest config blob.
	MaxConfigBytes = 1 << 20
	// MaxContentBytes caps one content blob.
	MaxContentBytes = 256 << 20
)

// VerifiedPackage is a layout whose digests check out: the validated
// manifest, the artifact digest the installer pins, and the verified
// content blob digests.
type VerifiedPackage struct {
	Manifest       packagemanifest.Manifest
	Digest         string
	ContentDigests []string
}

// descriptor is an OCI content descriptor.
type descriptor struct {
	MediaType    string `json:"mediaType"`
	ArtifactType string `json:"artifactType,omitempty"`
	Digest       string `json:"digest"`
	Size         int64  `json:"size"`
}

// index is an OCI image index.
type index struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType"`
	Manifests     []descriptor `json:"manifests"`
}

// imageManifest is an OCI image manifest.
type imageManifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType"`
	ArtifactType  string       `json:"artifactType"`
	Config        descriptor   `json:"config"`
	Layers        []descriptor `json:"layers"`
}

// VerifyLayout opens an OCI image layout directory, verifies every digest
// it follows, and returns the validated package. Anything unexpected — a
// missing file, a digest mismatch, a wrong media type, an invalid manifest,
// an oversized blob — fails closed with no partial result.
func VerifyLayout(dir string) (VerifiedPackage, error) {
	layout, err := readBounded(filepath.Join(dir, "oci-layout"), MaxLayoutDocBytes)
	if err != nil {
		return VerifiedPackage{}, fmt.Errorf("package layout: %w", err)
	}
	var layoutDoc struct {
		ImageLayoutVersion string `json:"imageLayoutVersion"`
	}
	if err := json.Unmarshal(layout, &layoutDoc); err != nil {
		return VerifiedPackage{}, fmt.Errorf("package layout: oci-layout is corrupt: %w", err)
	}
	if layoutDoc.ImageLayoutVersion != "1.0.0" {
		return VerifiedPackage{}, fmt.Errorf("package layout: unsupported layout version %q", layoutDoc.ImageLayoutVersion)
	}
	indexDoc, err := readBounded(filepath.Join(dir, "index.json"), MaxLayoutDocBytes)
	if err != nil {
		return VerifiedPackage{}, fmt.Errorf("package layout: %w", err)
	}
	var index index
	if err := json.Unmarshal(indexDoc, &index); err != nil {
		return VerifiedPackage{}, fmt.Errorf("package layout: index is corrupt: %w", err)
	}
	manifestDescriptor, ok := selectPackageManifest(index.Manifests)
	if !ok {
		return VerifiedPackage{}, fmt.Errorf("package layout: no Tilecast package manifest")
	}
	manifestBytes, err := readBlob(dir, manifestDescriptor, MaxLayoutDocBytes)
	if err != nil {
		return VerifiedPackage{}, fmt.Errorf("package layout: %w", err)
	}
	var manifest imageManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return VerifiedPackage{}, fmt.Errorf("package layout: manifest is corrupt: %w", err)
	}
	if manifest.ArtifactType != "" && manifest.ArtifactType != ArtifactTilecastPackage {
		return VerifiedPackage{}, fmt.Errorf("package layout: artifact type %q is not a Tilecast package", manifest.ArtifactType)
	}
	if manifest.Config.MediaType != MediaTypePackageConfig {
		return VerifiedPackage{}, fmt.Errorf("package layout: config type %q is not a package manifest", manifest.Config.MediaType)
	}
	configBytes, err := readBlob(dir, manifest.Config, MaxConfigBytes)
	if err != nil {
		return VerifiedPackage{}, fmt.Errorf("package layout: %w", err)
	}
	parsed, err := packagemanifest.Parse(configBytes)
	if err != nil {
		return VerifiedPackage{}, err
	}
	verified := VerifiedPackage{Manifest: parsed, Digest: manifestDescriptor.Digest}
	for _, layer := range manifest.Layers {
		if layer.MediaType != MediaTypePackageContent {
			return VerifiedPackage{}, fmt.Errorf("package layout: layer type %q is not package content", layer.MediaType)
		}
		if _, err := readBlob(dir, layer, MaxContentBytes); err != nil {
			return VerifiedPackage{}, fmt.Errorf("package layout: %w", err)
		}
		verified.ContentDigests = append(verified.ContentDigests, layer.Digest)
	}
	return verified, nil
}

// selectPackageManifest picks the layout's Tilecast package manifest: the
// descriptor whose artifact type names a package, or — for layouts that
// predate the artifact type — the single manifest present. Anything else is
// ambiguous and fails closed.
func selectPackageManifest(manifests []descriptor) (descriptor, bool) {
	for _, candidate := range manifests {
		if candidate.MediaType == MediaTypeOCIManifest && candidate.ArtifactType == ArtifactTilecastPackage {
			return candidate, true
		}
	}
	if len(manifests) == 1 && manifests[0].MediaType == MediaTypeOCIManifest && manifests[0].ArtifactType == "" {
		return manifests[0], true
	}
	return descriptor{}, false
}

func readBounded(path string, maxBytes int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	if info.Size() > maxBytes {
		return nil, fmt.Errorf("%s exceeds %d bytes", filepath.Base(path), maxBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return data, nil
}

// readBlob reads one content-addressed blob and verifies its digest and
// size. The digest selects the file and checks it; nothing else is trusted.
func readBlob(dir string, described descriptor, maxBytes int64) ([]byte, error) {
	algorithm, encoded, ok := strings.Cut(described.Digest, ":")
	if !ok || algorithm != "sha256" {
		return nil, fmt.Errorf("unsupported digest %q", described.Digest)
	}
	if len(encoded) != 64 {
		return nil, fmt.Errorf("malformed digest %q", described.Digest)
	}
	path := filepath.Join(dir, "blobs", "sha256", encoded)
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("blob %s: %w", described.Digest, err)
	}
	if info.Size() > maxBytes {
		return nil, fmt.Errorf("blob %s exceeds %d bytes", described.Digest, maxBytes)
	}
	if described.Size >= 0 && info.Size() != described.Size {
		return nil, fmt.Errorf("blob %s size mismatch", described.Digest)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("blob %s: %w", described.Digest, err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != encoded {
		return nil, fmt.Errorf("blob %s digest mismatch", described.Digest)
	}
	return data, nil
}

// WriteLayout writes one package as an OCI image layout: the manifest as
// the config blob and content as a single gzip-tar layer. Tests and future
// publish tooling build layouts through it, so the writer and the verifier
// cannot disagree on the shape.
func WriteLayout(dir string, manifestJSON, contentTarGzip []byte) (digest string, err error) {
	if err := os.MkdirAll(filepath.Join(dir, "blobs", "sha256"), 0o755); err != nil {
		return "", err
	}
	config := storeBlob(dir, MediaTypePackageConfig, manifestJSON)
	layer := storeBlob(dir, MediaTypePackageContent, contentTarGzip)
	image := imageManifest{
		SchemaVersion: 2,
		MediaType:     MediaTypeOCIManifest,
		ArtifactType:  ArtifactTilecastPackage,
		Config:        config,
		Layers:        []descriptor{layer},
	}
	imageJSON, err := json.Marshal(image)
	if err != nil {
		return "", err
	}
	imageDescriptor := storeBlob(dir, MediaTypeOCIManifest, imageJSON)
	imageDescriptor.ArtifactType = ArtifactTilecastPackage
	index := index{
		SchemaVersion: 2,
		MediaType:     MediaTypeOCIIndex,
		Manifests:     []descriptor{imageDescriptor},
	}
	indexJSON, err := json.Marshal(index)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "index.json"), indexJSON, 0o644); err != nil {
		return "", err
	}
	layout := `{"imageLayoutVersion":"1.0.0"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "oci-layout"), []byte(layout), 0o644); err != nil {
		return "", err
	}
	return imageDescriptor.Digest, nil
}

func storeBlob(dir, mediaType string, data []byte) descriptor {
	sum := sha256.Sum256(data)
	encoded := hex.EncodeToString(sum[:])
	_ = os.WriteFile(filepath.Join(dir, "blobs", "sha256", encoded), data, 0o644)
	return descriptor{
		MediaType: mediaType,
		Digest:    "sha256:" + encoded,
		Size:      int64(len(data)),
	}
}
