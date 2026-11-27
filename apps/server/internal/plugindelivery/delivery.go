// Package plugindelivery is the one durable delivery queue for host
// callbacks of bundled Plugin Manifest API 3 plugins: durable timers,
// events, and inbound webhook requests (docs/plugin-delivery.md). A later
// callback kind, such as a Player report, is a new Kind value here, not a
// new queue.
//
// The package knows no plugin and no HTTP handler. A producer enqueues an
// item in its own transaction with Enqueue; an Engine claims due items and
// hands each one to the Target that a Directory returns for the plugin.
//
// Delivery semantics:
//
//   - At least once. Each item has a stable ID that the plugin receives on
//     every attempt.
//   - One item of a (plugin, subject) runs at a time, in sequence order. A
//     later item never runs before an earlier pending item of its subject,
//     also when the earlier one waits for a retry.
//   - Different subjects of a plugin run in parallel, at most
//     ConcurrencyPerPlugin at a time across all Server processes.
//   - A failure retries after RetryBase, doubling, at most RetryMax. After
//     MaxAttempts failed attempts the item is parked, and the next item of
//     its subject runs.
//   - A delivered item is deleted. A parked item expires ParkedRetention
//     after it was parked. A pending item expires PendingRetention after it
//     became due. The plugin's status counts expired items.
//   - Nothing is queued for a plugin that is not installed, and removal
//     deletes the plugin's queue.
package plugindelivery

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Delivery kinds. The subject of an item is stored with its kind as a
// prefix, so subjects of different kinds never share an order.
const (
	KindTimer   = "timer"
	KindEvent   = "event"
	KindWebhook = "webhook"
)

var kindPattern = regexp.MustCompile(`^[a-z][a-z_]{0,31}$`)

// Delivery semantics. docs/plugin-delivery.md names each value.
const (
	// ConcurrencyPerPlugin bounds the items of one plugin that run at the
	// same time, across every Server process. Bundled plugins call slow
	// providers; four keeps one plugin from holding many database
	// connections and provider requests while other subjects still move.
	ConcurrencyPerPlugin = 4
	// CallTimeout is the job time limit of one callback.
	CallTimeout = 30 * time.Second
	// Lease bounds one claim. It is longer than CallTimeout, so a running
	// callback keeps its claim; after a crash, the item can be claimed again
	// when the lease ends.
	Lease = 2 * time.Minute
	// RetryBase is the delay after the first failure. Each further failure
	// doubles it, up to RetryMax.
	RetryBase = 5 * time.Second
	RetryMax  = 15 * time.Minute
	// MaxAttempts is the number of failed attempts that parks an item.
	MaxAttempts = 8
	// PendingRetention is how long an undelivered item waits after it
	// became due before the host expires it.
	PendingRetention = 7 * 24 * time.Hour
	// ParkedRetention is how long a parked item waits for an Owner.
	ParkedRetention = 14 * 24 * time.Hour
)

// Item bounds.
const (
	MaxPayloadBytes  = 64 << 10
	MaxMetadataBytes = 16 << 10
	MaxSourceBytes   = 200
	MaxSubjectBytes  = 256
)

// Stable failure codes. They are the only failure detail that the queue
// stores or that a status shows: never an error text or a payload.
const (
	FailureHandlerError   = "handler_error"
	FailureHandlerPanic   = "handler_panic"
	FailureHandlerTimeout = "handler_timeout"
	// FailureLeaseExpired parks an item whose last claim ended without a
	// result, for example after repeated crashes.
	FailureLeaseExpired = "lease_expired"
)

// Item states.
const (
	statePending   = "pending"
	stateParked    = "parked"
	stateCancelled = "cancelled"
)

// ErrInvalidItem answers an item outside the bounds above.
var ErrInvalidItem = errors.New("plugindelivery: invalid item")

// Item is one delivery to enqueue.
type Item struct {
	// ID is the stable delivery ID. The zero value makes a new random ID.
	ID                uuid.UUID
	PluginID          string
	DefinitionVersion int
	Kind              string
	// Source names what produced the item: a timer key, an event name, or
	// a webhook ID. Reconciliation removes items whose source the plugin
	// no longer accepts.
	Source string
	// Subject is the order key within the kind. The queue stores it as
	// "<kind>:<subject>".
	Subject  string
	Payload  []byte
	Metadata json.RawMessage
	// DueAt is when the item becomes due.
	DueAt time.Time
}

// StoredSubject is the subject as the queue stores and orders it.
func StoredSubject(kind, subject string) string { return kind + ":" + subject }

