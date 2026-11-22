package pluginsecrets

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrUnavailable means a secret cannot be returned: it was never set, it
// was cleared, or this installation cannot decrypt it (for example after a
// restore without the KEK that protected it). Callers report it as
// secret_unavailable, and Studio asks for a new value.
var ErrUnavailable = errors.New("the secret is unavailable; enter it again")

// State is what Studio may know about a secret.
type State string

const (
	StateSet        State = "set"
	StateNotSet     State = "not_set"
	StateNeedsValue State = "needs_value"
)

// Querier is the read side of a pool or a transaction.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Store reads and writes plugin secrets.
type Store struct {
	db     *pgxpool.Pool
	logger *slog.Logger

	mu   sync.Mutex
	ring *KeyRing
	deks map[uuid.UUID][]byte
}

// maxCachedDEKs bounds the plaintext DEKs held in memory.
const maxCachedDEKs = 64

// NewStore builds a store over the key ring.
func NewStore(db *pgxpool.Pool, ring *KeyRing, logger *slog.Logger) *Store {
	if logger == nil {
		logger = slog.Default()
	}
	return &Store{db: db, ring: ring, logger: logger, deks: map[uuid.UUID][]byte{}}
}

// Ring returns the key ring. Callers must not keep key material.
func (s *Store) Ring() *KeyRing {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ring
}

func (s *Store) kek(id string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if key, ok := s.ring.key(id); ok {
		return key, true
	}
	// Another process may have rotated the KEK since this one started.
	if err := s.ring.Reload(); err != nil {
		s.logger.Warn("secrets key file could not be reloaded", "error", err)
		return nil, false
	}
	return s.ring.key(id)
}

func (s *Store) currentKEK() (string, []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.ring.CurrentID()
	key, _ := s.ring.key(id)
	return id, key
}

// dek returns a plaintext DEK, or false when no available KEK opens it.
func (s *Store) dek(id uuid.UUID, kekID string, wrapped []byte) ([]byte, bool) {
	s.mu.Lock()
	cached, ok := s.deks[id]
	s.mu.Unlock()
	if ok {
		return cached, true
	}
	kek, ok := s.kek(kekID)
	if !ok {
		return nil, false
	}
	plain, err := unwrapDEK(kek, kekID, id, wrapped)
	if err != nil {
		return nil, false
	}
	s.mu.Lock()
	if len(s.deks) >= maxCachedDEKs {
		for key := range s.deks {
			delete(s.deks, key)
			break
		}
	}
	s.deks[id] = plain
	s.mu.Unlock()
	return plain, true
}

// lockDEKs serializes DEK creation and rotation across processes.
func lockDEKs(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.plugin_secret_deks'))`)
	return err
}

