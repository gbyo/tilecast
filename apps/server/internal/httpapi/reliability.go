package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

var powerResultValues = map[string]bool{"untested": true, "confirmed_working": true, "partially_working": true, "failed": true, "unsupported": true}

func (s *server) screenReliability(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var raw []byte
	var enabled, hasCredential, awaitingPlayer bool
	var archivedAt *time.Time
	var lastConnectedAt, lastDisconnectedAt, lastHeartbeatAt *time.Time
	var playbackState, safeModeReason, lastRendererFailure, lastRendererRestartReason *string
	var lastSyncError, updateState, updateError, telemetryRendererState *string
	var playbackDisabled, safeMode *bool
	var recoveryLevel, streamBackedAssetCount *int
	var lastRendererRestartAt, lastHealthyPlaybackAt, telemetryObservedAt, telemetryLastProgressAt *time.Time
	// Postgres caps any function call at 100 arguments, and jsonb_build_object
	// spends two per field. This payload is well past that, so it is built in
	// chunks and merged with ||. Keep each chunk under 50 fields when adding to
	// it: overflowing produces a run-time 54023, not a compile-time failure.
	err := s.db.QueryRow(r.Context(), `SELECT jsonb_build_object(
		'configuredMode',ps.configured_reliability_mode,'effectiveMode',ps.effective_reliability_mode,
		'foregroundState',ps.foreground_state,'lastForegroundExitAt',ps.last_foreground_exit_at,
		'lastForegroundPackage',CASE WHEN $2 THEN ps.last_foreground_package ELSE NULL END,
		'bootRecoveryResult',ps.boot_recovery_result,'lastSuccessfulColdBootAt',ps.last_successful_cold_boot_at,
		'immersiveModeActive',ps.immersive_mode_active,'keepScreenOn',ps.keep_screen_on,
		'managedKioskCapability',ps.managed_kiosk_capability,'deviceOwnerState',ps.device_owner_state,
		'lockTaskState',ps.lock_task_state,'accessibilityServiceState',ps.accessibility_service_state,
		'accessibilityReturnState',ps.accessibility_return_state,'accessibilityReturnAttempts',ps.accessibility_return_attempts,
		'activeHoursState',ps.active_hours_state,'sleepCapability',ps.sleep_capability,
		'lastSleepRequestResult',ps.last_sleep_request_result,'lastWakeResult',ps.last_wake_result,
		'recoveryLevel',ps.recovery_level,'recoveryCount',ps.recovery_count,'safeMode',ps.safe_mode,
		'lastWatchdogFailure',ps.last_watchdog_failure,'lastWatchdogRecoveryAt',ps.last_watchdog_recovery_at,
		'lastRendererFailure',ps.last_renderer_failure,'rendererRestartCount',ps.renderer_restart_count,
		'lastRendererRestartAt',ps.last_renderer_restart_at,'lastRendererRestartReason',ps.last_renderer_restart_reason,
		'safeModeReason',ps.safe_mode_reason,'streamBackedAssetCount',ps.stream_backed_asset_count
	) || jsonb_build_object(
		'maintenanceSessionExpiresAt',ps.maintenance_session_expires_at,
		'commissioningState',ps.commissioning_state,'commissioningStep',ps.commissioning_step,
		'commissioningCompletedAt',ps.commissioning_completed_at,'cachedFallbackAvailable',ps.cached_fallback_available,
		'lastHealthyPlaybackAt',ps.last_healthy_playback_at,'lastPlaylistTransitionAt',ps.last_playlist_transition_at,
		'lastSuccessfulSyncAt',ps.last_successful_sync_at,'lastServerConnectionAt',ps.last_server_connection_at,
		'bootAttemptCount',ps.boot_attempt_count,'bootLastAttemptAt',ps.boot_last_attempt_at,
		'bootLaunchVerified',ps.boot_launch_verified,'updateReadiness',ps.update_readiness,
		'selfTestResult',ps.self_test_result,'selfTestCompletedAt',ps.self_test_completed_at,
		'autostartState',ps.autostart_state,'autostartTarget',ps.autostart_target,
		'autostartSupervised',ps.autostart_supervised,'autostartLingerEnabled',ps.autostart_linger_enabled,
		'autostartError',ps.autostart_error,
		'airplaySupported',ps.airplay_supported,'airplayUxPlayInstalled',ps.airplay_uxplay_installed,'airplayUxPlayVersion',ps.airplay_uxplay_version,
		'airplayGstreamerInstalled',ps.airplay_gstreamer_installed,'airplayH264DecoderAvailable',ps.airplay_h264_decoder_available
	) || jsonb_build_object(
		'airplayHardwareDecode',ps.airplay_hardware_decode,'airplayDecoder',ps.airplay_decoder,
		'airplayMaxProfile',ps.airplay_max_profile,'airplayGroupSupported',ps.airplay_group_supported,
		'airplayAudioAvailable',ps.airplay_audio_available,'airplayAvahiAvailable',ps.airplay_avahi_available,'airplayMdnsAdvertisementAvailable',ps.airplay_mdns_advertisement_available,
		'airplayMulticastSupported',ps.airplay_multicast_supported,'airplayMulticastTestStatus',ps.airplay_multicast_test_status,
		'airplayLimitation',ps.airplay_limitation,
		'externalPresentationState',ps.external_presentation_state,'externalPresentationSessionId',ps.external_presentation_session_id,
		'externalPresentationRole',ps.external_presentation_role,'airplayReceiverState',ps.airplay_receiver_state,
		'airplayTransport',ps.airplay_transport,'airplayConnected',ps.airplay_connected,
		'externalPresentationExpiresAt',ps.external_presentation_expires_at,
		'displayControlProvider',ps.display_control_provider,'displayControlProviders',ps.display_control_providers,
		'displayControlCapabilities',ps.display_control_capabilities,'displayPowerState',ps.display_power_state,
		'displayPowerStateConfirmed',ps.display_power_state_confirmed,'displayPowerStateObservedAt',ps.display_power_state_observed_at,
		'displayControlPolicyState',ps.display_control_policy_state,'displayControlLastCommandId',ps.display_control_last_command_id,
		'displayControlLastCommandState',ps.display_control_last_command_state,'displayControlLastCommandResult',ps.display_control_last_command_result,
		'displayControlLastCommandSentAt',ps.display_control_last_command_sent_at,'displayControlLastStateConfirmedAt',ps.display_control_last_state_confirmed_at,
		'displayControlError',ps.display_control_error,
		'powerAssist',jsonb_build_object('deviceSleep',COALESCE(pa.device_sleep,'untested'),'tvStandby',COALESCE(pa.tv_standby,'untested'),'deviceWake',COALESCE(pa.device_wake,'untested'),'tvWake',COALESCE(pa.tv_wake,'untested'),'inputSelection',COALESCE(pa.input_selection,'untested'),'tilecastStartup',COALESCE(pa.tilecast_startup,'untested'),'lastTestedAt',pa.last_tested_at)
	) || jsonb_build_object(
		-- Presentation Network capability. Studio composes one operator-facing
		-- status from these; the narrower wiredIpv4 is what AirPlay group RTP
		-- fan-out uses, and it is deliberately not the same field as the screen's
		-- last_known_ip.
		'presentationNetworkSupported',ps.presentation_network_supported,
		'presentationNetworkHelperState',ps.presentation_network_helper_state,
		'presentationNetworkManagerAvailable',ps.presentation_network_manager_available,
		'presentationNetworkWifiAdapter',ps.presentation_network_wifi_adapter,
		'presentationNetworkRadioEnabled',ps.presentation_network_radio_enabled,
		'presentationNetworkState',ps.presentation_network_state,
		'presentationNetworkInstalledId',ps.presentation_network_installed_id,
		'presentationNetworkInstalledRevision',ps.presentation_network_installed_revision,
		'presentationNetworkActiveId',ps.presentation_network_active_id,
		'presentationNetworkLastConnectedAt',ps.presentation_network_last_connected_at,
		'presentationNetworkLastFailureAt',ps.presentation_network_last_failure_at,
		'presentationNetworkLastFailureCode',ps.presentation_network_last_failure_code,
		'presentationNetworkLimitation',ps.presentation_network_limitation,
		'wiredInterfaceAvailable',ps.wired_interface_available,
		'wiredIpv4',host(ps.wired_ipv4)
	) || jsonb_build_object(
		-- Facts only a Browser Player reports; null for every other player.
		'browser',ps.browser_status
	),
		sc.enabled,
		EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=sc.id AND c.revoked_at IS NULL),
		EXISTS(SELECT 1 FROM browser_player_slots bp WHERE bp.screen_id=sc.id AND bp.active_binding_epoch=0),
		sc.archived_at,sc.last_connected_at,sc.last_disconnected_at,sc.last_heartbeat_at,
		ps.playback_state,ps.playback_disabled,ps.safe_mode,ps.safe_mode_reason,ps.recovery_level,
		ps.last_renderer_failure,ps.last_renderer_restart_at,ps.last_renderer_restart_reason,
		ps.stream_backed_asset_count,
		ps.last_healthy_playback_at,ps.last_sync_error,ps.update_state,ps.update_error,
		ts.observed_at,ts.renderer_state,ts.last_meaningful_progress_at
	 FROM screens sc LEFT JOIN screen_player_status ps ON ps.screen_id=sc.id LEFT JOIN screen_power_assist_results pa ON pa.screen_id=sc.id LEFT JOIN screen_telemetry_snapshots ts ON ts.screen_id=sc.id WHERE sc.id=$1`, id, detailedDiagnostics(r)).Scan(&raw,
		&enabled, &hasCredential, &awaitingPlayer, &archivedAt,
		&lastConnectedAt, &lastDisconnectedAt, &lastHeartbeatAt,
		&playbackState, &playbackDisabled, &safeMode, &safeModeReason, &recoveryLevel,
		&lastRendererFailure, &lastRendererRestartAt, &lastRendererRestartReason,
		&streamBackedAssetCount,
		&lastHealthyPlaybackAt, &lastSyncError, &updateState, &updateError,
		&telemetryObservedAt, &telemetryRendererState, &telemetryLastProgressAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "screen_not_found", "Screen was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	if data == nil {
		data = map[string]any{}
	}
	now := time.Now().UTC()
	lastContact := latestHealthTime(lastConnectedAt, lastDisconnectedAt, lastHeartbeatAt)
	status := devices.ComputeStatus(now, s.devices.PresenceConnected(id), enabled, hasCredential, lastContact)
	if enabled && !hasCredential && awaitingPlayer && archivedAt == nil {
		status = devices.StatusAwaitingPlayer
	}
	data["playerHealth"] = derivePlayerHealth(now, playerHealthInput{
		Status: status, LastContactAt: lastContact,
		PlaybackState: derefHealthString(playbackState), PlaybackDisabled: playbackDisabled,
		SafeMode: safeMode != nil && *safeMode, SafeModeReason: derefHealthString(safeModeReason),
		RecoveryLevel: recoveryLevel, LastRendererFailure: derefHealthString(lastRendererFailure),
		LastRendererRestartAt:     lastRendererRestartAt,
		LastRendererRestartReason: derefHealthString(lastRendererRestartReason),
		StreamBackedAssetCount:    streamBackedAssetCount,
		LastHealthyPlaybackAt:     lastHealthyPlaybackAt, LastSyncError: derefHealthString(lastSyncError),
		UpdateState: derefHealthString(updateState), UpdateError: derefHealthString(updateError),
		TelemetryObservedAt:     telemetryObservedAt,
		TelemetryRendererState:  derefHealthString(telemetryRendererState),
		TelemetryLastProgressAt: telemetryLastProgressAt,
	})
	writeJSON(w, 200, map[string]any{"data": data})
}

