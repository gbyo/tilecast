package devices

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Autostart values the Linux player is defined to report. Anything else is a
// newer or a misbehaving player, and is not written to the status row.
var (
	autostartStates = map[string]bool{
		"unknown": true, "not_installed": true, "installed": true,
		"needs_attention": true, "unsupported": true,
	}
	autostartTargets = map[string]bool{
		"graphical-session.target": true, "default.target": true,
	}
)

func (s *Service) Enroll(ctx context.Context, sessionID uuid.UUID, enrollmentToken string) (EnrollmentResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return EnrollmentResult{}, fmt.Errorf("begin enrollment: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var status string
	var expected []byte
	var enrolledAt *time.Time
	var screenID uuid.UUID
	var screenName string
	var replaceExisting bool
	var approvedBy *uuid.UUID
	var pairingMode string
	var encodedMetadata []byte
	err = tx.QueryRow(ctx, `SELECT p.status,p.enrollment_token_hash,p.enrolled_at,p.resulting_screen_id,s.name,p.replace_existing_credential,p.approved_by_user_id,p.pairing_mode,p.requested_metadata FROM device_pairing_sessions p JOIN screens s ON s.id=p.resulting_screen_id WHERE p.id=$1 FOR UPDATE`, sessionID).Scan(&status, &expected, &enrolledAt, &screenID, &screenName, &replaceExisting, &approvedBy, &pairingMode, &encodedMetadata)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, ErrNotFound
	}
	if err != nil {
		return EnrollmentResult{}, fmt.Errorf("read enrollment: %w", err)
	}
	if status != "claimed" || enrolledAt != nil || len(expected) == 0 {
		return EnrollmentResult{}, ErrAlreadyClaimed
	}
	if !secretMatches(expected, enrollmentToken) {
		return EnrollmentResult{}, ErrWrongSecret
	}
	var metadata DeviceMetadata
	if err := json.Unmarshal(encodedMetadata, &metadata); err != nil {
		return EnrollmentResult{}, fmt.Errorf("decode enrollment metadata: %w", err)
	}
	publicID, secret, credential, err := newDeviceCredential()
	if err != nil {
		return EnrollmentResult{}, err
	}
	credentialID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO device_credentials (id,screen_id,public_id,secret_hash) VALUES ($1,$2,$3,$4)`, credentialID, screenID, publicID, secretHash(secret)); err != nil {
		return EnrollmentResult{}, fmt.Errorf("create device credential: %w", err)
	}
	if pairingMode == "hardware_replacement" {
		if _, err := tx.Exec(ctx, `UPDATE screen_player_history SET retired_at=now(),retirement_reason='Hardware replaced' WHERE screen_id=$1 AND retired_at IS NULL`, screenID); err != nil {
			return EnrollmentResult{}, fmt.Errorf("retire previous hardware history: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE screens SET player_installation_id=$2,platform=$3,device_manufacturer=$4,device_model=$5,android_version=$6,player_version=$7,screen_width=$8,screen_height=$9,density=$10,locale=$11,timezone=$12,archived_at=NULL,archived_reason='',enabled=TRUE,paired_at=now(),updated_at=now() WHERE id=$1`, screenID, metadata.PlayerInstallationID, metadata.Platform, metadata.Manufacturer, metadata.Model, metadata.AndroidVersion, metadata.PlayerVersion, metadata.ScreenWidth, metadata.ScreenHeight, metadata.Density, metadata.Locale, metadata.Timezone); err != nil {
			return EnrollmentResult{}, fmt.Errorf("save replacement hardware: %w", err)
		}
		// A logical screen keeps its Display Control settings, but capability
		// claims belong to the physical Player. Clear the old snapshot before
		// the replacement can heartbeat so Studio never presents stale CEC/DDC
		// controls for the new hardware.
		if _, err := tx.Exec(ctx, `UPDATE screen_player_status SET
				display_control_provider=NULL,
				display_control_providers='{}',
				display_control_capabilities='{}'::jsonb,
				display_power_state=NULL,
				display_power_state_confirmed=NULL,
				display_power_state_observed_at=NULL,
				display_control_policy_state='unknown',
				display_control_last_command_id=NULL,
				display_control_last_command_state=NULL,
				display_control_last_command_result=NULL,
				display_control_last_command_sent_at=NULL,
				display_control_last_state_confirmed_at=NULL,
				display_control_error=NULL
				WHERE screen_id=$1`, screenID); err != nil {
			return EnrollmentResult{}, fmt.Errorf("reset replacement display capabilities: %w", err)
		}
		if err := recordPlayerHistory(ctx, tx, screenID, credentialID, metadata); err != nil {
			return EnrollmentResult{}, err
		}
	}
	if replaceExisting || pairingMode == "hardware_replacement" {
		revocationReason := "Replaced through approved pairing recovery"
		auditAction := "screen.pairing.credential_replaced"
		if pairingMode == "hardware_replacement" {
			revocationReason = "Replaced through approved hardware replacement"
			auditAction = "screen.pairing.hardware_replaced"
		}
		if _, err := tx.Exec(ctx, `UPDATE device_credentials SET revoked_at=now(),revocation_reason=$3 WHERE screen_id=$1 AND id<>$2 AND revoked_at IS NULL`, screenID, credentialID, revocationReason); err != nil {
			return EnrollmentResult{}, fmt.Errorf("replace previous device credentials: %w", err)
		}
		if approvedBy != nil {
			if err := insertAudit(ctx, tx, *approvedBy, auditAction, screenID); err != nil {
				return EnrollmentResult{}, err
			}
		}
	}
	if pairingMode == "new_screen" {
		if err := recordPlayerHistory(ctx, tx, screenID, credentialID, metadata); err != nil {
			return EnrollmentResult{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE screens SET archived_at=NULL,archived_reason='',enabled=TRUE,paired_at=now(),updated_at=now() WHERE id=$1`, screenID); err != nil {
		return EnrollmentResult{}, fmt.Errorf("restore archived screen: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE device_pairing_sessions SET enrolled_at=now(),enrollment_token_hash=NULL WHERE id=$1`, sessionID); err != nil {
		return EnrollmentResult{}, fmt.Errorf("complete enrollment: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return EnrollmentResult{}, fmt.Errorf("commit enrollment: %w", err)
	}
	if pairingMode == "hardware_replacement" {
		s.presence.Disconnect(screenID)
	}
	return EnrollmentResult{ScreenID: screenID, ScreenName: screenName, DeviceCredential: credential}, nil
}

func (s *Service) AuthenticateDevice(ctx context.Context, credential string) (DevicePrincipal, error) {
	publicID, secret, err := ParseDeviceCredential(credential)
	if err != nil {
		return DevicePrincipal{}, ErrInvalidCredential
	}
	var principal DevicePrincipal
	var expected []byte
	var revokedAt *time.Time
	err = s.db.QueryRow(ctx, `SELECT c.id,c.screen_id,c.secret_hash,c.revoked_at,s.name,s.enabled FROM device_credentials c JOIN screens s ON s.id=c.screen_id WHERE c.public_id=$1`, publicID).Scan(
		&principal.CredentialID, &principal.ScreenID, &expected, &revokedAt, &principal.ScreenName, &principal.Enabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return DevicePrincipal{}, ErrInvalidCredential
	}
	if err != nil {
		return DevicePrincipal{}, fmt.Errorf("read device credential: %w", err)
	}
	if !secretMatches(expected, secret) {
		return DevicePrincipal{}, ErrInvalidCredential
	}
	if revokedAt != nil {
		return DevicePrincipal{}, ErrRevokedCredential
	}
	if !principal.Enabled {
		return DevicePrincipal{}, ErrDisabledScreen
	}
	_, _ = s.db.Exec(ctx, `UPDATE device_credentials SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '5 minutes')`, principal.CredentialID)
	return principal, nil
}

// Least time a player must have been up before its heartbeat settles an update.
// Long enough that a build which comes up and immediately dies does not report
// itself finished, short enough that nobody watches a rollout wait on it.
// SettledUptimeSeconds is exported so the reconciler applies the identical
// threshold; the two paths must not disagree about when a build has stayed up.
const SettledUptimeSeconds = 120

// settledUptime reports whether the player has been running long enough for its
// version code to mean "this build came up and stayed up" rather than "this build
// managed one heartbeat".
//
// A duration, not a timestamp, on purpose: the server has no way to compare a
// device's clock against its own, and it must not try. Screens that never report
// uptime are not held back by a check they cannot answer.
func settledUptime(heartbeat Heartbeat) bool {
	return heartbeat.UptimeSeconds == nil || *heartbeat.UptimeSeconds >= SettledUptimeSeconds
}

// effectiveHealthyPlaybackAt dates this screen's most recent healthy playback.
//
// A heartbeat that says it is playing and is not in safe mode is playing right
// now, as observed here, so it is dated with the server's clock rather than the
// device's — the column is read next to server-generated timestamps, and a player
// whose clock is off should not appear to have last played hours ago or in the
// future. The player's reported timestamp is used when the screen is not
// currently playing, because then it is the only account of when it last did.
//
// Sending the field at all is optional: the Android socket status message carries
// playbackState but not lastHealthyPlaybackAt, and every heartbeat after the
// first one on a connection goes over that socket. Deriving it here is what keeps
// the column populated for those players.
//
// Nothing about finishing an update depends on this. It once did, and that was
// the bug: a screen asleep outside its active hours never reports playback and so
// could never finish an update it had plainly completed.
func effectiveHealthyPlaybackAt(heartbeat Heartbeat) *time.Time {
	inSafeMode := heartbeat.SafeMode != nil && *heartbeat.SafeMode
	if heartbeat.PlaybackState == "playing" && !inSafeMode {
		now := time.Now().UTC()
		return &now
	}
	return heartbeat.LastHealthyPlaybackAt
}

// knownPlayerFamily keeps only protocol values: a family, and an
// architecture only for Tilecast Edge.
func knownPlayerFamily(family, architecture string) (string, string) {
	switch family {
	case "edge":
		if architecture != "x86_64" && architecture != "aarch64" {
			architecture = ""
		}
		return family, architecture
	case "android", "electron-linux":
		return family, ""
	default:
		return "", ""
	}
}

func (s *Service) Heartbeat(ctx context.Context, principal DevicePrincipal, heartbeat Heartbeat, address string) error {
	if len(heartbeat.PlayerVersion) > 120 {
		return errors.New("heartbeat metadata is invalid")
	}
	if len(heartbeat.CommissioningState) > 40 || len(heartbeat.CommissioningStep) > 80 || len(heartbeat.UpdateReadiness) > 40 || len(heartbeat.SelfTestResult) > 120 || heartbeat.BootAttemptCount != nil && (*heartbeat.BootAttemptCount < 0 || *heartbeat.BootAttemptCount > 1000) {
		return errors.New("heartbeat reliability metadata is invalid")
	}
	if len(heartbeat.PresentationSchemaVersions) > 8 || len(heartbeat.NativePresentationCapabilities) > 64 || heartbeat.WebRuntimeVersion < 0 || heartbeat.WebBundleLimitBytes < 0 {
		return errors.New("heartbeat presentation capabilities are invalid")
	}
	for capability, version := range heartbeat.NativePresentationCapabilities {
		if len(capability) < 1 || len(capability) > 80 || version < 1 || version > 100 {
			return errors.New("heartbeat presentation capabilities are invalid")
		}
	}
	ip := remoteAddress(address)
	// Liveness (last_heartbeat_at) must not depend on screen-dimension validity:
	// a player that reports 0x0 (some Linux display setups do) would otherwise be
	// frozen "online" with a stale last-contact. Keep the last-known dimensions
	// when the reported ones are out of range, but always record the heartbeat.
	_, err := s.db.Exec(ctx, `UPDATE screens SET screen_width=CASE WHEN $2 BETWEEN 1 AND 16384 THEN $2 ELSE screen_width END,screen_height=CASE WHEN $3 BETWEEN 1 AND 16384 THEN $3 ELSE screen_height END,available_storage_bytes=$4,uptime_seconds=$5,player_version=COALESCE(NULLIF($6,''),player_version),last_heartbeat_at=now(),last_known_ip=$7,updated_at=now() WHERE id=$1`, principal.ScreenID, heartbeat.ScreenWidth, heartbeat.ScreenHeight, heartbeat.AvailableStorageBytes, heartbeat.UptimeSeconds, heartbeat.PlayerVersion, addressString(ip))
	if err != nil {
		return fmt.Errorf("record heartbeat: %w", err)
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO screen_player_status(screen_id) VALUES($1) ON CONFLICT DO NOTHING`, principal.ScreenID)
	// The family is what this heartbeat says, not a sticky value: a screen
	// migrated back from Edge to the Electron player stops saying `edge`.
	// An unknown value is dropped, not rejected, like other optional status.
	family, architecture := knownPlayerFamily(heartbeat.PlayerFamily, heartbeat.PlayerArchitecture)
	_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET player_version_code=$2,android_sdk=$3,installer_source=NULLIF($4,''),install_permission_status=NULLIF($5,''),current_update_deployment_id=$6,update_state=NULLIF($7,''),update_downloaded_bytes=$8,update_expected_bytes=$9,update_error=NULLIF($10,''),player_family=NULLIF($11,''),player_architecture=NULLIF($12,'') WHERE screen_id=$1`, principal.ScreenID, heartbeat.PlayerVersionCode, heartbeat.AndroidSDK, heartbeat.InstallerSource, heartbeat.InstallPermissionStatus, heartbeat.CurrentUpdateDeploymentID, heartbeat.UpdateState, heartbeat.UpdateDownloadedBytes, heartbeat.UpdateExpectedBytes, heartbeat.UpdateError, family, architecture)
	// Linux autostart. Recorded outside the reliability block below because it
	// is reported on its own cadence (at startup and after each autostart
	// command) rather than alongside the Android reliability fields.
	// Only protocol-defined values are stored, and the diagnostic is capped at
	// the length the player already truncates to. An unrecognised value is
	// dropped rather than rejecting the whole heartbeat: that would take the
	// screen offline in Studio over a field it does not depend on.
	if autostartStates[heartbeat.AutostartState] {
		target := heartbeat.AutostartTarget
		if !autostartTargets[target] {
			target = ""
		}
		autostartError := heartbeat.AutostartError
		// By rune: a byte-slice can cut a multi-byte character in half, and
		// Postgres rejects the invalid UTF-8 that produces.
		if runes := []rune(autostartError); len(runes) > 240 {
			autostartError = string(runes[:240])
		}
		_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET autostart_state=NULLIF($2,''),autostart_target=NULLIF($3,''),autostart_supervised=$4,autostart_linger_enabled=$5,autostart_error=NULLIF($6,'') WHERE screen_id=$1`, principal.ScreenID, heartbeat.AutostartState, target, heartbeat.AutostartSupervised, heartbeat.AutostartLingerEnabled, autostartError)
	}
	_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET presentation_schema_versions=$2,native_presentation_capabilities=$3,web_runtime_version=$4,web_bundle_limit_bytes=$5 WHERE screen_id=$1`, principal.ScreenID, heartbeat.PresentationSchemaVersions, heartbeat.NativePresentationCapabilities, heartbeat.WebRuntimeVersion, heartbeat.WebBundleLimitBytes)
	// AirPlay capability and external-presentation status are optional Linux
	// fields. The helper is best effort so older/non-Linux players continue to
	// heartbeat normally while the migration rolls through the fleet.
	s.updateAirplayHeartbeat(ctx, principal.ScreenID, heartbeat)
	// Display Control is also optional. Invalid capability claims are discarded
	// by the helper rather than taking a healthy legacy player offline.
	s.updateDisplayControlHeartbeat(ctx, principal.ScreenID, heartbeat)
	// Presentation Network capability and the wired address AirPlay group RTP
	// fan-out needs. Also optional and also best effort; a player that predates
	// the feature simply reports nothing and keeps its existing AirPlay behavior.
	s.updatePresentationNetworkHeartbeat(ctx, principal.ScreenID, heartbeat)
	// The live Noise Meter's own state. Its historical buckets are stored by
	// the plugins package after this call, so a malformed optional section can
	// never disturb the lifecycle fields above.
	s.updateNoiseMeterHeartbeat(ctx, principal.ScreenID, heartbeat)
	healthyPlaybackAt := effectiveHealthyPlaybackAt(heartbeat)
	if heartbeat.ConfiguredReliabilityMode != "" || heartbeat.SafeMode != nil {
		var previousSafeMode bool
		var previousMaintenance, previousPINChange *time.Time
		_ = s.db.QueryRow(ctx, `SELECT safe_mode,maintenance_session_expires_at,admin_pin_changed_at FROM screen_player_status WHERE screen_id=$1`, principal.ScreenID).Scan(&previousSafeMode, &previousMaintenance, &previousPINChange)
		_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET configured_reliability_mode=NULLIF($2,''),effective_reliability_mode=NULLIF($3,''),foreground_state=NULLIF($4,''),last_foreground_exit_at=$5,last_foreground_package=NULLIF($6,''),boot_recovery_result=NULLIF($7,''),last_successful_cold_boot_at=$8,immersive_mode_active=$9,keep_screen_on=$10,managed_kiosk_capability=NULLIF($11,''),device_owner_state=NULLIF($12,''),lock_task_state=NULLIF($13,''),accessibility_service_state=NULLIF($14,''),accessibility_return_state=NULLIF($15,''),accessibility_return_attempts=$16,active_hours_state=NULLIF($17,''),sleep_capability=NULLIF($18,''),last_sleep_request_result=NULLIF($19,''),last_wake_result=NULLIF($20,''),recovery_level=$21,recovery_count=$22,safe_mode=COALESCE($23,safe_mode),last_watchdog_failure=NULLIF($24,''),last_watchdog_recovery_at=$25,maintenance_session_expires_at=$26 WHERE screen_id=$1`, principal.ScreenID, heartbeat.ConfiguredReliabilityMode, heartbeat.EffectiveReliabilityMode, heartbeat.ForegroundState, heartbeat.LastForegroundExitAt, heartbeat.LastForegroundPackage, heartbeat.BootRecoveryResult, heartbeat.LastSuccessfulColdBootAt, heartbeat.ImmersiveModeActive, heartbeat.KeepScreenOn, heartbeat.ManagedKioskCapability, heartbeat.DeviceOwnerState, heartbeat.LockTaskState, heartbeat.AccessibilityServiceState, heartbeat.AccessibilityReturnState, heartbeat.AccessibilityReturnAttempts, heartbeat.ActiveHoursState, heartbeat.SleepCapability, heartbeat.LastSleepRequestResult, heartbeat.LastWakeResult, heartbeat.RecoveryLevel, heartbeat.RecoveryCount, heartbeat.SafeMode, heartbeat.LastWatchdogFailure, heartbeat.LastWatchdogRecoveryAt, heartbeat.MaintenanceSessionExpiresAt)
		if heartbeat.AdminPINChangedAt != nil {
			_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET admin_pin_changed_at=$2 WHERE screen_id=$1 AND (admin_pin_changed_at IS NULL OR admin_pin_changed_at<$2)`, principal.ScreenID, heartbeat.AdminPINChangedAt)
		}
		// COALESCE, not assignment: a heartbeat that omits one of these fields is
		// saying nothing about it, not saying it is empty. The socket status message
		// carries a smaller field set than the HTTP heartbeat, so a plain assignment
		// erased the values the HTTP heartbeat had just stored — including
		// last_healthy_playback_at, which is what settles a finished self-update.
		_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET commissioning_state=COALESCE(NULLIF($2,''),commissioning_state),commissioning_step=COALESCE(NULLIF($3,''),commissioning_step),commissioning_completed_at=COALESCE($4,commissioning_completed_at),cached_fallback_available=COALESCE($5,cached_fallback_available),last_healthy_playback_at=GREATEST(COALESCE($6,last_healthy_playback_at),last_healthy_playback_at),last_playlist_transition_at=COALESCE($7,last_playlist_transition_at),last_successful_sync_at=COALESCE($8,last_successful_sync_at),last_server_connection_at=COALESCE($9,last_server_connection_at),boot_attempt_count=COALESCE($10,boot_attempt_count),boot_last_attempt_at=COALESCE($11,boot_last_attempt_at),boot_launch_verified=COALESCE($12,boot_launch_verified),update_readiness=COALESCE(NULLIF($13,''),update_readiness),self_test_result=COALESCE(NULLIF($14,''),self_test_result),self_test_completed_at=COALESCE($15,self_test_completed_at) WHERE screen_id=$1`, principal.ScreenID, heartbeat.CommissioningState, heartbeat.CommissioningStep, heartbeat.CommissioningCompletedAt, heartbeat.CachedFallbackAvailable, healthyPlaybackAt, heartbeat.LastPlaylistTransitionAt, heartbeat.LastSuccessfulSyncAt, heartbeat.LastServerConnectionAt, heartbeat.BootAttemptCount, heartbeat.BootLastAttemptAt, heartbeat.BootLaunchVerified, heartbeat.UpdateReadiness, heartbeat.SelfTestResult, heartbeat.SelfTestCompletedAt)
		now := time.Now()
		newSafeMode := previousSafeMode
		if heartbeat.SafeMode != nil {
			newSafeMode = *heartbeat.SafeMode
		}
		previousMaintenanceActive := previousMaintenance != nil && previousMaintenance.After(now)
		newMaintenanceActive := heartbeat.MaintenanceSessionExpiresAt != nil && heartbeat.MaintenanceSessionExpiresAt.After(now)
		audit := func(action string) {
			_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs(id,action,resource_type,resource_id)VALUES($1,$2,'screen',$3)`, uuid.New(), action, principal.ScreenID.String())
		}
		if newSafeMode != previousSafeMode {
			if newSafeMode {
				audit("reliability.safe_mode_entered")
			} else {
				audit("reliability.safe_mode_exited")
			}
		}
		if newSafeMode && heartbeat.CurrentUpdateDeploymentID != nil {
			_, _ = s.db.Exec(ctx, `UPDATE update_deployments d SET status='paused',rollout_phase='paused',paused_at=now(),pause_reason='A canary player entered safe mode.' WHERE d.id=$1 AND d.status='active' AND d.rollout_phase='canary' AND EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.screen_id=$2 AND st.is_canary)`, heartbeat.CurrentUpdateDeploymentID, principal.ScreenID)
		}
		if newMaintenanceActive != previousMaintenanceActive {
			if newMaintenanceActive {
				audit("reliability.maintenance_started")
			} else {
				audit("reliability.maintenance_ended")
			}
		}
		if heartbeat.AdminPINChangedAt != nil && (previousPINChange == nil || heartbeat.AdminPINChangedAt.After(*previousPINChange)) {
			audit("reliability.admin_pin_changed")
		}
	}
	// A self-update settles here, on every accepted heartbeat, so a target that
	// was still mid-flight when the first post-install heartbeat arrived cannot
	// stay there: the conditions are re-evaluated each time. The state filter
	// excludes terminal states, which makes the transition idempotent — a
	// repeated heartbeat updates no rows and cannot double-count a target.
	//
	// Every non-terminal state, not a list of the ones a player is expected to
	// stop on. A player's update-status reports are best-effort — the Linux
	// player logs a failed report at debug and installs anyway, on the stated
	// assumption that the server reconciles from heartbeats — so the state a
	// finished update was left in says only which report was the last to land,
	// and a lost report is not a reason to show a rollout as running forever.
	//
	// What proves the update finished is that this heartbeat came from the new
	// build: the version code is the running process reporting itself, and the
	// old process could not have sent it. Add to that a player out of safe mode
	// and reporting no update failure, and there is nothing left to wait for.
	//
	// Playing content is deliberately NOT required. It was standing in for "the
	// new build runs", but it only holds for a screen that happens to be showing
	// something: one asleep outside its active hours is healthy, is on the new
	// version, and is finished updating, and demanding playback stranded exactly
	// those screens until their next school day. Process uptime is the honest
	// version of that check — it says the new build came up and stayed up, it
	// resets on the restart an install causes, and being a duration rather than
	// a timestamp it cannot be skewed against the server's clock.
	updateFailureReported := heartbeat.UpdateState == "failed" || heartbeat.UpdateError != ""
	settledSafeMode := heartbeat.SafeMode == nil || !*heartbeat.SafeMode
	if heartbeat.PlayerVersionCode != nil && settledUptime(heartbeat) && !updateFailureReported && settledSafeMode {
		// Never for a Tilecast Edge release: it stays provisional until the
		// screen confirms it explicitly (docs/tilecast-edge.md §15).
		_, _ = s.db.Exec(ctx, `WITH completed AS (UPDATE screen_update_states st SET state='succeeded',reconnect_at=now(),completed_at=now(),updated_at=now() WHERE st.screen_id=$1 AND st.expected_version_code<=$2 AND st.state NOT IN('succeeded','failed','cancelled','incompatible','already_current') AND NOT EXISTS(SELECT 1 FROM update_deployments ed JOIN player_releases er ON er.id=ed.release_id WHERE ed.id=st.deployment_id AND er.player_family='edge') RETURNING st.deployment_id) UPDATE update_deployments d SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.state NOT IN('succeeded','failed','cancelled','incompatible','already_current')) THEN 'completed' ELSE d.status END,completed_at=CASE WHEN NOT EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.state NOT IN('succeeded','failed','cancelled','incompatible','already_current')) THEN now() ELSE d.completed_at END WHERE d.id IN(SELECT deployment_id FROM completed)`, principal.ScreenID, *heartbeat.PlayerVersionCode)
	}
	// Bounded reconciliation: a deployment whose targets are all terminal must not
	// keep reporting progress just because the transition that finished the last
	// target happened on a path that did not aggregate it. Scoped to the
	// deployments that include this screen, so it stays a constant-size check.
	_, _ = s.db.Exec(ctx, `UPDATE update_deployments d SET status='completed',completed_at=COALESCE(d.completed_at,now()) WHERE d.status='active' AND EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.screen_id=$1) AND NOT EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.state NOT IN('succeeded','failed','cancelled','incompatible','already_current'))`, principal.ScreenID)
	return nil
}