// currentDEKInTx returns the DEK for new writes. When there is none, or the
// current one is wrapped with a KEK this installation does not hold (after a
// restore without that KEK), it makes a new current DEK under the current
// KEK. The old DEK stays active for the secrets it still protects.
func (s *Store) currentDEKInTx(ctx context.Context, tx pgx.Tx) (uuid.UUID, []byte, error) {
	var id uuid.UUID
	var kekID string
	var wrapped []byte
	err := tx.QueryRow(ctx, `SELECT id,kek_id,wrapped_key FROM plugin_secret_deks WHERE state='current'`).Scan(&id, &kekID, &wrapped)
	if err == nil {
		if plain, ok := s.dek(id, kekID, wrapped); ok {
			return id, plain, nil
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil, err
	}
	if err := lockDEKs(ctx, tx); err != nil {
		return uuid.Nil, nil, err
	}
	// Another transaction may have replaced it while this one waited.
	err = tx.QueryRow(ctx, `SELECT id,kek_id,wrapped_key FROM plugin_secret_deks WHERE state='current'`).Scan(&id, &kekID, &wrapped)
	if err == nil {
		if plain, ok := s.dek(id, kekID, wrapped); ok {
			return id, plain, nil
		}
		s.logger.Warn("the current plugin secret DEK is wrapped with a KEK this installation does not hold; starting a new DEK", "kek_id", kekID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil, err
	}
	return s.newCurrentDEKInTx(ctx, tx)
}

func (s *Store) newCurrentDEKInTx(ctx context.Context, tx pgx.Tx) (uuid.UUID, []byte, error) {
	kekID, kek := s.currentKEK()
	if kek == nil {
		return uuid.Nil, nil, errors.New("the secrets key file has no current KEK")
	}
	plain, err := newDEK()
	if err != nil {
		return uuid.Nil, nil, err
	}
	id := uuid.New()
	wrapped, err := wrapDEK(kek, kekID, id, plain)
	if err != nil {
		return uuid.Nil, nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE plugin_secret_deks SET state='active' WHERE state='current'`); err != nil {
		return uuid.Nil, nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO plugin_secret_deks(id,kek_id,wrapped_key,state) VALUES($1,$2,$3,'current')`, id, kekID, wrapped); err != nil {
		return uuid.Nil, nil, err
	}
	s.mu.Lock()
	s.deks[id] = plain
	s.mu.Unlock()
	return id, plain, nil
}

// WriteInTx stores a secret value, replacing any earlier one. The caller
// has validated the value and authorized the write.
func (s *Store) WriteInTx(ctx context.Context, tx pgx.Tx, ref SecretRef, value string, userID *uuid.UUID) error {
	if err := ref.validate(); err != nil {
		return err
	}
	dekID, dek, err := s.currentDEKInTx(ctx, tx)
	if err != nil {
		return err
	}
	envelope, err := sealSecret(dek, ref, value)
	if err != nil {
		return err
	}
	instanceID, screenID := ownerColumns(ref)
	_, err = tx.Exec(ctx, `INSERT INTO plugin_secrets(plugin_id,owner_type,owner_id,setting_key,instance_id,screen_id,dek_id,envelope,updated_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (plugin_id,owner_type,owner_id,setting_key) DO UPDATE
		SET dek_id=EXCLUDED.dek_id,envelope=EXCLUDED.envelope,updated_by=EXCLUDED.updated_by,updated_at=now()`,
		ref.PluginID, ref.OwnerType, ref.OwnerID, ref.Key, instanceID, screenID, dekID, envelope, userID)
	return err
}

func ownerColumns(ref SecretRef) (instanceID, screenID *uuid.UUID) {
	id := ref.OwnerID
	switch ref.OwnerType {
	case OwnerInstance:
		return &id, nil
	case OwnerScreen:
		return nil, &id
	}
	return nil, nil
}

// DeleteInTx removes a secret. It reports whether one existed.
func (s *Store) DeleteInTx(ctx context.Context, tx pgx.Tx, ref SecretRef) (bool, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM plugin_secrets WHERE plugin_id=$1 AND owner_type=$2 AND owner_id=$3 AND setting_key=$4`,
		ref.PluginID, ref.OwnerType, ref.OwnerID, ref.Key)
	return tag.RowsAffected() > 0, err
}

// Read returns a secret value or ErrUnavailable.
func (s *Store) Read(ctx context.Context, q Querier, ref SecretRef) (string, error) {
	if err := ref.validate(); err != nil {
		return "", err
	}
	var dekID uuid.UUID
	var kekID string
	var wrapped, envelope []byte
	err := q.QueryRow(ctx, `SELECT d.id,d.kek_id,d.wrapped_key,s.envelope FROM plugin_secrets s JOIN plugin_secret_deks d ON d.id=s.dek_id
		WHERE s.plugin_id=$1 AND s.owner_type=$2 AND s.owner_id=$3 AND s.setting_key=$4`,
		ref.PluginID, ref.OwnerType, ref.OwnerID, ref.Key).Scan(&dekID, &kekID, &wrapped, &envelope)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnavailable
	}
	if err != nil {
		return "", err
	}
	dek, ok := s.dek(dekID, kekID, wrapped)
	if !ok {
		return "", ErrUnavailable
	}
	value, err := openSecret(dek, ref, envelope)
	if err != nil {
		return "", ErrUnavailable
	}
	return value, nil
}

// States reports, for each key, whether the owner's secret is set, not set,
// or stored but unreadable here. It never returns a value.
func (s *Store) States(ctx context.Context, q Querier, pluginID, ownerType string, ownerID uuid.UUID, keys []string) (map[string]State, error) {
	out := make(map[string]State, len(keys))
	for _, key := range keys {
		out[key] = StateNotSet
	}
	if len(keys) == 0 || ownerID == uuid.Nil {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT s.setting_key,d.id,d.kek_id,d.wrapped_key FROM plugin_secrets s JOIN plugin_secret_deks d ON d.id=s.dek_id
		WHERE s.plugin_id=$1 AND s.owner_type=$2 AND s.owner_id=$3 AND s.setting_key=ANY($4)`, pluginID, ownerType, ownerID, keys)
	if err != nil {
		return nil, err
	}
	type found struct {
		key     string
		dekID   uuid.UUID
		kekID   string
		wrapped []byte
	}
	list := []found{}
	for rows.Next() {
		var item found
		if err := rows.Scan(&item.key, &item.dekID, &item.kekID, &item.wrapped); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, item := range list {
		if _, ok := s.dek(item.dekID, item.kekID, item.wrapped); ok {
			out[item.key] = StateSet
		} else {
			out[item.key] = StateNeedsValue
		}
	}
	return out, nil
}

// RotateDEK makes a new current DEK. The secrets under older DEKs stay
// readable; MigrateBatch moves them to the new DEK in bounded batches.
func (s *Store) RotateDEK(ctx context.Context) (uuid.UUID, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := lockDEKs(ctx, tx); err != nil {
		return uuid.Nil, err
	}
	id, _, err := s.newCurrentDEKInTx(ctx, tx)
	if err != nil {
		return uuid.Nil, err
	}
	return id, tx.Commit(ctx)
}

// MigrationCursor is a position in the secret table for MigrateBatch.
type MigrationCursor struct {
	PluginID  string
	OwnerType string
	OwnerID   uuid.UUID
	Key       string
}

// MigrateBatch moves at most limit secrets that are not under the current
// DEK to it, each in a short transaction, starting after the cursor. It
// returns how many it moved and the cursor for the next call; done is true
// when no secret after the cursor remains. A secret this installation cannot
// decrypt is left where it is and skipped. When nothing is left on a DEK,
// the DEK is retired. The work is resumable: an interrupted batch leaves
// every secret either on its old DEK or on the new one.
func (s *Store) MigrateBatch(ctx context.Context, after MigrationCursor, limit int) (int, MigrationCursor, bool, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(ctx, `SELECT s.plugin_id,s.owner_type,s.owner_id,s.setting_key FROM plugin_secrets s
		JOIN plugin_secret_deks d ON d.id=s.dek_id
		WHERE d.state<>'current' AND (s.plugin_id,s.owner_type,s.owner_id,s.setting_key) > ($1,$2,$3,$4)
		ORDER BY s.plugin_id,s.owner_type,s.owner_id,s.setting_key LIMIT $5`,
		after.PluginID, after.OwnerType, after.OwnerID, after.Key, limit)
	if err != nil {
		return 0, after, false, err
	}
	refs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (SecretRef, error) {
		var ref SecretRef
		err := row.Scan(&ref.PluginID, &ref.OwnerType, &ref.OwnerID, &ref.Key)
		return ref, err
	})
	if err != nil {
		return 0, after, false, err
	}
	moved := 0
	for _, ref := range refs {
		ok, err := s.migrateOne(ctx, ref)
		if err != nil {
			return moved, after, false, err
		}
		if ok {
			moved++
		}
		after = MigrationCursor{PluginID: ref.PluginID, OwnerType: ref.OwnerType, OwnerID: ref.OwnerID, Key: ref.Key}
	}
	if _, err := s.db.Exec(ctx, `UPDATE plugin_secret_deks d SET state='retired',retired_at=now()
		WHERE d.state='active' AND NOT EXISTS(SELECT 1 FROM plugin_secrets s WHERE s.dek_id=d.id)`); err != nil {
		return moved, after, false, err
	}
	return moved, after, len(refs) < limit, nil
}

func (s *Store) migrateOne(ctx context.Context, ref SecretRef) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var dekID uuid.UUID
	var kekID, state string
	var wrapped, envelope []byte
	err = tx.QueryRow(ctx, `SELECT d.id,d.kek_id,d.wrapped_key,d.state,s.envelope FROM plugin_secrets s JOIN plugin_secret_deks d ON d.id=s.dek_id
		WHERE s.plugin_id=$1 AND s.owner_type=$2 AND s.owner_id=$3 AND s.setting_key=$4 FOR UPDATE OF s`,
		ref.PluginID, ref.OwnerType, ref.OwnerID, ref.Key).Scan(&dekID, &kekID, &wrapped, &state, &envelope)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && state == "current" {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	old, ok := s.dek(dekID, kekID, wrapped)
	if !ok {
		return false, nil
	}
	value, err := openSecret(old, ref, envelope)
	if err != nil {
		return false, nil
	}
	newID, newDEK, err := s.currentDEKInTx(ctx, tx)
	if err != nil {
		return false, err
	}
	sealed, err := sealSecret(newDEK, ref, value)
	if err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE plugin_secrets SET dek_id=$5,envelope=$6 WHERE plugin_id=$1 AND owner_type=$2 AND owner_id=$3 AND setting_key=$4`,
		ref.PluginID, ref.OwnerType, ref.OwnerID, ref.Key, newID, sealed); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// MigrateAll runs MigrateBatch until one pass over the table completes.
func (s *Store) MigrateAll(ctx context.Context, batch int) (int, error) {
	total := 0
	cursor := MigrationCursor{}
	for {
		moved, next, done, err := s.MigrateBatch(ctx, cursor, batch)
		total += moved
		if err != nil || done {
			return total, err
		}
		cursor = next
	}
}

// RewrapDEKs wraps every DEK that is not under the current KEK with the
// current KEK. Secrets are not touched. Each DEK changes in its own compare
// and swap, so a run that stops halfway can run again.
func (s *Store) RewrapDEKs(ctx context.Context) (int, []string, error) {
	rows, err := s.db.Query(ctx, `SELECT id,kek_id,wrapped_key FROM plugin_secret_deks ORDER BY created_at,id`)
	if err != nil {
		return 0, nil, err
	}
	type dekRow struct {
		id      uuid.UUID
		kekID   string
		wrapped []byte
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (dekRow, error) {
		var item dekRow
		err := row.Scan(&item.id, &item.kekID, &item.wrapped)
		return item, err
	})
	if err != nil {
		return 0, nil, err
	}
	currentID, current := s.currentKEK()
	rewrapped := 0
	missing := map[string]bool{}
	for _, item := range list {
		if item.kekID == currentID {
			continue
		}
		plain, ok := s.dek(item.id, item.kekID, item.wrapped)
		if !ok {
			missing[item.kekID] = true
			continue
		}
		wrapped, err := wrapDEK(current, currentID, item.id, plain)
		if err != nil {
			return rewrapped, nil, err
		}
		tag, err := s.db.Exec(ctx, `UPDATE plugin_secret_deks SET kek_id=$2,wrapped_key=$3,rewrapped_at=now() WHERE id=$1 AND kek_id=$4`,
			item.id, currentID, wrapped, item.kekID)
		if err != nil {
			return rewrapped, nil, err
		}
		rewrapped += int(tag.RowsAffected())
	}
	ids := make([]string, 0, len(missing))
	for id := range missing {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return rewrapped, ids, nil
}

// KEKsInUse lists the KEK IDs that some stored DEK is wrapped with.
func (s *Store) KEKsInUse(ctx context.Context, q Querier) (map[string]bool, error) {
	rows, err := q.Query(ctx, `SELECT DISTINCT kek_id FROM plugin_secret_deks`)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// SecretLocation groups stored secrets for a restore check: one plugin
// setting, its owner type, the KEK that protects it, and how many owners
// hold it. It never names a value.
type SecretLocation struct {
	PluginID  string `json:"pluginId"`
	OwnerType string `json:"ownerType"`
	Key       string `json:"settingKey"`
	KEKID     string `json:"kekId"`
	Count     int    `json:"count"`
}

// Locations lists every stored secret grouped by plugin, owner type,
// setting key, and KEK.
func Locations(ctx context.Context, q Querier) ([]SecretLocation, error) {
	rows, err := q.Query(ctx, `SELECT s.plugin_id,s.owner_type,s.setting_key,d.kek_id,count(*) FROM plugin_secrets s
		JOIN plugin_secret_deks d ON d.id=s.dek_id GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (SecretLocation, error) {
		var item SecretLocation
		err := row.Scan(&item.PluginID, &item.OwnerType, &item.Key, &item.KEKID, &item.Count)
		return item, err
	})
}

