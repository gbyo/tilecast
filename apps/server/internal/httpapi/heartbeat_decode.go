package httpapi

import (
	"encoding/json"
	"sort"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// salvageableHeartbeatFields are optional playback identifiers. A malformed one
// is dropped and named in the log rather than costing the whole heartbeat: the
// same message carries the lifecycle facts (player version code, healthy
// playback timestamp, playback state, safe mode) that settle a self-update, and
// losing those leaves a deployment stuck even though the player is healthy.
//
// Required identifiers, credentials, deployment identifiers, and anything
// security-sensitive are deliberately absent: `currentUpdateDeploymentId` and
// `lastCommandId` still reject the payload, because an unreadable value there
// would misattribute an update or a command result. Nothing is coerced — a
// dropped field is recorded as absent, never as a substituted value.
var salvageableHeartbeatFields = map[string]bool{
	"currentItemId":         true,
	"currentAssetId":        true,
	"currentPlaylistId":     true,
	"currentScheduleId":     true,
	"currentWebsiteAssetId": true,
	"currentWidgetId":       true,
	"activeTakeoverId":      true,
	"assignedPlaylistId":    true,
}

// salvageHeartbeatPayload removes malformed optional playback identifiers from a
// heartbeat payload. It reports the removed field names and whether the result
// is safe to use: a payload that is not an object, or whose invalid fields are
// not optional playback identifiers, is not salvageable and must be rejected
// whole.
func salvageHeartbeatPayload(payload []byte) ([]byte, []string, bool) {
	invalid := heartbeatPayloadInvalidFields(payload)
	if len(invalid) == 0 {
		return nil, nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return nil, nil, false
	}
	dropped := make([]string, 0, len(invalid))
	for _, name := range invalid {
		if !salvageableHeartbeatFields[name] {
			return nil, nil, false
		}
		delete(fields, name)
		dropped = append(dropped, name)
	}
	reduced, err := json.Marshal(fields)
	if err != nil {
		return nil, nil, false
	}
	sort.Strings(dropped)
	return reduced, dropped, true
}

// decodeHeartbeatTolerantly unmarshals a heartbeat payload, dropping malformed
// optional playback identifiers. The returned names are the dropped fields; an
// error means the payload could not be salvaged and must be rejected whole.
func decodeHeartbeatTolerantly(payload []byte) (devices.Heartbeat, []string, error) {
	var heartbeat devices.Heartbeat
	err := json.Unmarshal(payload, &heartbeat)
	if err == nil {
		return heartbeat, nil, nil
	}
	reduced, dropped, ok := salvageHeartbeatPayload(payload)
	if !ok {
		return devices.Heartbeat{}, nil, err
	}
	var salvaged devices.Heartbeat
	if salvageErr := json.Unmarshal(reduced, &salvaged); salvageErr != nil {
		return devices.Heartbeat{}, nil, err
	}
	return salvaged, dropped, nil
}
