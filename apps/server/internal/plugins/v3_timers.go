package plugins

import (
	"context"
	"errors"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/kvstore"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Durable timers of bundled Plugin Manifest API 3 plugins
// (docs/plugin-storage.md#durable-timers). A timer is one item of kind
// "timer" in the plugin delivery queue, with the timer key as its source
// and its subject. The delivery engine runs HandleTimer in the system
// context (v3_deliveries.go).
//
// A generation is one queue item with its own ID. Scheduling a key again
// cancels the current generation and enqueues a new one; cancelling
// cancels it. A generation that runs now becomes cancelled: it keeps the
// key's subject until its callback ends, its result changes nothing, and
// the new generation runs after it, never at the same time.

// Timer failures for the service registry.
var (
	ErrTimerInvalid = errors.New("invalid timer")
	ErrTimerLimit   = errors.New("the plugin has the most pending timers it can hold")
)

func declaresService(manifest plugin.Manifest, reference string) bool {
	return slices.Contains(manifest.Services, reference)
}

func (s *Service) timerPlugin(pluginID string) (hostedPlugin, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || !declaresService(hosted.manifest, "timers.schedule@1") {
		return hostedPlugin{}, ErrPluginNotFound
	}
	return hosted, nil
}

func validTimerKey(key string) bool {
	if kvstore.CheckKey(key) != nil || !utf8.ValidString(key) {
		return false
	}
	for _, r := range key {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// ScheduleTimer schedules one callback. Scheduling a key again replaces
// its current generation, a running one included, with a new generation
// with a new ID. It returns the new ID and the due time. A plugin that is
// not installed cannot schedule a timer.
func (s *Service) ScheduleTimer(ctx context.Context, pluginID, key string, at time.Time, payload []byte) (uuid.UUID, time.Time, error) {
	hosted, err := s.timerPlugin(pluginID)
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	now := s.clock.Now()
	switch {
	case !validTimerKey(key):
		return uuid.Nil, time.Time{}, ErrTimerInvalid
	case len(payload) > plugin.MaxTimerPayloadBytes:
		return uuid.Nil, time.Time{}, ErrTimerInvalid
	case at.IsZero() || at.After(now.Add(plugin.MaxTimerDelay)):
		return uuid.Nil, time.Time{}, ErrTimerInvalid
	}
	id := uuid.New()
	due := at.UTC().Truncate(time.Microsecond)
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := kvstore.Lock(ctx, tx, "plugin_timers:"+pluginID); err != nil {
			return err
		}
		if _, err := plugindelivery.CancelSource(ctx, tx, now, pluginID, plugindelivery.KindTimer, key); err != nil {
			return err
		}
		pending, err := plugindelivery.CountKind(ctx, tx, pluginID, plugindelivery.KindTimer)
		if err != nil {
			return err
		}
		if pending >= plugin.MaxTimersPerPlugin {
			return ErrTimerLimit
		}
		queued, err := plugindelivery.Enqueue(ctx, tx, plugindelivery.Item{
			ID: id, PluginID: pluginID, DefinitionVersion: hosted.manifest.DefinitionVersion,
			Kind: plugindelivery.KindTimer, Source: key, Subject: key, Payload: payload, DueAt: due,
		})
		if err == nil && !queued {
			return ErrPluginNotFound
		}
		return err
	})
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	return id, due, nil
}

// CancelTimer removes the current generation of a key, a running one
// included: a callback that runs now finishes, and its result then changes
// nothing.
func (s *Service) CancelTimer(ctx context.Context, pluginID, key string) (bool, error) {
	if _, err := s.timerPlugin(pluginID); err != nil {
		return false, err
	}
	if !validTimerKey(key) {
		return false, ErrTimerInvalid
	}
	var cancelled int64
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := kvstore.Lock(ctx, tx, "plugin_timers:"+pluginID); err != nil {
			return err
		}
		var err error
		cancelled, err = plugindelivery.CancelSource(ctx, tx, s.clock.Now(), pluginID, plugindelivery.KindTimer, key)
		return err
	})
	return cancelled > 0, err
}
