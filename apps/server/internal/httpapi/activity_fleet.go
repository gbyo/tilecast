package httpapi

import (
	"context"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/activityreport"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
)

// Fleet classification is owned by activityreport, which the Activity
// overview and the activity.read@1 service share.
const (
	fleetStateHealthy    = activityreport.FleetHealthy
	fleetStateImpaired   = activityreport.FleetImpaired
	fleetStateOffline    = activityreport.FleetOffline
	fleetStateUnmeasured = activityreport.FleetUnmeasured
)

const fleetHeartbeatGrace = activityreport.FleetHeartbeatGrace

type fleetScreenSignals = activityreport.ScreenSignals

func normalizePlaybackState(value string) string {
	return activityreport.NormalizePlaybackState(value)
}

func playbackExpected(signals fleetScreenSignals) bool {
	return activityreport.PlaybackExpected(signals)
}

func classifyFleetScreen(now time.Time, signals fleetScreenSignals) (string, string) {
	return activityreport.ClassifyScreen(now, signals)
}

type activityFleetHealth struct {
	// Measured is the operational population: enabled, paired, not archived,
	// not deleted, and holding a live credential. Screens taken out of service
	// on purpose are excluded so their downtime cannot read as a fault.
	Measured   int64 `json:"measured"`
	Online     int64 `json:"online"`
	Healthy    int64 `json:"healthy"`
	Impaired   int64 `json:"impaired"`
	Offline    int64 `json:"offline"`
	Unmeasured int64 `json:"unmeasured"`
}

func (s *server) fleetHealth(ctx context.Context, now time.Time, access authz.ScreenAccess) (activityFleetHealth, error) {
	health, err := activityreport.New(s.db).FleetHealth(ctx, now, &access)
	return activityFleetHealth(health), err
}
