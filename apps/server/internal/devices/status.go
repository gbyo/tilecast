package devices

import "time"

func computeScreenStatus(now time.Time, socketConnected, enabled, activeCredential, awaitingPlayer bool, lastContact *time.Time) Status {
	if enabled && !activeCredential && awaitingPlayer {
		return StatusAwaitingPlayer
	}
	return ComputeStatus(now, socketConnected, enabled, activeCredential, lastContact)
}

func ComputeStatus(now time.Time, socketConnected, enabled, activeCredential bool, lastContact *time.Time) Status {
	if !enabled {
		return StatusDisabled
	}
	if !activeCredential {
		return StatusRevoked
	}
	if socketConnected {
		return StatusOnline
	}
	if lastContact == nil {
		return StatusOffline
	}
	age := now.Sub(*lastContact)
	if age <= RecentThreshold {
		return StatusRecent
	}
	if age <= OfflineThreshold {
		return StatusStale
	}
	return StatusOffline
}

func latestContact(values ...*time.Time) *time.Time {
	var latest *time.Time
	for _, value := range values {
		if value != nil && (latest == nil || value.After(*latest)) {
			copy := *value
			latest = &copy
		}
	}
	return latest
}
