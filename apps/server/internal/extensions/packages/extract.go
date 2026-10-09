package packages

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Extraction bounds. Content blobs verify by digest before extraction,
// but a hostile author can still ship a validly-signed gzip bomb, so
// every dimension has a ceiling.
const (
	// MaxExtractedFiles caps entries across all content blobs.
	MaxExtractedFiles = 4096
	// MaxExtractedBytes caps total uncompressed content.
	MaxExtractedBytes = 1 << 30
	// MaxExtractedFileBytes caps one extracted file.
	MaxExtractedFileBytes = 256 << 20
	// MaxNestedManifestBytes caps one nested manifest document.
	MaxNestedManifestBytes = 1 << 20
	// MaxWidgetPayloadBytes caps one Widget player bundle served to
	// Players. The bundle is opaque bytes to the Server: integrity is
	// the digest claim, and safety is the Player sandbox.
	MaxWidgetPayloadBytes = 1 << 20
	// WidgetPayloadRel is the fixed path of the player bundle inside a
	// Widget contribution directory. Fixed, never author-declared, so a
	// manifest cannot steer the Server at an arbitrary package file.
	WidgetPayloadRel = "runtime/index.js"
)

var (
	widgetIDPattern     = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,79}$`)
	dataSourceIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,79}$`)
	pluginIDPattern     = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)
)

// NestedManifestFile names the manifest file per contribution kind, so
// definition decoding reads the same file activation validated.
func NestedManifestFile(kind string) (string, bool) {
	file, _, ok := nestedManifest(kind)
	return file, ok
}

// nestedManifest names the identity file per contribution kind.
func nestedManifest(kind string) (string, *regexp.Regexp, bool) {
	switch kind {
	case packagemanifest.ContributionPlugin:
		return "tilecast.plugin.json", pluginIDPattern, true
	case packagemanifest.ContributionWidget:
		return "tilecast.widget.json", widgetIDPattern, true
	case packagemanifest.ContributionDataSource:
		return "tilecast.datasource.json", dataSourceIDPattern, true
	}
	return "", nil, false
}

// ExtractContent unpacks every verified content blob of a layout into
// dest, which must not exist. Only regular files land: absolute paths,
// traversal, symlinks, hardlinks, devices, and duplicate names across or
// within blobs fail closed. Files land 0644; nothing here is executed.
func ExtractContent(layoutDir string, verified VerifiedPackage, destDir string) error {
	if err := os.Mkdir(destDir, 0o755); err != nil {
		return fmt.Errorf("package content: %w", err)
	}
	seen := make(map[string]bool, 256)
	var files int
	var total int64
	rollback := func() { os.RemoveAll(destDir) }
	for _, digest := range verified.ContentDigests {
		encoded := strings.TrimPrefix(digest, "sha256:")
		blob, err := os.Open(filepath.Join(layoutDir, "blobs", "sha256", encoded))
		if err != nil {
			rollback()
			return fmt.Errorf("package content: %w", err)
		}
		err = extractBlob(blob, destDir, seen, &files, &total)
		blob.Close()
		if err != nil {
			rollback()
			return err
		}
	}
	return nil
}

func extractBlob(blob *os.File, destDir string, seen map[string]bool, files *int, total *int64) error {
	gzipReader, err := gzip.NewReader(io.LimitReader(blob, MaxContentBytes+1))
	if err != nil {
		return fmt.Errorf("package content: blob is not gzip: %w", err)
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("package content: tar is corrupt: %w", err)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := extractDir(destDir, header.Name); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := extractFile(reader, destDir, header, seen, files, total); err != nil {
				return err
			}
		default:
			return fmt.Errorf("package content: entry %q is not a file or directory", header.Name)
		}
	}
}

// cleanEntry resolves a tar entry name inside dest. Anything absolute,
// traversing, or empty fails closed. The name cleans before joining so
// a leading ".." is rejected, not collapsed against the destination.
// The joined path then proves containment with a single prefix guard:
// the cleaned name can never address the destination itself ("." is
// rejected above), so the prefix check is the whole proof.
func cleanEntry(destDir, name string) (string, error) {
	if name == "" || filepath.IsAbs(name) {
		return "", fmt.Errorf("package content: entry %q escapes the package", name)
	}
	cleaned := filepath.Clean(name)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("package content: entry %q escapes the package", name)
	}
	joined := filepath.Join(destDir, cleaned)
	if !strings.HasPrefix(joined, filepath.Clean(destDir)+string(filepath.Separator)) {
		return "", fmt.Errorf("package content: entry %q escapes the package", name)
	}
	return joined, nil
}