// KEKSetID is the stable name of a set of KEK IDs, used for the export
// confirmation.
func KEKSetID(ids []string) string {
	sorted := append([]string(nil), ids...)
	sort.Strings(sorted)
	return strings.Join(sorted, ",")
}

// ExportAcknowledged reports whether an Owner confirmed exporting exactly
// the current KEK set.
func (s *Store) ExportAcknowledged(ctx context.Context) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plugin_secret_kek_exports WHERE kek_ids=$1)`, KEKSetID(s.Ring().IDs())).Scan(&exists)
	return exists, err
}

// AcknowledgeExport records an Owner's confirmation for the current KEK set.
func (s *Store) AcknowledgeExport(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO plugin_secret_kek_exports(kek_ids,acknowledged_by) VALUES($1,$2)
		ON CONFLICT (kek_ids) DO UPDATE SET acknowledged_by=EXCLUDED.acknowledged_by,acknowledged_at=now()`, KEKSetID(s.Ring().IDs()), userID)
	return err
}

// Status summarizes the secret store for operators without naming keys.
type Status struct {
	CurrentKEKID       string   `json:"currentKekId"`
	KEKIDs             []string `json:"kekIds"`
	ExportAcknowledged bool     `json:"exportAcknowledged"`
	Secrets            int      `json:"secrets"`
	PendingMigration   int      `json:"pendingMigration"`
	Unreadable         int      `json:"unreadable"`
}

