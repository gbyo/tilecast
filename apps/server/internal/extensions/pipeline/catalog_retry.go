package pipeline

import (
	"context"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/contributions"
)

const (
	catalogRetryInitialDelay = time.Second
	catalogRetryMaxDelay     = time.Minute
	catalogRebuildTimeout    = 2 * time.Minute
)

// catalogRetry tracks the one background loop that repairs a failed
// post-commit catalog rebuild. Package skips are not failures here: they
// describe a package, not the rebuild, and retrying them would spin on
// permanently invalid content.
type catalogRetry struct {
	running bool
	// generation advances on every successful rebuild. A retry loop stops
	// when it sees a newer generation than the one it started from.
	generation uint64
	stop       context.CancelFunc
	done       chan struct{}
}

// afterCatalogRebuild records the outcome of one rebuild and starts the
// retry loop when the rebuild itself failed.
func (s *Service) afterCatalogRebuild(ctx context.Context, err error) {
	if contributions.SkipsOnly(err) {
		s.retryMu.Lock()
		s.retry.generation++
		s.retryMu.Unlock()
		return
	}
	s.log().ErrorContext(ctx, "package catalog rebuild failed after commit; retrying", "error", err)
	s.scheduleCatalogRetry()
}

func (s *Service) scheduleCatalogRetry() {
	s.retryMu.Lock()
	defer s.retryMu.Unlock()
	if s.retry.running {
		return
	}
	delay := s.retryInitialDelay
	if delay <= 0 {
		delay = catalogRetryInitialDelay
	}
	loopCtx, cancel := context.WithCancel(context.Background())
	s.retry.running = true
	s.retry.stop = cancel
	s.retry.done = make(chan struct{})
	started := s.retry.generation
	go s.catalogRetryLoop(loopCtx, started, s.retry.done, delay)
}

func (s *Service) catalogRetryLoop(ctx context.Context, startedAt uint64, done chan struct{}, delay time.Duration) {
	defer close(done)
	finish := func() {
		s.retryMu.Lock()
		s.retry.running = false
		s.retryMu.Unlock()
	}
	for {
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			finish()
			return
		case <-timer.C:
		}
		s.retryMu.Lock()
		superseded := s.retry.generation != startedAt
		s.retryMu.Unlock()
		if superseded {
			finish()
			return
		}
		rebuildCtx, cancel := context.WithTimeout(ctx, catalogRebuildTimeout)
		err := s.contributions.Rebuild(rebuildCtx)
		cancel()
		if contributions.SkipsOnly(err) {
			s.retryMu.Lock()
			s.retry.generation++
			s.retryMu.Unlock()
			s.log().Info("package catalog rebuild recovered")
			finish()
			return
		}
		s.log().Warn("package catalog rebuild retry failed", "error", err, "next_retry", delay*2)
		delay *= 2
		if delay > catalogRetryMaxDelay {
			delay = catalogRetryMaxDelay
		}
	}
}

// Close stops the catalog retry loop and waits for it to exit.
func (s *Service) Close() {
	s.retryMu.Lock()
	stop, done := s.retry.stop, s.retry.done
	s.retryMu.Unlock()
	if stop == nil {
		return
	}
	stop()
	<-done
}
