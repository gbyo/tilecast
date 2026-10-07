package devices

import (
	"encoding/json"
	"regexp"
)

// BrowserStatus is the bounded Browser section of a Browser Player heartbeat:
// facts only a browser can measure. Every field is a measurement, not a
// conclusion, and none can identify one browser. The server rebuilds the value
// from the fields it understands, so what is stored never carries more than
// this struct allows.
type BrowserStatus struct {
	BrowserName          string `json:"browserName,omitempty"`
	BrowserMajorVersion  *int   `json:"browserMajorVersion,omitempty"`
	DisplayMode          string `json:"displayMode,omitempty"`
	FullscreenActive     *bool  `json:"fullscreenActive,omitempty"`
	AudioUnlocked        *bool  `json:"audioUnlocked,omitempty"`
	WakeLock             string `json:"wakeLock,omitempty"`
	StoragePersistence   string `json:"storagePersistence,omitempty"`
	StorageUsageBytes    *int64 `json:"storageUsageBytes,omitempty"`
	StorageQuotaBytes    *int64 `json:"storageQuotaBytes,omitempty"`
	OfflineContent       string `json:"offlineContent,omitempty"`
	ServiceWorker        string `json:"serviceWorker,omitempty"`
	ServiceWorkerVersion string `json:"serviceWorkerVersion,omitempty"`
	WasDiscarded         *bool  `json:"wasDiscarded,omitempty"`
}

var (
	browserNames         = map[string]bool{"chrome": true, "edge": true, "chromium": true, "other": true}
	browserDisplayModes  = map[string]bool{"browser_tab": true, "standalone_pwa": true}
	browserWakeLocks     = map[string]bool{"active": true, "released": true, "denied": true, "unsupported": true}
	browserPersistence   = map[string]bool{"persistent": true, "best_effort": true, "unknown": true}
	browserOfflineStates = map[string]bool{"ready": true, "repairing": true, "not_prepared": true}
	browserWorkerStates  = map[string]bool{"controlling": true, "update_waiting": true, "installing": true, "unavailable": true}
	browserVersionText   = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`)
)

const maxBrowserBytes = int64(1) << 53

// Sanitized keeps only the values the contract defines. An unknown value is
// dropped, not rejected: a Player that sends something newer must not lose its
// whole heartbeat, and the server must not store what it cannot name.
func (s BrowserStatus) Sanitized() BrowserStatus {
	keep := func(allowed map[string]bool, value string) string {
		if allowed[value] {
			return value
		}
		return ""
	}
	bytes := func(value *int64) *int64 {
		if value == nil || *value < 0 || *value > maxBrowserBytes {
			return nil
		}
		return value
	}
	var major *int
	if s.BrowserMajorVersion != nil && *s.BrowserMajorVersion >= 0 && *s.BrowserMajorVersion <= 9999 {
		major = s.BrowserMajorVersion
	}
	version := ""
	if browserVersionText.MatchString(s.ServiceWorkerVersion) {
		version = s.ServiceWorkerVersion
	}
	return BrowserStatus{
		BrowserName:          keep(browserNames, s.BrowserName),
		BrowserMajorVersion:  major,
		DisplayMode:          keep(browserDisplayModes, s.DisplayMode),
		FullscreenActive:     s.FullscreenActive,
		AudioUnlocked:        s.AudioUnlocked,
		WakeLock:             keep(browserWakeLocks, s.WakeLock),
		StoragePersistence:   keep(browserPersistence, s.StoragePersistence),
		StorageUsageBytes:    bytes(s.StorageUsageBytes),
		StorageQuotaBytes:    bytes(s.StorageQuotaBytes),
		OfflineContent:       keep(browserOfflineStates, s.OfflineContent),
		ServiceWorker:        keep(browserWorkerStates, s.ServiceWorker),
		ServiceWorkerVersion: version,
		WasDiscarded:         s.WasDiscarded,
	}
}

// browserStatusJSON is what the heartbeat stores. It is nil, and the column is
// cleared, unless a Browser Player sent a section with at least one value.
func browserStatusJSON(family string, status *BrowserStatus) []byte {
	if family != "browser" || status == nil {
		return nil
	}
	encoded, err := json.Marshal(status.Sanitized())
	if err != nil || string(encoded) == "{}" {
		return nil
	}
	return encoded
}
