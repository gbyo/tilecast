package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The statements are generated, so the thing worth testing is that the
// generation agrees with itself: one placeholder per argument, in the same
// order. A disagreement here would write every measurement one column across.
func TestGeneratedTelemetryStatementsMatchTheirArguments(t *testing.T) {
	placeholder := regexp.MustCompile(`\$(\d+)`)
	highest := func(statement string) int {
		found := 0
		for _, match := range placeholder.FindAllStringSubmatch(statement, -1) {
			var value int
			if _, err := fmt.Sscanf(match[1], "%d", &value); err == nil && value > found {
				found = value
			}
		}
		return found
	}

	gauges := telemetryGaugeArguments("screen", telemetrySampleInput{})
	if got := highest(telemetrySnapshotStatement); got != len(gauges) {
		t.Errorf("snapshot statement uses %d placeholders for %d arguments", got, len(gauges))
	}
	rollups := telemetryRollupArguments("screen", "bucket", telemetrySampleInput{})
	if got := highest(telemetryRollupStatement); got != len(rollups) {
		t.Errorf("rollup statement uses %d placeholders for %d arguments", got, len(rollups))
	}

	// And that the read path reads exactly what the write path writes.
	if got, want := len(telemetryGaugeScanTargets(&telemetrySnapshot{})), len(telemetryGaugeColumns); got != want {
		t.Errorf("snapshot scans %d columns of %d", got, want)
	}
	if got, want := len(telemetryRollupScanTargets(&telemetryRollup{})), len(telemetryRollupColumns); got != want {
		t.Errorf("rollup scans %d columns of %d", got, want)
	}
	if got, want := len(strings.Split(telemetryGaugeSelection, ",")), len(telemetryGaugeColumns); got != want {
		t.Errorf("snapshot selects %d columns of %d", got, want)
	}
	if got, want := len(strings.Split(telemetryRollupSelection, ",")), len(telemetryRollupColumns); got != want {
		t.Errorf("rollup selects %d columns of %d", got, want)
	}
}

func TestTelemetryColumnNamesAreUnique(t *testing.T) {
	for _, names := range [][]string{gaugeNames(), rollupNames()} {
		seen := map[string]bool{}
		for _, name := range names {
			if seen[name] {
				t.Errorf("column %q is declared twice", name)
			}
			seen[name] = true
		}
	}
}

// A state field is an allowlist, not a length limit. That is what keeps a
// hostname, an SSID, or a URL out of these columns whatever a player sends.
func TestTelemetryDropsUnrecognizedStates(t *testing.T) {
	input := telemetrySampleInput{
		NetworkLinkType:        "wifi",
		DisplayPowerState:      "https://internal.example.com/status",
		PowerSource:            "CorpGuest-5GHz",
		TimeSyncState:          "synchronized",
		VideoDecoderPath:       "somewhat-hardware",
		LastDisconnectReason:   "dial tcp 10.0.0.5:443: connect: connection refused",
		LastShutdownReason:     "power_loss",
		DisplayResolution:      "1920x1080",
		VideoDecodedResolution: "/var/lib/tilecast/cache",
	}
	sanitizeTelemetrySample(&input)

	for field, value := range map[string]string{
		"displayPowerState":      input.DisplayPowerState,
		"powerSource":            input.PowerSource,
		"videoDecoderPath":       input.VideoDecoderPath,
		"lastDisconnectReason":   input.LastDisconnectReason,
		"videoDecodedResolution": input.VideoDecodedResolution,
	} {
		if value != "" {
			t.Errorf("%s kept %q, want it dropped as an unrecognized value", field, value)
		}
	}
	// The recognized values in the same sample survive: one bad field does not
	// cost the operator the rest of the report.
	if input.NetworkLinkType != "wifi" || input.TimeSyncState != "synchronized" ||
		input.LastShutdownReason != "power_loss" || input.DisplayResolution != "1920x1080" {
		t.Fatalf("valid states were dropped: %+v", input)
	}
}

