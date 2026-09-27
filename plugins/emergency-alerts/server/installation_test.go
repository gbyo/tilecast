package server_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/plugins/emergency-alerts/server"
)

// Installation is the top-level gate: a monitor left switched on for an
// uninstalled plugin makes no upstream request, and the plugin cannot be
// configured until it is installed.
func TestUninstalledPluginMakesNoUpstreamRequests(t *testing.T) {
	h, svc := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	seedMonitor(t, h, true, []string{"OH"}, nil)

	if err := svc.Poll(h.Ctx); !errors.Is(err, plugin.ErrNotInstalled) {
		t.Fatalf("poll while uninstalled err = %v", err)
	}
	if _, err := svc.UpdateMonitor(h.Ctx, false, []string{"OH"}, nil, 120, h.OwnerID); !errors.Is(err, plugin.ErrNotInstalled) {
		t.Fatalf("monitor update while uninstalled err = %v", err)
	}
	if _, err := svc.SaveRule(h.Ctx, uuid.Nil, server.RuleInput{Name: "Tornado"}, h.OwnerID); !errors.Is(err, plugin.ErrNotInstalled) {
		t.Fatalf("rule save while uninstalled err = %v", err)
	}
	if fake.count() != 0 {
		t.Fatalf("uninstalled plugin made %d upstream requests", fake.count())
	}

	h.Install()
	if _, err := svc.UpdateMonitor(h.Ctx, true, []string{"OH"}, nil, 120, h.OwnerID); err != nil {
		t.Fatalf("monitor update after install: %v", err)
	}
	if err := svc.Poll(h.Ctx); err != nil {
		t.Fatalf("poll after install: %v", err)
	}
	if fake.count() == 0 {
		t.Fatal("installed plugin did not poll")
	}
}

// The worker loop still ticks while uninstalled, but no tick may reach
// upstream: the first tick fires five seconds after startup.
func TestWorkerLoopMakesNoRequestWhileUninstalled(t *testing.T) {
	h, svc := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	seedMonitor(t, h, true, []string{"OH"}, nil)

	ctx, cancel := context.WithTimeout(h.Ctx, 7*time.Second)
	defer cancel()
	if err := svc.RunWorker(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("worker exit = %v, want deadline after the first gated tick", err)
	}
	if fake.count() != 0 {
		t.Fatalf("uninstalled worker made %d upstream requests", fake.count())
	}
}

// Once installed and enabled, the worker loop polls on its ticks.
func TestWorkerLoopPollsWhenInstalled(t *testing.T) {
	h, svc := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	h.Install()
	seedMonitor(t, h, true, []string{"OH"}, nil)

	ctx, cancel := context.WithTimeout(h.Ctx, 7*time.Second)
	defer cancel()
	if err := svc.RunWorker(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("worker exit = %v, want deadline after polling", err)
	}
	if fake.count() == 0 {
		t.Fatal("installed worker made no upstream request after its first tick")
	}
}

// The host background-job gate sits below installation: a disallowed worker
// makes no upstream request, while an explicit Poll still works.
func TestWorkerMakesNoRequestWhenBackgroundJobsDisallowed(t *testing.T) {
	h, svc := hostedPlugin(t, pluginharness.BackgroundJobsAllowed(false))
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	h.Install()
	seedMonitor(t, h, true, []string{"OH"}, nil)

	ctx, cancel := context.WithTimeout(h.Ctx, 7*time.Second)
	defer cancel()
	if err := svc.RunWorker(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("worker exit = %v, want deadline after the first gated tick", err)
	}
	if fake.count() != 0 {
		t.Fatalf("disallowed worker made %d upstream requests", fake.count())
	}
	if err := svc.Poll(h.Ctx); err != nil {
		t.Fatalf("direct poll while installed: %v", err)
	}
	if fake.count() == 0 {
		t.Fatal("installed plugin did not poll directly")
	}
}
