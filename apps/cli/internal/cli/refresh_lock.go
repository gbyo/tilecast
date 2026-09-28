package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

// withRefreshLock runs fn under a per-context cross-process critical
// section so two CLI processes never redeem the same refresh token. The
// lock is a small exclusive-create file below the config directory: the
// first creator owns it, others retry until it releases. It is portable
// across macOS, Linux, and Windows without new dependencies, and it only
// guards OAuth rotation, which is rare and short.
//
// A stale lock (older than 30s, e.g. from a killed process) is removed
// once so a crash cannot block rotation forever.
func withRefreshLock(store *config.Store, contextName string, fn func() error) error {
	lockPath := refreshLockPath(store, contextName)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return fmt.Errorf("prepare credential lock: %w", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	cleanedStale := false
	for {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = file.WriteString(fmt.Sprintf("%d", os.Getpid()))
			_ = file.Close()
			defer os.Remove(lockPath)
			return fn()
		}
		if !os.IsExist(err) {
			return fmt.Errorf("acquire credential lock: %w", err)
		}
		if !cleanedStale {
			if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > 30*time.Second {
				_ = os.Remove(lockPath)
				cleanedStale = true
				continue
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("another tilecast process is refreshing context %q; try again", contextName)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func refreshLockPath(store *config.Store, contextName string) string {
	safe := strings.ReplaceAll(contextName, string(os.PathSeparator), "_")
	safe = strings.ReplaceAll(safe, "..", "__")
	if safe == "" {
		safe = "default"
	}
	return filepath.Join(store.Dir(), "locks", "context-"+safe+".lock")
}
