package pluginharness

import (
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/connectivity"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/takeovers"
)

// Core event producers wired to the plugin host, for event conformance
// tests (docs/plugin-events.md).

// InstallPlugin installs a plugin the harness hosts alongside.
func (h *Harness) InstallPlugin(id string) {
	h.t.Helper()
	if _, _, err := h.service.Install(h.Ctx, id, h.OwnerID); err != nil {
		h.t.Fatal(err)
	}
}

// RemovePlugin removes a plugin the harness hosts alongside.
func (h *Harness) RemovePlugin(id string) error {
	return h.service.Remove(h.Ctx, id, h.OwnerID)
}

// Deliver runs every delivery of the plugin delivery queue that can run
// now and reports how many ran.
func (h *Harness) Deliver() int { return h.RunTimers() }

// StatusOf reads the operational status of a hosted plugin.
func (h *Harness) StatusOf(id string) plugins.PluginStatus {
	h.t.Helper()
	status, err := h.service.Status(h.Ctx, id)
	if err != nil {
		h.t.Fatal(err)
	}
	return status
}

// Connectivity is the screen connectivity sweep on the harness clock.
func (h *Harness) Connectivity() *connectivity.Sweeper {
	sweeper := connectivity.NewSweeper(h.Pool, h.service)
	if h.clock != nil {
		sweeper.WithClock(func() time.Time { return h.clock.Now().UTC() })
	}
	return sweeper
}

// Scheduling is a scheduling service that emits schedule.changed@1.
func (h *Harness) Scheduling() *scheduling.Service {
	service := scheduling.NewService(h.Pool, nil, scheduling.Limits{MaxSchedules: 100, MaxTargetsPerSchedule: 100, MaxGroupsPerScreen: 10, PrefetchDays: 1})
	service.SetEvents(h.service)
	if h.clock != nil {
		service.SetClock(func() time.Time { return h.clock.Now().UTC() })
	}
	return service
}

// Takeovers is the core Takeover service, wired to the plugin host.
func (h *Harness) Takeovers() *takeovers.Service { return h.takeovers }

// ReadyPlaylist creates a playlist with one ready image.
func (h *Harness) ReadyPlaylist(name string) uuid.UUID {
	h.t.Helper()
	assetID := uuid.New()
	h.exec(`INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by)
		VALUES($1,$2,'Image','image','image.png','image/png',$3,100,1920,1080,'ready',$4)`, assetID, h.OrgID, make([]byte, 32), h.OwnerID)
	h.exec(`INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible)
		VALUES($1,$2,'original','local','originals/image','image/png',100,$3,1920,1080,TRUE)`, uuid.New(), assetID, make([]byte, 32))
	id := uuid.New()
	h.exec(`INSERT INTO playlists(id,organization_id,name,created_by) VALUES($1,$2,$3,$4)`, id, h.OrgID, name, h.OwnerID)
	h.exec(`INSERT INTO playlist_items(id,playlist_id,asset_id,position,duration_ms) VALUES($1,$2,$3,0,10000)`, uuid.New(), id, assetID)
	return id
}

// PairedScreen creates an enabled screen with a live credential whose last
// heartbeat was at lastHeartbeat.
func (h *Harness) PairedScreen(name string, lastHeartbeat time.Time) uuid.UUID {
	h.t.Helper()
	id := h.Screen(name)
	h.exec(`UPDATE screens SET enabled=TRUE,last_heartbeat_at=$2 WHERE id=$1`, id, lastHeartbeat)
	h.exec(`INSERT INTO device_credentials(id,screen_id,public_id,secret_hash) VALUES($1,$2,$3,$4)`,
		uuid.New(), id, "pub"+id.String()[:8], make([]byte, 32))
	return id
}

// Heartbeat records a heartbeat of a screen at a time.
func (h *Harness) Heartbeat(screen uuid.UUID, at time.Time) {
	h.exec(`UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, screen, at)
}
