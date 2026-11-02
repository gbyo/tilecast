package devices

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/playercaps"
)

// updatePlayerCapabilitiesHeartbeat stores the generic capability
// status. Unknown capabilities, versions, and providers are dropped by
// the registry sanitizer; an oversized report keeps the stored value.
// Nil means the player said nothing and also keeps it; an explicit
// empty report clears it, so a disconnected provider disappears
// promptly. Like every optional status block, this never fails the
// heartbeat.
func (s *Service) updatePlayerCapabilitiesHeartbeat(ctx context.Context, screenID uuid.UUID, heartbeat Heartbeat) {
	if heartbeat.PlayerCapabilities == nil {
		return
	}
	report := make(map[string]playercaps.Reported, len(heartbeat.PlayerCapabilities))
	for id, entry := range heartbeat.PlayerCapabilities {
		report[id] = playercaps.Reported{Version: entry.Version, Provider: entry.Provider}
	}
	clean, err := playercaps.SanitizeReport(report)
	if err != nil {
		return
	}
	stored := make(map[string]PlayerCapabilityReport, len(clean))
	for id, entry := range clean {
		stored[id] = PlayerCapabilityReport{Version: entry.Version, Provider: entry.Provider}
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return
	}
	_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET player_capabilities=$2::jsonb WHERE screen_id=$1`, screenID, encoded)
}
