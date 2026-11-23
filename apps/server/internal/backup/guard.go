package backup

import (
	"sync"
	"time"
)

// GuardMode reports which operations are currently blocked.
type GuardMode string

const (
	// GuardNormal allows all traffic.
	GuardNormal GuardMode = "normal"
	// GuardBackup blocks dashboard mutations and pauses background media
	// jobs while a consistent snapshot is created. Players keep reading.
	GuardBackup GuardMode = "backup"
	// GuardRestore blocks every write and most reads while a restore is
	// staged and activated.
	GuardRestore GuardMode = "restore"
)

// GuardState is a point-in-time snapshot of the guard.
type GuardState struct {
	Mode      GuardMode
	JobID     string
	StartedAt time.Time
}

// Guard coordinates write blocking between backup jobs, HTTP handlers, and
// background workers. It is process-local; job uniqueness across processes is
// enforced by the backup_jobs partial unique index.
type Guard struct {
	mu    sync.RWMutex
	state GuardState

	// background is held for the lifetime of a backup/restore. Background
	// media jobs hold a read permit while they claim and process work, so
	// Begin can drain jobs that were already running before the guard changed.
	background sync.RWMutex
}

// NewGuard returns a guard in normal mode.
func NewGuard() *Guard {
	return &Guard{state: GuardState{Mode: GuardNormal}}
}

// Begin switches the guard into the given mode for a job.
func (g *Guard) Begin(mode GuardMode, jobID string) {
	g.mu.Lock()
	g.state = GuardState{Mode: mode, JobID: jobID, StartedAt: time.Now().UTC()}
	g.mu.Unlock()

	// Publish the blocked state before waiting. New workers therefore decline
	// permits while already-running jobs finish, and once this lock is held no
	// destructive media work can overlap the snapshot.
	g.background.Lock()
}

// End returns the guard to normal mode.
func (g *Guard) End() {
	g.mu.Lock()
	g.state = GuardState{Mode: GuardNormal}
	g.mu.Unlock()
	g.background.Unlock()
}

// State returns the current guard state.
func (g *Guard) State() GuardState {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.state
}

// DashboardWritesAllowed reports whether dashboard mutations may proceed.
func (g *Guard) DashboardWritesAllowed() bool {
	return g.State().Mode == GuardNormal
}

// PlayerRequestsAllowed reports whether player API traffic may proceed.
// Players continue using cached playback during a backup snapshot; during a
// restore the API is unavailable.
func (g *Guard) PlayerRequestsAllowed() bool {
	return g.State().Mode != GuardRestore
}

// BackgroundJobsAllowed reports whether media processing and data source
// refresh workers may claim new work.
func (g *Guard) BackgroundJobsAllowed() bool {
	return g.State().Mode == GuardNormal
}

// BeginBackgroundJob acquires a lifetime permit for a media job. The caller
// must hold the returned release function from before claim through the final
// database/file mutations. Backups and restores wait for all such permits to
// drain before their guarded work begins.
func (g *Guard) BeginBackgroundJob() (release func(), ok bool) {
	g.background.RLock()
	if g.State().Mode != GuardNormal {
		g.background.RUnlock()
		return nil, false
	}
	return g.background.RUnlock, true
}

// RestoreActive reports whether a restore is in progress.
func (g *Guard) RestoreActive() bool {
	return g.State().Mode == GuardRestore
}