// The two sanitization rules differ on purpose, and the difference matters: an
// implausible gauge becomes absent, while an implausible counter is clamped,
// because the counter's column cannot hold NULL and accumulates.
func TestImplausibleGaugesAreDroppedAndCountersAreClamped(t *testing.T) {
	input := telemetrySampleInput{
		AverageLuminance: pointer(float32(4)),
		WifiSignalDBM:    pointer(int32(35)),
		BatteryPercent:   pointer(int32(180)),
		DisplayRefreshHz: pointer(float32(-60)),
		StartupTotalMS:   pointer(int64(-1)),
		Interval: telemetryIntervalInput{
			ConnectedSeconds:      -30,
			HTTPRequestCount:      -5,
			CacheEvictedBytes:     1 << 60,
			UnexpectedRebootCount: 1,
			SyncDriftP95MS:        pointer(int32(-250)),
		},
	}
	sanitizeTelemetrySample(&input)

	if input.AverageLuminance != nil || input.WifiSignalDBM != nil || input.BatteryPercent != nil ||
		input.DisplayRefreshHz != nil || input.StartupTotalMS != nil {
		t.Errorf("an out-of-range gauge was kept: %+v", input)
	}
	if input.Interval.ConnectedSeconds != 0 || input.Interval.HTTPRequestCount != 0 {
		t.Errorf("a negative counter was not clamped to zero: %+v", input.Interval)
	}
	if input.Interval.CacheEvictedBytes != telemetryMaxBytes {
		t.Errorf("evicted bytes = %d, want the ceiling", input.Interval.CacheEvictedBytes)
	}
	if input.Interval.UnexpectedRebootCount != 1 {
		t.Errorf("a plausible counter was altered: %d", input.Interval.UnexpectedRebootCount)
	}
	// Drift is a magnitude, so the sign carries nothing and is not a reason to
	// discard the measurement.
	if input.Interval.SyncDriftP95MS == nil || *input.Interval.SyncDriftP95MS != 250 {
		t.Errorf("sync drift = %v, want the magnitude kept", input.Interval.SyncDriftP95MS)
	}
}

func TestTelemetryDiagnosticsRoundTripThroughTheReport(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		if code := postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:             now,
			NetworkLinkType:        "wifi",
			WifiSignalDBM:          pointer(int32(-62)),
			WifiLinkSpeedMbps:      pointer(int32(130)),
			GatewayReachable:       pointer(true),
			CaptivePortalSuspected: pointer(false),
			LastDisconnectReason:   "timeout",
			DisplayConnected:       pointer(true),
			DisplayResolution:      "3840x2160",
			DisplayRefreshHz:       pointer(float32(60)),
			DisplayPowerState:      "on",
			LastShutdownReason:     "power_loss",
			PowerSource:            "mains",
			BatteryPercent:         pointer(int32(88)),
			ClockOffsetSeconds:     pointer(int32(-4)),
			TimeSyncState:          "synchronized",
			StartupTotalMS:         pointer(int64(41_000)),
			StartupConfigMS:        pointer(int64(600)),
			StartupManifestMS:      pointer(int64(2_400)),
			StartupAssetVerifyMS:   pointer(int64(31_000)),
			StartupFirstFrameMS:    pointer(int64(7_000)),
			VideoDecoderPath:       "hardware",
			VideoDecodedResolution: "1920x1080",
			Interval: telemetryIntervalInput{
				Seconds: 60, ConnectedSeconds: 60,
				HTTPRequestCount: 40, HTTPFailureCount: 2, HTTPClientErrorCount: 1,
				HTTPServerErrorCount: 1, RequestRetryCount: 3, SocketReconnectCount: 1,
				NetworkInterfaceChangeCount:     1,
				DNSResolveP95MS:                 pointer(int32(24)),
				TLSHandshakeP95MS:               pointer(int32(90)),
				TimeToFirstByteP95MS:            pointer(int32(180)),
				AverageThroughputBytesPerSecond: pointer(int64(2_500_000)),
				FrameTimeP95MS:                  pointer(float32(18.5)),
				FrameTimeP99MS:                  pointer(float32(44)),
				JankFrameCount:                  12, RendererCrashCount: 1, SurfaceLostCount: 2,
				DecoderInitFailureCount: 1,
				CacheEvictionCount:      4, CacheEvictedBytes: 900_000, IntegrityFailureCount: 1,
				DownloadResumeCount: 2, DownloadFailureCount: 1,
				UnexpectedRebootCount: 1, DisplaySleepCount: 3, DisplayWakeCount: 3,
			},
		}).Code; code != http.StatusAccepted {
			t.Fatalf("telemetry status=%d", code)
		}

		report := readTelemetryReport(t, env)
		snapshot := report.Snapshot
		if snapshot == nil {
			t.Fatal("no snapshot was recorded")
		}
		if snapshot.NetworkLinkType != "wifi" || snapshot.WifiSignalDBM == nil || *snapshot.WifiSignalDBM != -62 {
			t.Errorf("network gauges = %+v", snapshot)
		}
		if snapshot.DisplayResolution != "3840x2160" || snapshot.DisplayConnected == nil || !*snapshot.DisplayConnected {
			t.Errorf("display gauges = %+v", snapshot)
		}
		// Signed on purpose: behind and ahead are different faults.
		if snapshot.ClockOffsetSeconds == nil || *snapshot.ClockOffsetSeconds != -4 {
			t.Errorf("clock offset = %v, want -4 preserved with its sign", snapshot.ClockOffsetSeconds)
		}
		if snapshot.StartupAssetVerifyMS == nil || *snapshot.StartupAssetVerifyMS != 31_000 {
			t.Errorf("startup breakdown = %+v", snapshot)
		}

		if len(report.Rollups) != 1 {
			t.Fatalf("rollups = %d, want 1", len(report.Rollups))
		}
		rollup := report.Rollups[0]
		if rollup.HTTPRequestCount != 40 || rollup.HTTPFailureCount != 2 || rollup.RequestRetryCount != 3 {
			t.Errorf("request counters = %+v", rollup)
		}
		if rollup.JankFrameCount != 12 || rollup.RendererCrashCount != 1 || rollup.SurfaceLostCount != 2 {
			t.Errorf("render counters = %+v", rollup)
		}
		if rollup.CacheEvictionCount != 4 || rollup.IntegrityFailureCount != 1 || rollup.DownloadResumeCount != 2 {
			t.Errorf("cache counters = %+v", rollup)
		}
		if rollup.DisplaySleepCount != 3 || rollup.UnexpectedRebootCount != 1 {
			t.Errorf("power counters = %+v", rollup)
		}
		if rollup.TimeToFirstByteP95MS == nil || *rollup.TimeToFirstByteP95MS != 180 {
			t.Errorf("connection timings = %+v", rollup)
		}
	})
}