func extractDir(destDir, name string) error {
	path, err := cleanEntry(destDir, name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return fmt.Errorf("package content: %w", err)
	}
	return nil
}

func extractFile(reader *tar.Reader, destDir string, header *tar.Header, seen map[string]bool, files *int, total *int64) error {
	path, err := cleanEntry(destDir, header.Name)
	if err != nil {
		return err
	}
	if seen[path] {
		return fmt.Errorf("package content: duplicate file %q", header.Name)
	}
	if *files >= MaxExtractedFiles {
		return fmt.Errorf("package content: exceeds %d files", MaxExtractedFiles)
	}
	if header.Size < 0 || header.Size > MaxExtractedFileBytes {
		return fmt.Errorf("package content: file %q exceeds %d bytes", header.Name, MaxExtractedFileBytes)
	}
	if *total+header.Size > MaxExtractedBytes {
		return fmt.Errorf("package content: exceeds %d bytes total", MaxExtractedBytes)
	}
	seen[path] = true
	*files++
	*total += header.Size
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("package content: %w", err)
	}
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("package content: %w", err)
	}
	defer out.Close()
	if _, err := io.CopyN(out, reader, header.Size); err != nil {
		return fmt.Errorf("package content: file %q is truncated: %w", header.Name, err)
	}
	return nil
}

// NestedContribution is one manifest contribution joined with its nested
// manifest identity, scoped to the package namespace.
type NestedContribution struct {
	Kind string
	ID   string
	Path string
	// Digest is the SHA-256 of the nested definition file.
	Digest string
}

// ReadContributions reads the nested manifest identity of every manifest
// contribution from extracted content. The contribution identity is the
// package ID plus the nested ID, so two packages never share one and
// every identity stays in its package namespace. Nested manifests keep
// their existing shapes; this release checks the identity and API
// version only, and execution stages validate the rest.
func ReadContributions(contentDir string, manifest packagemanifest.Manifest) ([]NestedContribution, error) {
	contributions := make([]NestedContribution, 0, len(manifest.Contributions))
	for _, contribution := range manifest.Contributions {
		file, pattern, ok := nestedManifest(contribution.Type)
		if !ok {
			return nil, fmt.Errorf("package content: unknown contribution type %q", contribution.Type)
		}
		// Manifest paths are ./relative by schema; containment is still
		// rechecked after joining.
		joined := filepath.Join(contentDir, contribution.Path, file)
		rel, err := filepath.Rel(contentDir, joined)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("package content: contribution path %q escapes the package", contribution.Path)
		}
		info, err := os.Stat(joined)
		if err != nil {
			return nil, fmt.Errorf("package content: contribution %q has no readable %s", contribution.Path, file)
		}
		if !info.Mode().IsRegular() || info.Size() > MaxNestedManifestBytes {
			return nil, fmt.Errorf("package content: contribution %q has no readable %s", contribution.Path, file)
		}
		raw, err := os.ReadFile(joined)
		if err != nil {
			return nil, fmt.Errorf("package content: contribution %q has no readable %s", contribution.Path, file)
		}
		var nested struct {
			APIVersion int    `json:"apiVersion"`
			ID         string `json:"id"`
		}
		if err := json.Unmarshal(raw, &nested); err != nil {
			return nil, fmt.Errorf("package content: contribution %q has a corrupt %s", contribution.Path, file)
		}
		if nested.APIVersion != 1 {
			return nil, fmt.Errorf("package content: contribution %q uses unsupported API version %d", contribution.Path, nested.APIVersion)
		}
		if !pattern.MatchString(nested.ID) {
			return nil, fmt.Errorf("package content: contribution %q has an invalid identity", contribution.Path)
		}
		id := manifest.PackageID + "." + nested.ID
		if len(id) > 128 {
			return nil, fmt.Errorf("package content: contribution %q identity exceeds 128 characters", contribution.Path)
		}
		sum := sha256.Sum256(raw)
		contributions = append(contributions, NestedContribution{Kind: contribution.Type, ID: id, Path: contribution.Path, Digest: hex.EncodeToString(sum[:])})
	}
	return contributions, nil
}