func derefHealthString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

type powerConfirmationInput struct {
	DeviceSleep     string `json:"deviceSleep"`
	TVStandby       string `json:"tvStandby"`
	DeviceWake      string `json:"deviceWake"`
	TVWake          string `json:"tvWake"`
	InputSelection  string `json:"inputSelection"`
	TilecastStartup string `json:"tilecastStartup"`
}

func (s *server) confirmPowerAssist(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input powerConfirmationInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	values := []*string{&input.DeviceSleep, &input.TVStandby, &input.DeviceWake, &input.TVWake, &input.InputSelection, &input.TilecastStartup}
	for _, value := range values {
		if *value == "" {
			*value = "untested"
		}
		if !powerResultValues[*value] {
			writeError(w, 422, "invalid_power_assist_result", "Power Assist results must use a supported state.")
			return
		}
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	tag, err := s.db.Exec(r.Context(), `INSERT INTO screen_power_assist_results(screen_id,device_sleep,tv_standby,device_wake,tv_wake,input_selection,tilecast_startup,last_tested_at,updated_by) SELECT $1,$2,$3,$4,$5,$6,$7,now(),$8 WHERE EXISTS(SELECT 1 FROM screens WHERE id=$1) ON CONFLICT(screen_id) DO UPDATE SET device_sleep=$2,tv_standby=$3,device_wake=$4,tv_wake=$5,input_selection=$6,tilecast_startup=$7,last_tested_at=now(),updated_by=$8,updated_at=now()`, id, input.DeviceSleep, input.TVStandby, input.DeviceWake, input.TVWake, input.InputSelection, input.TilecastStartup, user.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, 404, "screen_not_found", "Screen was not found.")
		return
	}
	metadata, _ := json.Marshal(map[string]any{"deviceSleep": input.DeviceSleep, "tvStandby": input.TVStandby, "deviceWake": input.DeviceWake, "tvWake": input.TVWake, "inputSelection": input.InputSelection, "tilecastStartup": input.TilecastStartup})
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,'power_assist.confirmed','screen',$3,$4::jsonb)`, uuid.New(), user.ID, id.String(), string(metadata))
	writeJSON(w, 200, map[string]any{"data": map[string]any{"screenId": id, "lastTestedAt": time.Now().UTC()}})
}

func detailedDiagnostics(r *http.Request) bool {
	principal, ok := principalOf(r)
	return ok && principal.CanManage()
}