// A wired screen has no radio to measure. Reporting a meaningless signal figure
// must not make it look like a screen at the edge of coverage.
func TestWeakSignalOnlyAppliesToAWirelessLink(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:      now.Add(-30 * time.Minute),
			NetworkLinkType: "ethernet",
			WifiSignalDBM:   pointer(int32(-95)),
		})
		if got := telemetryEventCount(t, env, "network.wifi_signal_weak"); got != 0 {
			t.Fatalf("a wired screen produced %d weak-signal events", got)
		}

		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:      now,
			NetworkLinkType: "wifi",
			WifiSignalDBM:   pointer(int32(-95)),
		})
		if got := telemetryEventCount(t, env, "network.wifi_signal_weak"); got != 1 {
			t.Fatalf("a wireless screen at -95 dBm produced %d weak-signal events, want 1", got)
		}
	})
}

// A rate needs a denominator worth dividing by. One failure in a quiet window
// is not a failing screen.
func TestRequestFailureRateNeedsEnoughRequests(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt: now.Add(-30 * time.Minute),
			Interval:   telemetryIntervalInput{Seconds: 60, HTTPRequestCount: 2, HTTPFailureCount: 2},
		})
		if got := telemetryEventCount(t, env, "network.requests_failing"); got != 0 {
			t.Fatalf("two failed requests produced %d events", got)
		}

		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt: now,
			Interval:   telemetryIntervalInput{Seconds: 60, HTTPRequestCount: 40, HTTPFailureCount: 32},
		})
		if got := telemetryEventCount(t, env, "network.requests_failing"); got != 1 {
			t.Fatalf("32 of 40 requests failing produced %d events, want 1", got)
		}
	})
}

// "Cannot see the display" and "the display is disconnected" are different
// facts, and only the second one is a fault.
func TestDisplayDisconnectedIsDistinctFromUnreported(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postTelemetry(t, env, telemetrySampleInput{ObservedAt: now.Add(-30 * time.Minute)})
		if got := telemetryEventCount(t, env, "display.disconnected"); got != 0 {
			t.Fatalf("a player reporting no display state produced %d events", got)
		}

		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt: now, DisplayConnected: pointer(false),
		})
		if got := telemetryEventCount(t, env, "display.disconnected"); got != 1 {
			t.Fatalf("a disconnected display produced %d events, want 1", got)
		}
	})
}

func readTelemetryReport(t *testing.T, env activityTestEnvironment) screenTelemetryResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/activity/screens/"+env.screenID.String()+"/telemetry?range=24h", nil)
	request = requestWithTestPrincipal(request, env.owner)
	response := httptest.NewRecorder()
	env.server.screenTelemetry(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("telemetry report status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data screenTelemetryResponse `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}