// MarkHeartbeatContact records authenticated socket liveness without accepting
// optional status metadata. A malformed or newly introduced metadata field must
// not make an otherwise active player look silent.
func (s *Service) MarkHeartbeatContact(ctx context.Context, screenID uuid.UUID, address string) error {
	command, err := s.db.Exec(ctx, `UPDATE screens SET last_heartbeat_at=now(),last_known_ip=$2,updated_at=now() WHERE id=$1`, screenID, addressString(remoteAddress(address)))
	if err != nil {
		return fmt.Errorf("record heartbeat contact: %w", err)
	}
	if command.RowsAffected() != 1 {
		return errors.New("record heartbeat contact: screen was not found")
	}
	return nil
}

func (s *Service) MarkConnected(ctx context.Context, screenID uuid.UUID, address string) error {
	_, err := s.db.Exec(ctx, `UPDATE screens SET last_connected_at=now(),last_known_ip=$2,updated_at=now() WHERE id=$1`, screenID, addressString(remoteAddress(address)))
	return err
}

func (s *Service) MarkDisconnected(ctx context.Context, screenID uuid.UUID) {
	_, _ = s.db.Exec(ctx, `UPDATE screens SET last_disconnected_at=now(),updated_at=now() WHERE id=$1`, screenID)
}

func (s *Service) RegisterPresence(screenID uuid.UUID, closeConnection func()) func() {
	return s.presence.Connect(screenID, closeConnection)
}
