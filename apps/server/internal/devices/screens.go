package devices

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// host(), not ::text: last_known_ip is an inet, and casting an inet to text
// appends the netmask, so the fleet list rendered "192.0.2.10/32" and the Fire
// TV panel built an unusable "adb connect 192.0.2.10/32:5555". host() keeps the
// bare address and still yields NULL when no heartbeat has reported one.
const screenSelect = `
SELECT s.id,s.name,s.description,COALESCE(l.name,''),s.location_id,s.room_name,s.room_number,
       l.address_line_1,l.address_line_2,l.city,l.state,l.postal_code,l.country,l.latitude,l.longitude,l.created_at,l.updated_at,
       s.platform,s.device_manufacturer,s.device_model,s.android_version,s.player_version,
       s.screen_width,s.screen_height,s.density,s.locale,s.timezone,s.available_storage_bytes,s.uptime_seconds,s.enabled,s.paired_at,
       s.last_connected_at,s.last_disconnected_at,s.last_heartbeat_at,host(s.last_known_ip),s.created_at,s.updated_at,
       EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=s.id AND c.revoked_at IS NULL),
       s.archived_at,s.archived_reason,
       sg.id,sg.name,COALESCE(p.name,ly.name),
       CASE WHEN p.id IS NOT NULL THEN 'playlist' WHEN ly.id IS NOT NULL THEN 'presentation' END,
       ps.player_version_code,ps.android_sdk,ps.installer_source,ps.install_permission_status,ps.current_update_deployment_id,ps.update_state,ps.update_downloaded_bytes,ps.update_expected_bytes,ps.update_error
FROM screens s
LEFT JOIN locations l ON l.id=s.location_id
LEFT JOIN screen_group_memberships gm ON gm.screen_id=s.id
LEFT JOIN screen_groups sg ON sg.id=gm.screen_group_id
LEFT JOIN screen_playlist_assignments sa ON sa.screen_id=s.id
LEFT JOIN screen_group_playlist_assignments ga ON ga.screen_group_id=sg.id
LEFT JOIN playlists p ON p.id=COALESCE(ga.playlist_id,sa.playlist_id)
LEFT JOIN layouts ly ON ly.id=COALESCE(ga.layout_id,sa.layout_id)
LEFT JOIN screen_player_status ps ON ps.screen_id=s.id`

func (s *Service) ListScreens(ctx context.Context) ([]Screen, error) {
	rows, err := s.db.Query(ctx, screenSelect+` WHERE s.archived_at IS NULL AND EXISTS (SELECT 1 FROM device_credentials c WHERE c.screen_id=s.id AND c.revoked_at IS NULL) ORDER BY s.name ASC LIMIT 500`)
	if err != nil {
		return nil, fmt.Errorf("list screens: %w", err)
	}
	defer rows.Close()
	result := make([]Screen, 0)
	for rows.Next() {
		screen, err := scanScreen(rows, s.presence, s.now())
		if err != nil {
			return nil, err
		}
		result = append(result, screen)
	}
	return result, rows.Err()
}

func (s *Service) ListArchivedScreens(ctx context.Context) ([]Screen, error) {
	rows, err := s.db.Query(ctx, screenSelect+` WHERE s.archived_at IS NOT NULL ORDER BY s.archived_at DESC,s.name ASC LIMIT 500`)
	if err != nil {
		return nil, fmt.Errorf("list archived screens: %w", err)
	}
	defer rows.Close()
	result := make([]Screen, 0)
	for rows.Next() {
		screen, err := scanScreen(rows, s.presence, s.now())
		if err != nil {
			return nil, err
		}
		result = append(result, screen)
	}
	return result, rows.Err()
}

func (s *Service) GetScreen(ctx context.Context, id uuid.UUID) (Screen, error) {
	row := s.db.QueryRow(ctx, screenSelect+` WHERE s.id=$1`, id)
	screen, err := scanScreen(row, s.presence, s.now())
	if errors.Is(err, pgx.ErrNoRows) {
		return Screen{}, ErrNotFound
	}
	return screen, err
}

type scanner interface {
	Scan(...any) error
}

