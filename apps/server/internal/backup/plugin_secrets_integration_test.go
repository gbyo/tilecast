package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

// Encrypted plugin secrets ride in a backup; the keys that protect them
// never do. These tests run the real create, verify, plan, and apply paths.

type secretBackup struct {
	pool      *pgxpool.Pool
	url       string
	ctx       context.Context
	media     string
	updates   string
	backups   string
	orgID     uuid.UUID
	ring      *pluginsecrets.KeyRing
	store     *pluginsecrets.Store
	archive   string
	plaintext string
}

func newSecretBackup(t *testing.T) *secretBackup {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, url)
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
	if err = database.Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users,plugin_secret_deks CASCADE`); err != nil {
		t.Fatal(err)
	}
	b := &secretBackup{pool: pool, url: url, ctx: ctx, orgID: uuid.New(), plaintext: "plugin-token-PLAINTEXT-7731"}
	root := t.TempDir()
	b.media, b.updates, b.backups = filepath.Join(root, "media"), filepath.Join(root, "updates"), filepath.Join(root, "backups")
	for _, dir := range []string{"originals", "variants", "thumbnails"} {
		if err = os.MkdirAll(filepath.Join(b.media, dir), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	for _, dir := range []string{b.updates, b.backups} {
		if err = os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Backup Secrets',$1)`, b.orgID); err != nil {
		t.Fatal(err)
	}
	b.ring, _, err = pluginsecrets.LoadOrCreate(filepath.Join(root, "keys", "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	b.store = pluginsecrets.NewStore(pool, b.ring, nil)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	write := func(plugin, key string, value string) {
		ref := pluginsecrets.SecretRef{PluginID: plugin, OwnerType: pluginsecrets.OwnerOrganization, OwnerID: b.orgID, Key: key}
		if err := b.store.WriteInTx(ctx, tx, ref, value, nil); err != nil {
			t.Fatal(err)
		}
	}
	write("room_sign", "apiToken", b.plaintext)
	write("room_sign", "webhookKey", "second-secret")
	// Ordinary, non-secret plugin configuration that must survive either way.
	if _, err = tx.Exec(ctx, `INSERT INTO plugin_settings(id,organization_id,plugin_id,scope,"values") VALUES($1,$2,'room_sign','organization','{"refreshMinutes":9}')`, uuid.New(), b.orgID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result, err := Create(ctx, CreateOptions{DB: pool, MediaRoot: b.media, UpdatesRoot: b.updates, BackupRoot: b.backups, Kind: KindManual,
		Build: version.CurrentBuild(), Limits: Limits{MaxFiles: 100000, MaxExpandedBytes: 1 << 34}})
	if err != nil {
		t.Fatal(err)
	}
	b.archive = result.Path
	return b
}

func (b *secretBackup) apply(t *testing.T, kekIDs []string, confirm bool) error {
	t.Helper()
	_, err := Apply(b.ctx, ApplyOptions{DB: b.pool, DatabaseURL: b.url, MediaRoot: b.media, UpdatesRoot: b.updates, BackupRoot: b.backups,
		ArchivePath: b.archive, Build: version.CurrentBuild(), Limits: Limits{MaxFiles: 100000, MaxExpandedBytes: 1 << 34},
		SkipPreRestoreBackup: true, AvailableKEKIDs: kekIDs, ConfirmUnreadableSecrets: confirm})
	b.pool.Reset()
	return err
}

func TestBackupCarriesCiphertextAndNeverAKey(t *testing.T) {
	b := newSecretBackup(t)
	manifest, _, err := Inspect(b.ctx, b.archive, Limits{MaxFiles: 100000, MaxExpandedBytes: 1 << 34})
	if err != nil {
		t.Fatal(err)
	}
	kek := b.ring.CurrentID()
	if manifest.PluginSecrets == nil || len(manifest.PluginSecrets.RequiredKEKIDs) != 1 || manifest.PluginSecrets.RequiredKEKIDs[0] != kek {
		t.Fatalf("manifest secrets = %+v", manifest.PluginSecrets)
	}
	if len(manifest.PluginSecrets.Locations) != 2 {
		t.Fatalf("locations = %+v", manifest.PluginSecrets.Locations)
	}
	tables := map[string]bool{}
	for _, table := range manifest.Database.Tables {
		tables[table.Name] = true
	}
	if !tables["plugin_secrets"] || !tables["plugin_secret_deks"] {
		t.Fatal("the archive does not carry the encrypted secrets and wrapped DEKs")
	}
	// Search every byte of the archive, including inside gzipped table dumps,
	// for the key material and the plaintext.
	keyFile, err := os.ReadFile(b.ring.Path())
	if err != nil {
		t.Fatal(err)
	}
	needles := map[string][]byte{"plaintext": []byte(b.plaintext), "key file": keyFile}
	var parsed struct {
		Keys []struct {
			Key string `json:"key"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(keyFile, &parsed); err != nil || len(parsed.Keys) == 0 {
		t.Fatalf("key file: %v", err)
	}
	for index, entry := range parsed.Keys {
		raw, err := base64.StdEncoding.DecodeString(entry.Key)
		if err != nil || len(raw) != 32 {
			t.Fatalf("key %d: %v", index, err)
		}
		needles["raw key"], needles["base64 key"] = raw, []byte(entry.Key)
	}
	archive, err := os.Open(b.archive)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	reader := tar.NewReader(archive)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(header.Name, ".gz") {
			if unzipped, err := gzip.NewReader(bytes.NewReader(content)); err == nil {
				content, _ = io.ReadAll(unzipped)
			}
		}
		for name, needle := range needles {
			if bytes.Contains(content, needle) {
				t.Errorf("%s contains the %s", header.Name, name)
			}
		}
	}
}

func TestRestorePreflightNamesWhatBecomesUnreadableWithoutValues(t *testing.T) {
	b := newSecretBackup(t)
	manifest, _, err := Inspect(b.ctx, b.archive, Limits{MaxFiles: 100000, MaxExpandedBytes: 1 << 34})
	if err != nil {
		t.Fatal(err)
	}
	if check := manifest.CheckSecrets(b.ring.IDs()); check.NeedsConfirmation() || len(check.Unreadable) != 0 {
		t.Fatalf("with the key: %+v", check)
	}
	check := manifest.CheckSecrets([]string{"kek-" + uuid.NewString()})
	if !check.NeedsConfirmation() || len(check.MissingKEKIDs) != 1 || len(check.Unreadable) != 2 {
		t.Fatalf("without the key: %+v", check)
	}
	for _, location := range check.Unreadable {
		if location.PluginID != "room_sign" || location.OwnerType != "organization" || location.Count != 1 {
			t.Fatalf("location = %+v", location)
		}
	}
	// A restore without the key and without confirmation changes nothing.
	err = b.apply(t, []string{"kek-" + uuid.NewString()}, false)
	if !errors.Is(err, ErrUnreadableSecrets) {
		t.Fatalf("an unconfirmed restore = %v", err)
	}
	if strings.Contains(err.Error(), b.plaintext) {
		t.Fatal("the refusal leaks a secret")
	}
}

func TestRestoreWithKeysKeepsSecretsReadable(t *testing.T) {
	b := newSecretBackup(t)
	if err := b.apply(t, b.ring.IDs(), false); err != nil {
		t.Fatal(err)
	}
	// A second installation that holds the exported keys reads the restored secret.
	ref := pluginsecrets.SecretRef{PluginID: "room_sign", OwnerType: pluginsecrets.OwnerOrganization, OwnerID: b.orgID, Key: "apiToken"}
	if value, err := b.store.Read(b.ctx, b.pool, ref); err != nil || value != b.plaintext {
		t.Fatalf("restored secret = %q %v", value, err)
	}
}

func TestRestoreConfirmationIsPresentWhenTheJobIsInserted(t *testing.T) {
	b := newSecretBackup(t)
	if _, err := b.pool.Exec(b.ctx, `TRUNCATE backup_jobs`); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(b.pool, b.backups, NewGuard())
	if err != nil {
		t.Fatal(err)
	}
	archiveID := uuid.New()
	if err := service.RegisterArchive(b.ctx, Archive{
		ID: archiveID, FileName: filepath.Base(b.archive), Kind: KindManual, Status: "complete", Verification: "verified",
	}); err != nil {
		t.Fatal(err)
	}
	// The worker can claim a row as soon as the INSERT commits. Require the
	// flag on that write so setting it in a later UPDATE fails the test.
	if _, err := b.pool.Exec(b.ctx, `ALTER TABLE backup_jobs ADD CONSTRAINT test_restore_confirmation
		CHECK (kind <> 'restore' OR confirm_unreadable_secrets) NOT VALID`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := b.pool.Exec(b.ctx, `ALTER TABLE backup_jobs DROP CONSTRAINT test_restore_confirmation`); err != nil {
			t.Error(err)
		}
		if _, err := b.pool.Exec(b.ctx, `DELETE FROM backup_jobs WHERE archive_id=$1`, archiveID); err != nil {
			t.Error(err)
		}
	})
	if _, err := service.EnqueueRestore(b.ctx, archiveID, nil, false, true); err != nil {
		t.Fatal(err)
	}
}

func TestConfirmedRestoreWithoutKeyLeavesOnlySecretsUnreadable(t *testing.T) {
	b := newSecretBackup(t)
	other, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "other", "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.apply(t, other.IDs(), true); err != nil {
		t.Fatalf("a confirmed restore failed: %v", err)
	}
	// The server starts: the restored installation reads with its own key.
	restored := pluginsecrets.NewStore(b.pool, other, nil)
	ref := pluginsecrets.SecretRef{PluginID: "room_sign", OwnerType: pluginsecrets.OwnerOrganization, OwnerID: b.orgID, Key: "apiToken"}
	if _, err := restored.Read(b.ctx, b.pool, ref); !errors.Is(err, pluginsecrets.ErrUnavailable) {
		t.Fatalf("a secret without its key = %v", err)
	}
	states, err := restored.States(b.ctx, b.pool, "room_sign", pluginsecrets.OwnerOrganization, b.orgID, []string{"apiToken", "webhookKey"})
	if err != nil || states["apiToken"] != pluginsecrets.StateNeedsValue || states["webhookKey"] != pluginsecrets.StateNeedsValue {
		t.Fatalf("states = %v %v", states, err)
	}
	// Unrelated restored configuration still works.
	var refresh float64
	if err := b.pool.QueryRow(b.ctx, `SELECT ("values"->>'refreshMinutes')::float FROM plugin_settings WHERE plugin_id='room_sign'`).Scan(&refresh); err != nil || refresh != 9 {
		t.Fatalf("unrelated setting = %v %v", refresh, err)
	}
	// Entering the value again works with the restored installation's own key.
	tx, err := b.pool.Begin(b.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := restored.WriteInTx(b.ctx, tx, ref, "entered again", nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(b.ctx); err != nil {
		t.Fatal(err)
	}
	if value, err := restored.Read(b.ctx, b.pool, ref); err != nil || value != "entered again" {
		t.Fatalf("re-entered = %q %v", value, err)
	}
	// The untouched secret stays unavailable and does not affect it.
	if _, err := restored.Read(b.ctx, b.pool, pluginsecrets.SecretRef{PluginID: "room_sign", OwnerType: pluginsecrets.OwnerOrganization, OwnerID: b.orgID, Key: "webhookKey"}); !errors.Is(err, pluginsecrets.ErrUnavailable) {
		t.Fatalf("the other secret = %v", err)
	}
}
