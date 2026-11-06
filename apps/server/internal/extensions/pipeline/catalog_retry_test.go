package pipeline

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/contributions"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

type scriptedContributions struct {
	mu       sync.Mutex
	results  []error
	rebuilds int
	called   chan struct{}
}

func (c *scriptedContributions) Validate(string, packagemanifest.Manifest, string) error { return nil }

func (c *scriptedContributions) Rebuild(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rebuilds++
	var err error
	if len(c.results) > 0 {
		err = c.results[0]
		c.results = c.results[1:]
	}
	select {
	case c.called <- struct{}{}:
	default:
	}
	return err
}

func (c *scriptedContributions) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rebuilds
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met before deadline")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (s *Service) retryRunning() bool {
	s.retryMu.Lock()
	defer s.retryMu.Unlock()
	return s.retry.running
}

func TestResyncRetriesHardRebuildFailure(t *testing.T) {
	fake := &scriptedContributions{results: []error{errors.New("list failed"), errors.New("still down")}}
	service := &Service{contributions: fake, retryInitialDelay: time.Millisecond}
	defer service.Close()

	if err := service.resync(context.Background()); err == nil {
		t.Fatal("first resync error = nil, want the hard failure")
	}
	waitFor(t, func() bool { return fake.count() >= 3 && !service.retryRunning() })
	if got := fake.count(); got != 3 {
		t.Fatalf("rebuild calls = %d, want 1 initial + 2 retries", got)
	}
}

func TestResyncDoesNotRetrySkippedPackages(t *testing.T) {
	skip := contributions.SkippedPackage{PackageID: "acme.skipped", Err: errors.New("bytes missing")}
	fake := &scriptedContributions{results: []error{errors.Join(skip)}}
	service := &Service{contributions: fake, retryInitialDelay: time.Millisecond}
	defer service.Close()

	_ = service.resync(context.Background())
	time.Sleep(50 * time.Millisecond)
	if got := fake.count(); got != 1 || service.retryRunning() {
		t.Fatalf("rebuild calls = %d running = %v, want a single rebuild and no retry", got, service.retryRunning())
	}
}

func TestCatalogRetryStopsWhenLaterRebuildSucceeds(t *testing.T) {
	fake := &scriptedContributions{results: []error{errors.New("list failed")}}
	service := &Service{contributions: fake, retryInitialDelay: 200 * time.Millisecond}
	defer service.Close()

	_ = service.resync(context.Background())
	if err := service.resync(context.Background()); err != nil {
		t.Fatalf("second resync = %v", err)
	}
	waitFor(t, func() bool { return !service.retryRunning() })
	if got := fake.count(); got != 2 {
		t.Fatalf("rebuild calls = %d, want the superseded retry to skip its rebuild", got)
	}
}

func TestCatalogRetryClose(t *testing.T) {
	fake := &scriptedContributions{results: []error{errors.New("list failed")}}
	service := &Service{contributions: fake, retryInitialDelay: time.Hour}
	_ = service.resync(context.Background())
	service.Close()
	if service.retryRunning() {
		t.Fatal("retry still running after Close")
	}
	if got := fake.count(); got != 1 {
		t.Fatalf("rebuild calls = %d, want 1", got)
	}
}