func scanScreen(row scanner, presence *PresenceHub, now time.Time) (Screen, error) {
	var screen Screen
	var addressLine1, addressLine2, city, state, postalCode, country *string
	var latitude, longitude *float64
	var locationCreatedAt, locationUpdatedAt *time.Time
	if err := row.Scan(&screen.ID, &screen.Name, &screen.Description, &screen.Location, &screen.LocationID, &screen.RoomName, &screen.RoomNumber,
		&addressLine1, &addressLine2, &city, &state, &postalCode, &country, &latitude, &longitude, &locationCreatedAt, &locationUpdatedAt,
		&screen.Platform, &screen.DeviceManufacturer, &screen.DeviceModel, &screen.AndroidVersion, &screen.PlayerVersion, &screen.ScreenWidth, &screen.ScreenHeight, &screen.Density, &screen.Locale, &screen.Timezone, &screen.AvailableStorageBytes, &screen.UptimeSeconds, &screen.Enabled, &screen.PairedAt, &screen.LastConnectedAt, &screen.LastDisconnectedAt, &screen.LastHeartbeatAt, &screen.LastKnownIP, &screen.CreatedAt, &screen.UpdatedAt, &screen.HasActiveCredential,
		&screen.ArchivedAt, &screen.ArchivedReason,
		&screen.SyncGroupID, &screen.SyncGroupName, &screen.NowPlayingName, &screen.NowPlayingType,
		&screen.PlayerVersionCode, &screen.AndroidSDK, &screen.InstallerSource, &screen.InstallPermissionStatus, &screen.CurrentUpdateDeploymentID, &screen.UpdateState, &screen.UpdateDownloadedBytes, &screen.UpdateExpectedBytes, &screen.UpdateError); err != nil {
		return Screen{}, err
	}
	if screen.LocationID != nil {
		screen.LocationDetails = &Location{
			ID: *screen.LocationID, Name: screen.Location,
			AddressLine1: valueOrEmpty(addressLine1), AddressLine2: valueOrEmpty(addressLine2),
			City: valueOrEmpty(city), State: valueOrEmpty(state), PostalCode: valueOrEmpty(postalCode),
			Country: valueOrEmpty(country), Latitude: latitude, Longitude: longitude,
			CreatedAt: *locationCreatedAt, UpdatedAt: *locationUpdatedAt,
		}
	}
	screen.LastContactAt = latestContact(screen.LastConnectedAt, screen.LastDisconnectedAt, screen.LastHeartbeatAt)
	screen.Status = ComputeStatus(now, presence.Connected(screen.ID), screen.Enabled, screen.HasActiveCredential, screen.LastContactAt)
	return screen, nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (s *Service) UpdateScreen(ctx context.Context, id, userID uuid.UUID, name string, locationID *uuid.UUID, roomName, roomNumber, description string) (Screen, error) {
	name, roomName, roomNumber, description = strings.TrimSpace(name), strings.TrimSpace(roomName), strings.TrimSpace(roomNumber), strings.TrimSpace(description)
	if len(name) < 2 || len(name) > 120 || len(roomName) > 120 || len(roomNumber) > 80 || len(description) > 1000 {
		return Screen{}, errors.New("screen details are invalid")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Screen{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if locationID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM locations WHERE id=$1)`, locationID).Scan(&exists); err != nil {
			return Screen{}, err
		}
		if !exists {
			return Screen{}, errors.New("location is invalid")
		}
	}
	result, err := tx.Exec(ctx, `UPDATE screens SET name=$2,location_id=$3,room_name=$4,room_number=$5,description=$6,updated_at=now() WHERE id=$1 AND archived_at IS NULL`, id, name, locationID, roomName, roomNumber, description)
	if err != nil {
		return Screen{}, fmt.Errorf("update screen: %w", err)
	}
	if result.RowsAffected() != 1 {
		return Screen{}, ErrNotFound
	}
	if err := insertAudit(ctx, tx, userID, "screen.updated", id); err != nil {
		return Screen{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Screen{}, err
	}
	return s.GetScreen(ctx, id)
}

func (s *Service) SetEnabled(ctx context.Context, id, userID uuid.UUID, enabled bool) error {
	action := "screen.disabled"
	if enabled {
		action = "screen.enabled"
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	result, err := tx.Exec(ctx, `UPDATE screens SET enabled=$2,updated_at=now() WHERE id=$1 AND archived_at IS NULL`, id, enabled)
	if err != nil {
		return fmt.Errorf("change screen state: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := insertAudit(ctx, tx, userID, action, id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if !enabled {
		s.presence.Disconnect(id)
	}
	return nil
}

func (s *Service) Revoke(ctx context.Context, id, userID uuid.UUID, reason string) error {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "Revoked by administrator"
	}
	if len(reason) > 500 {
		return errors.New("revocation reason is too long")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	result, err := tx.Exec(ctx, `UPDATE device_credentials SET revoked_at=now(),revocation_reason=$2 WHERE screen_id=$1 AND revoked_at IS NULL`, id, reason)
	if err != nil {
		return fmt.Errorf("revoke device credential: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrConflict
	}
	result, err = tx.Exec(ctx, `UPDATE screens SET archived_at=now(),archived_reason=$2,enabled=FALSE,location_id=NULL,updated_at=now() WHERE id=$1`, id, reason)
	if err != nil {
		return fmt.Errorf("archive screen: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `DELETE FROM screen_group_memberships WHERE screen_id=$1`, id); err != nil {
		return fmt.Errorf("detach archived screen from sync groups: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM screen_playlist_assignments WHERE screen_id=$1`, id); err != nil {
		return fmt.Errorf("remove archived screen content assignment: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM schedule_targets WHERE target_type='screen' AND screen_id=$1`, id); err != nil {
		return fmt.Errorf("remove archived screen schedule targets: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM takeover_targets WHERE target_type='screen' AND screen_id=$1`, id); err != nil {
		return fmt.Errorf("remove archived screen takeover targets: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM alert_rule_targets WHERE target_type='screen' AND screen_id=$1`, id); err != nil {
		return fmt.Errorf("remove archived screen NWS alert targets: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM update_deployment_targets WHERE target_type='screen' AND screen_id=$1`, id); err != nil {
		return fmt.Errorf("remove archived screen update targets: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM screen_player_policies WHERE screen_id=$1`, id); err != nil {
		return fmt.Errorf("remove archived screen policy: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE player_commands SET state='cancelled',completed_at=COALESCE(completed_at,now()),safe_result_code=COALESCE(safe_result_code,'screen_archived'),safe_result_message=COALESCE(safe_result_message,'The screen pairing was revoked.'),updated_at=now() WHERE screen_id=$1 AND state IN ('pending','delivered','acknowledged','running')`, id); err != nil {
		return fmt.Errorf("cancel archived screen commands: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE takeover_screen_states SET state='cancelled',last_updated_at=now() WHERE screen_id=$1 AND state IN ('pending','notified','preparing','ready','active','offline')`, id); err != nil {
		return fmt.Errorf("cancel archived screen takeover state: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE screen_update_states SET state='cancelled',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE screen_id=$1 AND state NOT IN ('succeeded','failed','cancelled','incompatible','already_current')`, id); err != nil {
		return fmt.Errorf("cancel archived screen update state: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE screen_player_status SET assigned_playlist_id=NULL,current_schedule_id=NULL,current_playlist_id=NULL,selection_source=NULL,next_transition_at=NULL,active_takeover_id=NULL,takeover_state=NULL,takeover_preparation_progress=NULL,current_update_deployment_id=NULL,update_state=NULL,update_downloaded_bytes=NULL,update_expected_bytes=NULL,update_error=NULL WHERE screen_id=$1`, id); err != nil {
		return fmt.Errorf("clear archived screen live status: %w", err)
	}
	if err := insertAudit(ctx, tx, userID, "screen.credential.revoked", id); err != nil {
		return err
	}
	if err := s.revokeDependents(ctx, tx, id, nil, reason); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.dependentsRevoked(id)
	s.presence.Disconnect(id)
	return nil
}
