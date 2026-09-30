package backup

import (
	"strings"
	"testing"
	"time"
)

func TestManifestBuildIdentityRoundTrip(t *testing.T) {
	manifest := Manifest{
		FormatVersion:    FormatVersion,
		TilecastVersion:  "0.11.0",
		ServerChannel:    "stable",
		BuildCommit:      "abc123",
		BuildDate:        "2026-09-29T00:00:00Z",
		SchemaVersion:    1,
		InstallationID:   "install-1",
		OrganizationName: "Test",
		CreatedAt:        time.Now().UTC(),
		Components: []ManifestComponent{
			{Name: ComponentDatabase},
			{Name: ComponentMediaOriginals},
			{Name: ComponentMediaVariants},
			{Name: ComponentMediaThumbnails},
			{Name: ComponentPlayerUpdates},
		},
		Database: DatabaseManifest{Tables: []TableDump{{Name: "users", ArchivePath: "db/users.csv"}}},
		Files:    []ManifestFile{{Path: "db/users.csv", SHA256: strings.Repeat("a", 64)}},
	}
	payload, err := encodeManifest(manifest)
	if err != nil {
		t.Fatalf("encode manifest: %v", err)
	}
	decoded, err := decodeManifest(payload)
	if err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if decoded.ServerChannel != "stable" || decoded.BuildCommit != "abc123" || decoded.BuildDate != "2026-09-29T00:00:00Z" {
		t.Fatalf("build identity did not survive the round trip: %+v", decoded)
	}
	if err := decoded.Validate(); err != nil {
		t.Fatalf("manifest with build identity is invalid: %v", err)
	}
}

func TestLegacyManifestWithoutBuildIdentityRemainsValid(t *testing.T) {
	// Archives written before build identity existed carry no new fields.
	payload := `{"formatVersion":1,"tilecastVersion":"0.10.0","schemaVersion":1,` +
		`"installationId":"install-1","organizationName":"Test","createdAt":"2026-01-01T00:00:00Z",` +
		`"components":[{"name":"database"},{"name":"media_originals"},{"name":"media_variants"},` +
		`{"name":"media_thumbnails"},{"name":"player_updates"}],` +
		`"database":{"tables":[{"name":"users","rows":1,"archivePath":"db/users.csv"}],"sequences":[]},` +
		`"files":[{"path":"db/users.csv","sizeBytes":1,"sha256":"` + strings.Repeat("b", 64) + `"}]}`
	manifest, err := decodeManifest([]byte(payload))
	if err != nil {
		t.Fatalf("decode legacy manifest: %v", err)
	}
	if manifest.ServerChannel != "" || manifest.BuildCommit != "" || manifest.BuildDate != "" {
		t.Fatalf("legacy manifest should decode with empty build identity: %+v", manifest)
	}
	if err := manifest.Validate(); err != nil {
		t.Fatalf("legacy manifest is invalid: %v", err)
	}
}
