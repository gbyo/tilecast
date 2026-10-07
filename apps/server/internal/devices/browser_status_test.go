package devices

import (
	"encoding/json"
	"strings"
	"testing"
)

func ptr[T any](value T) *T { return &value }

func TestBrowserStatusKeepsOnlyWhatTheContractDefines(t *testing.T) {
	huge := int64(1) << 60
	status := BrowserStatus{
		BrowserName: "firefox", BrowserMajorVersion: ptr(100000), DisplayMode: "kiosk",
		WakeLock: "maybe", StoragePersistence: "persistent", StorageUsageBytes: ptr(int64(-1)), StorageQuotaBytes: ptr(huge),
		OfflineContent: "ready", ServiceWorker: "controlling", ServiceWorkerVersion: "version with spaces and <script>",
		FullscreenActive: ptr(true),
	}
	got := status.Sanitized()
	if got.BrowserName != "" || got.BrowserMajorVersion != nil || got.DisplayMode != "" || got.WakeLock != "" {
		t.Fatalf("an unknown value was kept: %+v", got)
	}
	if got.StorageUsageBytes != nil || got.StorageQuotaBytes != nil || got.ServiceWorkerVersion != "" {
		t.Fatalf("an out-of-range measurement or text was kept: %+v", got)
	}
	if got.StoragePersistence != "persistent" || got.OfflineContent != "ready" || got.ServiceWorker != "controlling" || got.FullscreenActive == nil {
		t.Fatalf("a valid value was dropped: %+v", got)
	}
}

func TestBrowserStatusIsStoredOnlyForTheBrowserFamilyAndOnlyWhenItSaysSomething(t *testing.T) {
	status := &BrowserStatus{BrowserName: "edge", BrowserMajorVersion: ptr(154), DisplayMode: "standalone_pwa", ServiceWorkerVersion: "0.1.0"}
	if browserStatusJSON("android", status) != nil || browserStatusJSON("", status) != nil {
		t.Fatal("another player family stored a Browser section")
	}
	if browserStatusJSON("browser", nil) != nil {
		t.Fatal("an absent section was stored")
	}
	if browserStatusJSON("browser", &BrowserStatus{BrowserName: "netscape"}) != nil {
		t.Fatal("a section with nothing the server understands was stored")
	}
	stored := browserStatusJSON("browser", status)
	var decoded map[string]any
	if err := json.Unmarshal(stored, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["browserName"] != "edge" || decoded["displayMode"] != "standalone_pwa" || decoded["browserMajorVersion"].(float64) != 154 {
		t.Fatalf("stored section is wrong: %s", stored)
	}
	// Nothing outside the struct can ride along.
	var heartbeat Heartbeat
	if err := json.Unmarshal([]byte(`{"playerFamily":"browser","browser":{"browserName":"chrome","userAgent":"Mozilla/5.0 secret","hostname":"kiosk-7"}}`), &heartbeat); err != nil {
		t.Fatal(err)
	}
	if encoded := browserStatusJSON("browser", heartbeat.Browser); strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "kiosk") {
		t.Fatalf("an undefined field was stored: %s", encoded)
	}
}

func TestOnlyABrowserHasAShorterCommandList(t *testing.T) {
	for _, supported := range BrowserSupportedCommands() {
		if !PlatformSupportsCommand("browser", supported) {
			t.Fatalf("%s is in the matrix but refused", supported)
		}
	}
	for _, refused := range []string{"display_power_off", "clear_media_cache", "install_player_update", "restart_player_process", "provision_presentation_network", "install_autostart", "recreate_renderer"} {
		if PlatformSupportsCommand("browser", refused) {
			t.Fatalf("a Browser Player was offered %s", refused)
		}
		if !PlatformSupportsCommand("linux", refused) || !PlatformSupportsCommand("android", refused) {
			t.Fatalf("%s was refused for a native player", refused)
		}
	}
}