func (item Item) validate() error {
	switch {
	case !kindPattern.MatchString(item.Kind),
		item.PluginID == "", item.DefinitionVersion < 1,
		item.Source == "", len(item.Source) > MaxSourceBytes, !utf8.ValidString(item.Source),
		item.Subject == "", len(StoredSubject(item.Kind, item.Subject)) > MaxSubjectBytes, !utf8.ValidString(item.Subject),
		len(item.Payload) > MaxPayloadBytes,
		len(item.Metadata) > MaxMetadataBytes,
		item.DueAt.IsZero():
		return ErrInvalidItem
	}
	if len(item.Metadata) > 0 && !json.Valid(item.Metadata) {
		return ErrInvalidItem
	}
	return nil
}

// Enqueue writes one item in the producer's transaction, so the item
// exists exactly when the producer's change commits. It reports false,
// and writes nothing, when the target plugin is not installed.
//
// The item records the installation it was queued for and takes no lock on
// it, so a producer's transaction never waits for a plugin removal (a
// removal locks the installation and then touches screens, as many
// producers do). An item that commits after a concurrent removal belongs to
// an installation that no longer exists: it never runs, also after a
// reinstall, and the sweep deletes it.
func Enqueue(ctx context.Context, tx pgx.Tx, item Item) (bool, error) {
	if err := item.validate(); err != nil {
		return false, err
	}
	installedAt, installed, err := installation(ctx, tx, item.PluginID)
	if err != nil || !installed {
		return false, err
	}
	if item.ID == uuid.Nil {
		item.ID = uuid.New()
	}
	payload := item.Payload
	if payload == nil {
		payload = []byte{}
	}
	metadata := item.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{}`)
	}
	due := item.DueAt.UTC().Truncate(time.Microsecond)
	_, err = tx.Exec(ctx, `INSERT INTO plugin_deliveries(id,plugin_id,definition_version,installed_at,kind,source,subject,payload,metadata,due_at,next_attempt_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
		item.ID, item.PluginID, item.DefinitionVersion, installedAt, item.Kind, item.Source, StoredSubject(item.Kind, item.Subject), payload, metadata, due)
	if err != nil {
		return false, err
	}
	return true, nil
}

// installation reads the installed_at of a plugin's installation, which
// identifies it: a reinstall has a later one.
func installation(ctx context.Context, tx pgx.Tx, pluginID string) (time.Time, bool, error) {
	var installedAt time.Time
	err := tx.QueryRow(ctx, `SELECT installed_at FROM plugin_installations WHERE plugin_id=$1`, pluginID).Scan(&installedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, nil
	}
	return installedAt, err == nil, err
}

// CancelSource removes the items of one plugin, kind, and source: every
// pending and parked item. An item whose callback runs now becomes
// cancelled: it keeps its subject until its claim ends, its completion
// changes nothing, and it never runs again. It reports how many items it
// removed or cancelled.
func CancelSource(ctx context.Context, tx pgx.Tx, now time.Time, pluginID, kind, source string) (int64, error) {
	return cancelWhere(ctx, tx, now, `plugin_id=$2 AND kind=$3 AND source=$4`, pluginID, kind, source)
}

// cancelWhere deletes or cancels the items that match a condition of the
// caller. where is SQL of this package; its parameters start at $2.
func cancelWhere(ctx context.Context, tx pgx.Tx, now time.Time, where string, args ...any) (int64, error) {
	args = append([]any{now}, args...)
	running, err := tx.Exec(ctx, `UPDATE plugin_deliveries SET state='cancelled'
		WHERE `+where+` AND state='pending' AND claimed_until>$1`, args...)
	if err != nil {
		return 0, err
	}
	removed, err := tx.Exec(ctx, `DELETE FROM plugin_deliveries
		WHERE `+where+` AND state<>'cancelled' AND (claimed_until IS NULL OR claimed_until<=$1)`, args...)
	if err != nil {
		return 0, err
	}
	return running.RowsAffected() + removed.RowsAffected(), nil
}

// CountKind counts the live (not cancelled) items of one plugin and kind.
func CountKind(ctx context.Context, tx pgx.Tx, pluginID, kind string) (int, error) {
	var count int
	err := tx.QueryRow(ctx, `SELECT count(*) FROM plugin_deliveries WHERE plugin_id=$1 AND kind=$2 AND state<>'cancelled'`, pluginID, kind).Scan(&count)
	return count, err
}

// RemovePlugin deletes the queue and the delivery status of a plugin in the
// removal transaction. A callback that runs now finishes; its completion
// then changes nothing.
func RemovePlugin(ctx context.Context, tx pgx.Tx, pluginID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM plugin_deliveries WHERE plugin_id=$1`, pluginID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM plugin_delivery_status WHERE plugin_id=$1`, pluginID)
	return err
}
