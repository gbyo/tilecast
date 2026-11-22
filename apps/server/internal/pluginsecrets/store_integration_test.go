package pluginsecrets

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type storeEnv struct {
	ctx   context.Context
	pool  *pgxpool.Pool
	store *Store
	ring  *KeyRing
	dir   string
}

func withStore(t *testing.T) storeEnv {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DELETE FROM plugin_secrets; DELETE FROM plugin_secret_deks; DELETE FROM plugin_secret_kek_exports`); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ring, _, err := LoadOrCreate(filepath.Join(dir, "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	return storeEnv{ctx: ctx, pool: pool, store: NewStore(pool, ring, nil), ring: ring, dir: dir}
}

func (env storeEnv) write(t *testing.T, ref SecretRef, value string) {
	t.Helper()
	tx, err := env.pool.Begin(env.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(env.ctx) //nolint:errcheck
	if err := env.store.WriteInTx(env.ctx, tx, ref, value, nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(env.ctx); err != nil {
		t.Fatal(err)
	}
}

func orgRef(key string) SecretRef {
	return SecretRef{PluginID: "room_sign", OwnerType: OwnerOrganization, OwnerID: uuid.MustParse("00000000-0000-4000-8000-000000000001"), Key: key}
}

func TestStoreWritesReadsAndReportsStateOnly(t *testing.T) {
	env := withStore(t)
	ref := orgRef("apiToken")
	if _, err := env.store.Read(env.ctx, env.pool, ref); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unset secret: %v", err)
	}
	env.write(t, ref, "token-one")
	value, err := env.store.Read(env.ctx, env.pool, ref)
	if err != nil || value != "token-one" {
		t.Fatalf("read: %q %v", value, err)
	}
	states, err := env.store.States(env.ctx, env.pool, ref.PluginID, ref.OwnerType, ref.OwnerID, []string{"apiToken", "other"})
	if err != nil || states["apiToken"] != StateSet || states["other"] != StateNotSet {
		t.Fatalf("states: %v %v", states, err)
	}
	var stored []byte
	if err := env.pool.QueryRow(env.ctx, `SELECT envelope FROM plugin_secrets`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("token-one")) {
		t.Fatal("the database holds plaintext")
	}
	// A ciphertext copied to another setting does not decrypt.
	if _, err := env.pool.Exec(env.ctx, `INSERT INTO plugin_secrets(plugin_id,owner_type,owner_id,setting_key,dek_id,envelope)
		SELECT plugin_id,owner_type,owner_id,'stolen',dek_id,envelope FROM plugin_secrets WHERE setting_key='apiToken'`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.store.Read(env.ctx, env.pool, orgRef("stolen")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a copied ciphertext decrypted: %v", err)
	}
}

func TestKEKRotationRewrapsDEKsWithoutRewritingSecrets(t *testing.T) {
	env := withStore(t)
	env.write(t, orgRef("a"), "alpha")
	env.write(t, orgRef("b"), "beta")
	var before [][]byte
	rows, _ := env.pool.Query(env.ctx, `SELECT envelope FROM plugin_secrets ORDER BY setting_key`)
	for rows.Next() {
		var envelope []byte
		_ = rows.Scan(&envelope)
		before = append(before, envelope)
	}
	rows.Close()
	oldKEK := env.ring.CurrentID()
	if _, err := env.ring.AddKEK(); err != nil {
		t.Fatal(err)
	}
	inUse, err := env.store.KEKsInUse(env.ctx, env.pool)
	if err != nil || !inUse[oldKEK] {
		t.Fatalf("the old KEK is still needed: %v %v", inUse, err)
	}
	rewrapped, missing, err := env.store.RewrapDEKs(env.ctx)
	if err != nil || rewrapped != 1 || len(missing) != 0 {
		t.Fatalf("rewrap: %d %v %v", rewrapped, missing, err)
	}
	// A second run has nothing to do: the rotation is idempotent.
	if again, _, err := env.store.RewrapDEKs(env.ctx); err != nil || again != 0 {
		t.Fatalf("second rewrap: %d %v", again, err)
	}
	var after [][]byte
	rows, _ = env.pool.Query(env.ctx, `SELECT envelope FROM plugin_secrets ORDER BY setting_key`)
	for rows.Next() {
		var envelope []byte
		_ = rows.Scan(&envelope)
		after = append(after, envelope)
	}
	rows.Close()
	for index := range before {
		if !bytes.Equal(before[index], after[index]) {
			t.Fatal("KEK rotation rewrote a secret")
		}
	}
	inUse, _ = env.store.KEKsInUse(env.ctx, env.pool)
	if inUse[oldKEK] {
		t.Fatal("a DEK still uses the old KEK after rewrap")
	}
	// A fresh process that has only the new KEK reads every secret.
	ring, err := Load(env.ring.Path())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ring.Prune(inUse); err != nil {
		t.Fatal(err)
	}
	fresh := NewStore(env.pool, ring, nil)
	for key, want := range map[string]string{"a": "alpha", "b": "beta"} {
		if got, err := fresh.Read(env.ctx, env.pool, orgRef(key)); err != nil || got != want {
			t.Fatalf("read %s after rotation: %q %v", key, got, err)
		}
	}
}

func TestDEKRotationMigratesInResumableBatches(t *testing.T) {
	env := withStore(t)
	for _, key := range []string{"a", "b", "c", "d", "e"} {
		env.write(t, orgRef(key), "value-"+key)
	}
	var oldDEK uuid.UUID
	if err := env.pool.QueryRow(env.ctx, `SELECT id FROM plugin_secret_deks WHERE state='current'`).Scan(&oldDEK); err != nil {
		t.Fatal(err)
	}
	newDEK, err := env.store.RotateDEK(env.ctx)
	if err != nil || newDEK == oldDEK {
		t.Fatalf("rotate: %v", err)
	}
	// New writes use the new DEK at once.
	env.write(t, orgRef("f"), "value-f")
	var dekForNew uuid.UUID
	_ = env.pool.QueryRow(env.ctx, `SELECT dek_id FROM plugin_secrets WHERE setting_key='f'`).Scan(&dekForNew)
	if dekForNew != newDEK {
		t.Fatal("a new write used the old DEK")
	}
	// One small batch, as if the process stopped after it.
	moved, cursor, done, err := env.store.MigrateBatch(env.ctx, MigrationCursor{}, 2)
	if err != nil || moved != 2 || done {
		t.Fatalf("first batch: %d %v %v", moved, done, err)
	}
	// Old and new secrets stay readable halfway through.
	for _, key := range []string{"a", "c", "e", "f"} {
		if got, err := env.store.Read(env.ctx, env.pool, orgRef(key)); err != nil || got != "value-"+key {
			t.Fatalf("read %s during migration: %q %v", key, got, err)
		}
	}
	// A restarted worker starts from the beginning and finishes.
	_ = cursor
	total, err := env.store.MigrateAll(env.ctx, 2)
	if err != nil || total != 3 {
		t.Fatalf("resume: %d %v", total, err)
	}
	var remaining int
	_ = env.pool.QueryRow(env.ctx, `SELECT count(*) FROM plugin_secrets WHERE dek_id<>$1`, newDEK).Scan(&remaining)
	var oldState string
	_ = env.pool.QueryRow(env.ctx, `SELECT state FROM plugin_secret_deks WHERE id=$1`, oldDEK).Scan(&oldState)
	if remaining != 0 || oldState != "retired" {
		t.Fatalf("after migration: %d on old DEKs, old DEK %s", remaining, oldState)
	}
}

func TestMissingKEKReportsNeedsValueAndStartsANewDEK(t *testing.T) {
	env := withStore(t)
	env.write(t, orgRef("token"), "before restore")
	// Another installation with its own key file reads the same database,
	// as after a restore without the original KEK.
	other, _, err := LoadOrCreate(filepath.Join(env.dir, "other.json"))
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(env.pool, other, nil)
	if _, err := store.Read(env.ctx, env.pool, orgRef("token")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unreadable secret: %v", err)
	}
	states, err := store.States(env.ctx, env.pool, "room_sign", OwnerOrganization, orgRef("token").OwnerID, []string{"token"})
	if err != nil || states["token"] != StateNeedsValue {
		t.Fatalf("state: %v %v", states, err)
	}
	// Entering the value again works: the store starts a DEK it can use.
	tx, err := env.pool.Begin(env.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WriteInTx(env.ctx, tx, orgRef("token"), "after restore", nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(env.ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Read(env.ctx, env.pool, orgRef("token")); err != nil || got != "after restore" {
		t.Fatalf("re-entered value: %q %v", got, err)
	}
	locations, err := Locations(env.ctx, env.pool)
	if err != nil || len(locations) != 1 || locations[0].KEKID != other.CurrentID() {
		t.Fatalf("locations: %+v %v", locations, err)
	}
}
