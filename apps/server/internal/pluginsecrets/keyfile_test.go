package pluginsecrets

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestKeyFileCreatedOnceWithOwnerOnlyMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets", "kek.json")
	ring, created, err := LoadOrCreate(path)
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode %v", info.Mode().Perm())
	}
	again, created, err := LoadOrCreate(path)
	if err != nil || created || again.CurrentID() != ring.CurrentID() {
		t.Fatalf("second start replaced the key: %v %v", created, err)
	}
	key, _ := ring.key(ring.CurrentID())
	if len(key) != 32 {
		t.Fatalf("KEK is %d bytes", len(key))
	}
}

func TestKeyFileRejectsInsecureAndMalformedFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "kek.json")
	if _, _, err := LoadOrCreate(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); !errors.Is(err, ErrKeyFileInsecure) {
		t.Fatalf("world-readable key file: %v", err)
	}
	for name, content := range map[string]string{
		"not json":        "not json",
		"wrong format":    `{"format":"other","version":1,"current":"x","keys":[]}`,
		"short key":       `{"format":"tilecast-secret-keys","version":1,"current":"kek-` + uuid.NewString() + `","keys":[{"id":"kek-` + uuid.NewString() + `","createdAt":"2026-01-01T00:00:00Z","key":"c2hvcnQ="}]}`,
		"missing current": `{"format":"tilecast-secret-keys","version":1,"current":"kek-` + uuid.NewString() + `","keys":[]}`,
		"unknown member":  `{"format":"tilecast-secret-keys","version":1,"current":"x","keys":[],"extra":1}`,
	} {
		bad := filepath.Join(dir, strings.ReplaceAll(name, " ", "-")+".json")
		if err := os.WriteFile(bad, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := Load(bad)
		if !errors.Is(err, ErrKeyFileInvalid) {
			t.Errorf("%s: %v", name, err)
		}
		if err != nil && strings.Contains(err.Error(), "c2hvcnQ") {
			t.Errorf("%s: error repeats key material", name)
		}
		// A key file that exists but is unusable is never replaced.
		if _, _, err := LoadOrCreate(bad); err == nil {
			t.Errorf("%s: an unusable key file was replaced", name)
		}
	}
	if _, err := Load(filepath.Join(dir, "absent.json")); !errors.Is(err, ErrKeyFileMissing) {
		t.Fatalf("missing key file: %v", err)
	}
}

func TestRotationKeepsOldKeysUntilPruned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kek.json")
	ring, _, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	first := ring.CurrentID()
	second, err := ring.AddKEK()
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.CurrentID() != second.ID || !reloaded.Has(first) {
		t.Fatalf("rotation lost a key: %v", reloaded.IDs())
	}
	removed, err := ring.Prune(map[string]bool{first: true})
	if err != nil || len(removed) != 0 {
		t.Fatalf("pruned a key in use: %v %v", removed, err)
	}
	removed, err = ring.Prune(map[string]bool{})
	if err != nil || len(removed) != 1 || removed[0] != first {
		t.Fatalf("prune: %v %v", removed, err)
	}
	if ring.Has(first) || !ring.Has(second.ID) {
		t.Fatal("prune removed the wrong key")
	}
}

func TestExportIsSeparateAndRefusesOverwriteAndBackupRoots(t *testing.T) {
	dir := t.TempDir()
	ring, _, err := LoadOrCreate(filepath.Join(dir, "data", "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	backups := filepath.Join(dir, "backups")
	if err := os.MkdirAll(backups, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ring.Export(filepath.Join(backups, "keys.json"), []string{backups}); err == nil {
		t.Fatal("export inside the backup root was accepted")
	}
	export := filepath.Join(dir, "offline", "keys.json")
	if err := os.MkdirAll(filepath.Dir(export), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ring.Export(export, []string{backups}); err != nil {
		t.Fatal(err)
	}
	if err := ring.Export(export, nil); !errors.Is(err, ErrExportExists) {
		t.Fatalf("export overwrote a file: %v", err)
	}
	exported, err := Load(export)
	if err != nil || exported.CurrentID() != ring.CurrentID() {
		t.Fatalf("export is not a usable key file: %v", err)
	}
	// A new installation imports the export to read restored secrets.
	other, _, err := LoadOrCreate(filepath.Join(dir, "other", "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	added, err := other.Import(export)
	if err != nil || len(added) != 1 || !other.Has(ring.CurrentID()) {
		t.Fatalf("import: %v %v", added, err)
	}
	if err := CheckKeyFileLocation(filepath.Join(backups, "kek.json"), map[string]string{"TILECAST_BACKUP_ROOT": backups}); err == nil {
		t.Fatal("a key file inside the backup root was accepted")
	}
}

func TestEnvelopeBindsPluginOwnerAndKey(t *testing.T) {
	dek, err := newDEK()
	if err != nil {
		t.Fatal(err)
	}
	ref := SecretRef{PluginID: "room_sign", OwnerType: OwnerOrganization, OwnerID: uuid.New(), Key: "apiToken"}
	sealed, err := sealSecret(dek, ref, "s3cret value")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("s3cret")) {
		t.Fatal("ciphertext contains the plaintext")
	}
	value, err := openSecret(dek, ref, sealed)
	if err != nil || value != "s3cret value" {
		t.Fatalf("round trip: %q %v", value, err)
	}
	moved := []SecretRef{
		{PluginID: "other_plugin", OwnerType: ref.OwnerType, OwnerID: ref.OwnerID, Key: ref.Key},
		{PluginID: ref.PluginID, OwnerType: OwnerScreen, OwnerID: ref.OwnerID, Key: ref.Key},
		{PluginID: ref.PluginID, OwnerType: ref.OwnerType, OwnerID: uuid.New(), Key: ref.Key},
		{PluginID: ref.PluginID, OwnerType: ref.OwnerType, OwnerID: ref.OwnerID, Key: "otherKey"},
	}
	for _, other := range moved {
		if _, err := openSecret(dek, other, sealed); err == nil {
			t.Errorf("ciphertext moved to %s still decrypts", other)
		}
	}
	again, err := sealSecret(dek, ref, "s3cret value")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(again[1:13], sealed[1:13]) || bytes.Equal(again, sealed) {
		t.Fatal("two writes of one value reused a nonce")
	}
	wrongKey, _ := newDEK()
	if _, err := openSecret(wrongKey, ref, sealed); err == nil {
		t.Fatal("a different DEK opened the secret")
	}
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 1
	if _, err := openSecret(dek, ref, tampered); err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Fatal("a tampered envelope opened or leaked")
	}
}

func TestDEKWrapBindsKEKAndDEKIDs(t *testing.T) {
	kek, _ := newDEK()
	dek, _ := newDEK()
	id := uuid.New()
	wrapped, err := wrapDEK(kek, "kek-a", id, dek)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := unwrapDEK(kek, "kek-a", id, wrapped); err != nil || !bytes.Equal(got, dek) {
		t.Fatalf("unwrap: %v", err)
	}
	if _, err := unwrapDEK(kek, "kek-b", id, wrapped); err == nil {
		t.Fatal("a DEK unwrapped under another KEK ID")
	}
	if _, err := unwrapDEK(kek, "kek-a", uuid.New(), wrapped); err == nil {
		t.Fatal("a wrapped DEK moved to another DEK ID")
	}
}
