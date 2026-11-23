package plugin

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Typed shapes of storage.kv@1, timers.schedule@1, and timers.cancel@1 for
// bundled Plugin Manifest API 3 plugins. See docs/plugin-storage.md.

// KV bounds. They are the bounds of the package KV of WebAssembly packages.
const (
	MaxKVKeyBytes       = 128
	MaxKVValueBytes     = 64 << 10
	MaxKVNamespaceBytes = 1 << 20
)

// Stable failure codes of storage.kv@1, returned as *ServiceError.
const (
	KVNotFound      = "not_found"
	KVInvalidKey    = "invalid_input"
	KVQuotaExceeded = "quota_exceeded"
)

// ErrKVNotFound answers KVGet for a key this plugin never stored.
var ErrKVNotFound = errors.New("plugin: storage key not found")

type kvKey struct {
	Key string `json:"key"`
}

type kvValue struct {
	Value []byte `json:"value"`
}

type kvSet struct {
	Key   string `json:"key"`
	Value []byte `json:"value"`
}

type kvCompareAndSet struct {
	Key string `json:"key"`
	// Expected is null when the key must not exist.
	Expected *[]byte `json:"expected"`
	Value    []byte  `json:"value"`
}

// KVGet reads one value of this plugin. A missing key answers
// ErrKVNotFound.
func (s *Services) KVGet(ctx context.Context, key string) ([]byte, error) {
	var out kvValue
	err := s.Call(ctx, "storage.kv@1/get", kvKey{Key: key}, &out)
	var failure *ServiceError
	if errors.As(err, &failure) && failure.Code == KVNotFound {
		return nil, ErrKVNotFound
	}
	return out.Value, err
}

// KVSet stores one value. A key is 1 to 128 bytes, a value at most 64 KiB,
// and the plugin's live values at most 1 MiB.
func (s *Services) KVSet(ctx context.Context, key string, value []byte) error {
	return s.Call(ctx, "storage.kv@1/set", kvSet{Key: key, Value: value}, nil)
}

// KVCompareAndSet stores value only when the current value equals expected
// byte for byte; a nil expected means the key must not exist. It reports
// whether the value was swapped. A failed comparison changes nothing.
func (s *Services) KVCompareAndSet(ctx context.Context, key string, expected []byte, value []byte) (bool, error) {
	input := kvCompareAndSet{Key: key, Value: value}
	if expected != nil {
		input.Expected = &expected
	}
	var out struct {
		Swapped bool `json:"swapped"`
	}
	err := s.Call(ctx, "storage.kv@1/compareAndSet", input, &out)
	return out.Swapped, err
}

// KVDelete removes one key. It reports whether the key existed.
func (s *Services) KVDelete(ctx context.Context, key string) (bool, error) {
	var out struct {
		Deleted bool `json:"deleted"`
	}
	err := s.Call(ctx, "storage.kv@1/delete", kvKey{Key: key}, &out)
	return out.Deleted, err
}

// Timer bounds.
const (
	MaxTimerKeyBytes     = 128
	MaxTimerPayloadBytes = 4 << 10
	// MaxTimerDelay is the farthest a timer can be scheduled ahead.
	MaxTimerDelay = 400 * 24 * time.Hour
	// MaxTimersPerPlugin bounds the pending timers of one plugin.
	MaxTimersPerPlugin = 1000
)

// Timer is one due callback. The host delivers a timer at least once:
// HandleTimer can run again for the same timer after a crash, a timeout, or
// an error, so a handler must be idempotent.
type Timer struct {
	// ID identifies this generation of the key. Scheduling the key again
	// makes a new generation with a new ID.
	ID      string    `json:"id"`
	Key     string    `json:"key"`
	Payload []byte    `json:"payload"`
	DueAt   time.Time `json:"dueAt"`
	// Attempt is 1 for the first delivery.
	Attempt int `json:"attempt"`
}

// TimerHandler is implemented by a bundled Plugin Manifest API 3 plugin
// that declares timers.schedule@1. The host calls HandleTimer in the system
// context, with no operator, for at most 30 seconds. A returned error
// retries the timer with a bounded exponential backoff.
type TimerHandler interface {
	HandleTimer(ctx context.Context, timer Timer) error
}

type timerSchedule struct {
	Key     string    `json:"key"`
	At      time.Time `json:"at"`
	Payload []byte    `json:"payload,omitempty"`
}

// ScheduledTimer is the answer of ScheduleTimer.
type ScheduledTimer struct {
	ID    string    `json:"id"`
	DueAt time.Time `json:"dueAt"`
}

// ScheduleTimer schedules one callback at at. Scheduling a key again
// replaces its pending timer, also one that is running now: the running
// callback finishes, and the new timer runs at its own time.
func (s *Services) ScheduleTimer(ctx context.Context, key string, at time.Time, payload []byte) (ScheduledTimer, error) {
	var out ScheduledTimer
	err := s.Call(ctx, "timers.schedule@1/schedule", timerSchedule{Key: key, At: at, Payload: payload}, &out)
	return out, err
}

// CancelTimer removes the pending timer of a key. It reports whether one
// existed.
func (s *Services) CancelTimer(ctx context.Context, key string) (bool, error) {
	var out struct {
		Cancelled bool `json:"cancelled"`
	}
	err := s.Call(ctx, "timers.cancel@1/cancel", kvKey{Key: key}, &out)
	return out.Cancelled, err
}

// OwnInstance is one of the plugin's own instances as instances.read@1
// answers it. It never holds a secret.
type OwnInstance struct {
	ID            uuid.UUID      `json:"id"`
	Kind          string         `json:"kind"`
	Name          string         `json:"name"`
	Enabled       bool           `json:"enabled"`
	Revision      int64          `json:"revision"`
	Configuration map[string]any `json:"configuration"`
}

// Decode copies the configuration into a plugin's own struct.
func (i OwnInstance) Decode(out any) error {
	return HostedInstance{Configuration: i.Configuration}.Decode(out)
}

// ErrInstanceNotFound answers ReadInstance for an instance that does not
// exist, for example one that was deleted after a timer was scheduled.
var ErrInstanceNotFound = errors.New("plugin: instance not found")

// ReadInstance reads one of the plugin's own instances through
// instances.read@1.
func (s *Services) ReadInstance(ctx context.Context, kind string, id uuid.UUID) (OwnInstance, error) {
	var out OwnInstance
	err := s.Call(ctx, "instances.read@1/get", map[string]any{"kind": kind, "id": id}, &out)
	var failure *ServiceError
	if errors.As(err, &failure) && failure.Code == KVNotFound {
		return OwnInstance{}, ErrInstanceNotFound
	}
	return out, err
}

// InstanceSummary is one entry of ListInstances.
type InstanceSummary struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Enabled  bool      `json:"enabled"`
	Revision int64     `json:"revision"`
}

// ListInstances lists the plugin's own instances of one kind through
// instances.read@1, at most 500.
func (s *Services) ListInstances(ctx context.Context, kind string) ([]InstanceSummary, error) {
	var out struct {
		Items []InstanceSummary `json:"items"`
	}
	err := s.Call(ctx, "instances.read@1/list", map[string]any{"kind": kind}, &out)
	return out.Items, err
}
