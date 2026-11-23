package services

import (
	"context"
	"errors"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/kvstore"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// storage.kv@1, timers.schedule@1, and timers.cancel@1 of bundled plugins.
// The namespace is the plugin identity the host bound; no input names a
// plugin or a namespace.

// ErrCodeQuotaExceeded answers a write over the 1 MiB namespace quota, and
// ErrCodeTimerLimit a schedule over the pending timer limit.
const (
	ErrCodeQuotaExceeded = "quota_exceeded"
	ErrCodeTimerLimit    = "timer_limit"
)

type kvKeyInput struct {
	Key string `json:"key"`
}

type kvSetInput struct {
	Key   string `json:"key"`
	Value []byte `json:"value"`
}

type kvCompareInput struct {
	Key      string  `json:"key"`
	Expected *[]byte `json:"expected"`
	Value    []byte  `json:"value"`
}

func kvFailure(err error) *CallError {
	switch {
	case errors.Is(err, kvstore.ErrNotFound):
		return notFound("the key is not set")
	case errors.Is(err, kvstore.ErrInvalidKey), errors.Is(err, kvstore.ErrValueTooLarge):
		return invalidInput("%v", err)
	case errors.Is(err, kvstore.ErrQuotaExceeded):
		return &CallError{Code: ErrCodeQuotaExceeded, Message: "The plugin's 1 MiB of storage is full."}
	}
	return unavailable(err)
}

func (d *Dispatcher) pluginReady(call Call) *CallError {
	if d.deps.Plugins == nil || call.PluginID == "" {
		return &CallError{Code: ErrCodeUnavailable, Message: "Plugin storage is unavailable."}
	}
	return nil
}

func (d *Dispatcher) kvGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input kvKeyInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	value, err := d.deps.Plugins.KVGet(ctx, call.PluginID, input.Key)
	if err != nil {
		return nil, nil, kvFailure(err)
	}
	return map[string][]byte{"value": value}, nil, nil
}

func (d *Dispatcher) kvSet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input kvSetInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	if err := d.deps.Plugins.KVSet(ctx, call.PluginID, input.Key, input.Value); err != nil {
		return nil, nil, kvFailure(err)
	}
	return map[string]bool{"stored": true}, nil, nil
}

func (d *Dispatcher) kvCompareAndSet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input kvCompareInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	swapped, err := d.deps.Plugins.KVCompareAndSet(ctx, call.PluginID, input.Key, input.Expected, input.Value)
	if err != nil {
		return nil, nil, kvFailure(err)
	}
	return map[string]bool{"swapped": swapped}, nil, nil
}

func (d *Dispatcher) kvDelete(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input kvKeyInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	deleted, err := d.deps.Plugins.KVDelete(ctx, call.PluginID, input.Key)
	if err != nil {
		return nil, nil, kvFailure(err)
	}
	return map[string]bool{"deleted": deleted}, nil, nil
}

type timerScheduleInput struct {
	Key     string    `json:"key"`
	At      time.Time `json:"at"`
	Payload []byte    `json:"payload"`
}

func timerFailure(err error) *CallError {
	switch {
	case errors.Is(err, plugins.ErrTimerInvalid):
		return invalidInput("a timer has a key of 1 to 128 bytes without control characters, a payload of at most 4 KiB, and a time at most 400 days ahead")
	case errors.Is(err, plugins.ErrTimerLimit):
		return &CallError{Code: ErrCodeTimerLimit, Message: "The plugin has 1000 pending timers. Cancel one first."}
	case errors.Is(err, plugins.ErrPluginNotFound):
		return notFound("the plugin does not handle timers")
	}
	return unavailable(err)
}

func (d *Dispatcher) timerSchedule(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input timerScheduleInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	id, due, err := d.deps.Plugins.ScheduleTimer(ctx, call.PluginID, input.Key, input.At, input.Payload)
	if err != nil {
		return nil, nil, timerFailure(err)
	}
	return map[string]any{"id": id.String(), "dueAt": due}, nil, nil
}

func (d *Dispatcher) timerCancel(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input kvKeyInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	cancelled, err := d.deps.Plugins.CancelTimer(ctx, call.PluginID, input.Key)
	if err != nil {
		return nil, nil, timerFailure(err)
	}
	return map[string]bool{"cancelled": cancelled}, nil, nil
}
