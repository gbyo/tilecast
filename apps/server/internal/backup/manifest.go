// Package backup implements full-installation backup archives and safe
// staged restore for Tilecast: a consistent PostgreSQL logical dump plus all
// Tilecast-managed files, wrapped in a single verified tar archive.
package backup

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// FormatVersion identifies the archive layout. Readers must reject archives
// with a newer format version.
const FormatVersion = 1

// ManifestPath is the archive entry holding the manifest. It is always the
// final entry so checksums for every component can be computed while the
// archive streams.
const ManifestPath = "manifest.json"

// Component names recorded in the manifest.
const (
	ComponentDatabase        = "database"
	ComponentMediaOriginals  = "media_originals"
	ComponentMediaVariants   = "media_variants"
	ComponentMediaThumbnails = "media_thumbnails"
	ComponentPlayerUpdates   = "player_updates"
)

// RequiredComponents lists every component a complete backup must contain.
// A database-only or media-only archive is not a complete backup.
var RequiredComponents = []string{
	ComponentDatabase,
	ComponentMediaOriginals,
	ComponentMediaVariants,
	ComponentMediaThumbnails,
	ComponentPlayerUpdates,
}

// Archive path prefixes for each component.
const (
	databasePrefix   = "db/"
	mediaPrefix      = "media/"
	originalsPrefix  = "media/originals/"
	variantsPrefix   = "media/variants/"
	thumbnailsPrefix = "media/thumbnails/"
	updatesPrefix    = "updates/"
)

// ManifestFile describes one archived file with its integrity checksum.
type ManifestFile struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

// ManifestComponent summarizes one included component.
type ManifestComponent struct {
	Name       string `json:"name"`
	FileCount  int    `json:"fileCount"`
	TotalBytes int64  `json:"totalBytes"`
}

// TableDump records one archived database table.
type TableDump struct {
	Name        string `json:"name"`
	Rows        int64  `json:"rows"`
	ArchivePath string `json:"archivePath"`
}

// SequenceState records a sequence position for restore.
type SequenceState struct {
	Name     string `json:"name"`
	Value    int64  `json:"value"`
	IsCalled bool   `json:"isCalled"`
}

// DatabaseManifest describes the archived database snapshot.
type DatabaseManifest struct {
	Tables    []TableDump     `json:"tables"`
	Sequences []SequenceState `json:"sequences"`
}

// Manifest is the versioned description of a backup archive.
type Manifest struct {
	FormatVersion    int                 `json:"formatVersion"`
	TilecastVersion  string              `json:"tilecastVersion"`
	SchemaVersion    int64               `json:"schemaVersion"`
	InstallationID   string              `json:"installationId"`
	OrganizationName string              `json:"organizationName"`
	CreatedAt        time.Time           `json:"createdAt"`
	Components       []ManifestComponent `json:"components"`
	Database         DatabaseManifest    `json:"database"`
	Files            []ManifestFile      `json:"files"`
	// ServerChannel, BuildCommit, and BuildDate record which server build
	// created the archive. They are additive: archives written before they
	// existed decode with empty values and remain valid.
	ServerChannel string `json:"serverChannel,omitempty"`
	BuildCommit   string `json:"buildCommit,omitempty"`
	BuildDate     string `json:"buildDate,omitempty"`
}

// TotalBytes reports the summed size of every archived file.
func (m Manifest) TotalBytes() int64 {
	var total int64
	for _, file := range m.Files {
		total += file.SizeBytes
	}
	return total
}

// Component returns the named component summary if present.
func (m Manifest) Component(name string) (ManifestComponent, bool) {
	for _, component := range m.Components {
		if component.Name == name {
			return component, true
		}
	}
	return ManifestComponent{}, false
}

// Validate checks structural manifest invariants shared by creation,
// verification, and restore.
func (m Manifest) Validate() error {
	if m.FormatVersion <= 0 {
		return fmt.Errorf("manifest format version is missing")
	}
	if m.FormatVersion > FormatVersion {
		return fmt.Errorf("archive format version %d is newer than this server supports (%d)", m.FormatVersion, FormatVersion)
	}
	if m.SchemaVersion <= 0 {
		return fmt.Errorf("manifest schema version is missing")
	}
	if strings.TrimSpace(m.InstallationID) == "" {
		return fmt.Errorf("manifest installation identity is missing")
	}
	for _, required := range RequiredComponents {
		if _, ok := m.Component(required); !ok {
			return fmt.Errorf("archive is missing the %s component and is not a complete backup", required)
		}
	}
	if len(m.Database.Tables) == 0 {
		return fmt.Errorf("archive contains no database tables")
	}
	seen := make(map[string]struct{}, len(m.Files))
	for _, file := range m.Files {
		if err := validateArchivePath(file.Path); err != nil {
			return err
		}
		if _, dup := seen[file.Path]; dup {
			return fmt.Errorf("manifest lists %s more than once", file.Path)
		}
		seen[file.Path] = struct{}{}
		if len(file.SHA256) != 64 {
			return fmt.Errorf("manifest entry %s has an invalid checksum", file.Path)
		}
	}
	for _, table := range m.Database.Tables {
		if _, ok := seen[table.ArchivePath]; !ok {
			return fmt.Errorf("database table %s has no archived data file", table.Name)
		}
	}
	return nil
}

func encodeManifest(m Manifest) ([]byte, error) {
	payload, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode manifest: %w", err)
	}
	return payload, nil
}

func decodeManifest(payload []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(payload, &m); err != nil {
		return Manifest{}, fmt.Errorf("archive manifest is corrupt: %w", err)
	}
	return m, nil
}

// validateArchivePath rejects absolute paths, traversal, unexpected roots,
// and other unsafe archive member names.
func validateArchivePath(path string) error {
	if path == "" || len(path) > 1024 {
		return fmt.Errorf("archive entry has an invalid name")
	}
	if strings.HasPrefix(path, "/") || strings.Contains(path, "\\") || strings.Contains(path, "\x00") {
		return fmt.Errorf("archive entry %q uses an unsafe path", path)
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("archive entry %q uses an unsafe path", path)
		}
	}
	if path == ManifestPath {
		return nil
	}
	for _, prefix := range []string{databasePrefix, originalsPrefix, variantsPrefix, thumbnailsPrefix, updatesPrefix} {
		if strings.HasPrefix(path, prefix) {
			return nil
		}
	}
	return fmt.Errorf("archive entry %q is outside the expected layout", path)
}