// Status reports the store state.
func (s *Store) Status(ctx context.Context) (Status, error) {
	ring := s.Ring()
	status := Status{CurrentKEKID: ring.CurrentID(), KEKIDs: ring.IDs()}
	acknowledged, err := s.ExportAcknowledged(ctx)
	if err != nil {
		return status, err
	}
	status.ExportAcknowledged = acknowledged
	if err := s.db.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE d.state<>'current'),count(*) FILTER (WHERE NOT (d.kek_id=ANY($1)))
		FROM plugin_secrets s JOIN plugin_secret_deks d ON d.id=s.dek_id`, ring.IDs()).Scan(&status.Secrets, &status.PendingMigration, &status.Unreadable); err != nil {
		return status, err
	}
	return status, nil
}

// String names a reference for logs without the value.
func (ref SecretRef) String() string {
	return fmt.Sprintf("%s/%s/%s/%s", ref.PluginID, ref.OwnerType, ref.OwnerID, ref.Key)
}

// RunMigrationWorker moves secrets to the current DEK in the background:
// one bounded pass at start and then at each interval, so a DEK rotation
// completes without downtime and survives a restart.
func (s *Store) RunMigrationWorker(ctx context.Context, interval func() <-chan struct{}) {
	for {
		if moved, err := s.MigrateAll(ctx, 100); err != nil {
			if ctx.Err() != nil {
				return
			}
			s.logger.Warn("plugin secret DEK migration pass failed", "error", err)
		} else if moved > 0 {
			s.logger.Info("plugin secrets moved to the current DEK", "count", moved)
		}
		select {
		case <-ctx.Done():
			return
		case <-interval():
		}
	}
}
