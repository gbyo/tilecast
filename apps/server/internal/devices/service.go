package devices

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
)

type Service struct {
	db                *pgxpool.Pool
	presence          *PresenceHub
	publicURL         string
	now               func() time.Time
	airplayReconciler func(context.Context, uuid.UUID)
}

func NewService(db *pgxpool.Pool, presence *PresenceHub, publicURL string) *Service {
	return &Service{db: db, presence: presence, publicURL: strings.TrimRight(publicURL, "/"), now: time.Now}
}

// SetAirplayReconciler wires the durable AirPlay preparation state machine into
// the heartbeat path. A follower reporting itself ready is one of the events
// that can complete a group, and reconciliation has to see it without waiting
// for the periodic sweep. The command layer owns that logic, so it is injected
// rather than duplicated here.
func (s *Service) SetAirplayReconciler(reconcile func(context.Context, uuid.UUID)) {
	s.airplayReconciler = reconcile
}

func (s *Service) RegisterPresenceWithNotifier(screenID uuid.UUID, closeConnection func(), notify func(map[string]any) error) func() bool {
	return s.presence.ConnectWithNotifier(screenID, closeConnection, notify)
}

func (s *Service) ManifestChanged(screenID uuid.UUID, version int64) {
	s.presence.Notify(screenID, map[string]any{"type": "manifest.changed", "manifestVersion": version})
}
func (s *Service) ConfigChanged(screenID uuid.UUID, revision int64) {
	s.presence.Notify(screenID, map[string]any{"type": "config.changed", "configRevision": revision})
}
func (s *Service) Notify(screenID uuid.UUID, message map[string]any) bool {
	return s.presence.Notify(screenID, message)
}

func (s *Service) Identity(ctx context.Context) (Identity, error) {
	var identity Identity
	err := s.db.QueryRow(ctx, `SELECT installation_id,organization_name,pairing_enabled FROM organization_settings WHERE singleton=TRUE`).Scan(
		&identity.InstallationID, &identity.OrganizationName, &identity.PairingEnabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Identity{Product: "tilecast", APIVersion: "v1", PairingEnabled: false}, nil
	}
	if err != nil {
		return Identity{}, fmt.Errorf("read installation identity: %w", err)
	}
	identity.Product = "tilecast"
	identity.APIVersion = "v1"
	return identity, nil
}

func (s *Service) CreatePairing(ctx context.Context, installationID string, metadata DeviceMetadata) (PairingCreated, error) {
	identity, err := s.Identity(ctx)
	if err != nil {
		return PairingCreated{}, err
	}
	if !identity.PairingEnabled {
		return PairingCreated{}, ErrForbidden
	}
	if installationID != identity.InstallationID {
		return PairingCreated{}, ErrWrongInstallation
	}
	if err := validateMetadata(metadata); err != nil {
		return PairingCreated{}, err
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return PairingCreated{}, fmt.Errorf("encode device metadata: %w", err)
	}
	pollSecret, err := randomSecret(32)
	if err != nil {
		return PairingCreated{}, err
	}
	now := s.now().UTC()
	result := PairingCreated{ID: uuid.New(), PollSecret: pollSecret, ExpiresAt: now.Add(PairingLifetime), ServerTime: now, PollingInterval: int(PollingInterval.Seconds()), Organization: identity.OrganizationName}
	result.ApprovalURL = s.publicURL + "/screens/pair/"

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PairingCreated{}, fmt.Errorf("begin pairing creation: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, metadata.PlayerInstallationID); err != nil {
		return PairingCreated{}, fmt.Errorf("lock pairing installation: %w", err)
	}
	_, _ = tx.Exec(ctx, `UPDATE device_pairing_sessions SET status='expired' WHERE status IN ('pending','approved') AND (expires_at<=now() OR player_installation_id=$1)`, metadata.PlayerInstallationID)
	for attempt := 0; attempt < 8; attempt++ {
		code, err := GeneratePairingCode()
		if err != nil {
			return PairingCreated{}, err
		}
		tag, err := tx.Exec(ctx, `INSERT INTO device_pairing_sessions (id,code_hash,poll_secret_hash,requested_metadata,requested_server_installation_id,player_installation_id,status,created_at,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,'pending',$7,$8) ON CONFLICT DO NOTHING`,
			result.ID, secretHash(code), secretHash(pollSecret), string(encoded), installationID, metadata.PlayerInstallationID, now, result.ExpiresAt,
		)
		if err == nil && tag.RowsAffected() == 1 {
			result.Code = code
			result.ApprovalURL += code
			if err := tx.Commit(ctx); err != nil {
				return PairingCreated{}, fmt.Errorf("commit pairing creation: %w", err)
			}
			return result, nil
		}
		if err != nil {
			return PairingCreated{}, fmt.Errorf("create pairing session: %w", err)
		}
		result.ID = uuid.New()
	}
	return PairingCreated{}, errors.New("could not allocate a unique pairing code")
}

func validateMetadata(metadata DeviceMetadata) error {
	if _, err := uuid.Parse(metadata.PlayerInstallationID); err != nil {
		return errors.New("playerInstallationId must be a random UUID")
	}
	stringsToValidate := map[string]string{
		"platform": metadata.Platform, "manufacturer": metadata.Manufacturer, "model": metadata.Model,
		"androidVersion": metadata.AndroidVersion, "playerVersion": metadata.PlayerVersion, "locale": metadata.Locale, "timezone": metadata.Timezone,
	}
	for name, value := range stringsToValidate {
		if len(strings.TrimSpace(value)) < 1 || len(value) > 120 {
			return fmt.Errorf("%s must be between 1 and 120 characters", name)
		}
	}
	if metadata.ScreenWidth < 1 || metadata.ScreenWidth > 16384 || metadata.ScreenHeight < 1 || metadata.ScreenHeight > 16384 {
		return errors.New("screen dimensions must be between 1 and 16384 pixels")
	}
	if metadata.Density < 0.5 || metadata.Density > 10 {
		return errors.New("density must be between 0.5 and 10")
	}
	return nil
}

func (s *Service) ResolvePairing(ctx context.Context, code string) (PairingRequest, error) {
	normalized, err := NormalizePairingCode(code)
	if err != nil {
		return PairingRequest{}, err
	}
	var request PairingRequest
	var metadata []byte
	err = s.db.QueryRow(ctx, pairingRequestQuery+` WHERE p.code_hash=$1`, secretHash(normalized)).Scan(
		&request.ID, &request.Status, &metadata, &request.CreatedAt, &request.ExpiresAt, &request.ExistingScreenID, &request.ExistingScreenName, &request.HasActiveCredential, &request.CredentialReplacementOK, &request.PairingMode,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PairingRequest{}, ErrNotFound
	}
	if err != nil {
		return PairingRequest{}, fmt.Errorf("resolve pairing code: %w", err)
	}
	if request.ExpiresAt.Before(s.now()) && (request.Status == "pending" || request.Status == "approved") {
		_, _ = s.db.Exec(ctx, `UPDATE device_pairing_sessions SET status='expired' WHERE id=$1`, request.ID)
		return PairingRequest{}, ErrExpired
	}
	if err := json.Unmarshal(metadata, &request.Metadata); err != nil {
		return PairingRequest{}, fmt.Errorf("decode pairing metadata: %w", err)
	}
	request.PreviouslyPaired = request.ExistingScreenID != nil
	return request, nil
}

const pairingRequestQuery = `SELECT p.id,p.status,p.requested_metadata,p.created_at,p.expires_at,s.id,COALESCE(s.name,''),
EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=s.id AND c.revoked_at IS NULL),p.replace_existing_credential,p.pairing_mode
FROM device_pairing_sessions p LEFT JOIN screens s ON s.player_installation_id=p.player_installation_id`

func (s *Service) ListPendingPairings(ctx context.Context) ([]PairingRequest, error) {
	_, _ = s.db.Exec(ctx, `UPDATE device_pairing_sessions SET status='expired' WHERE status IN ('pending','approved') AND expires_at<=now()`)
	rows, err := s.db.Query(ctx, pairingRequestQuery+` WHERE p.status IN ('pending','approved') AND p.expires_at>now() ORDER BY p.created_at DESC LIMIT 100`)
	if err != nil {
		return nil, fmt.Errorf("list pending pairing requests: %w", err)
	}
	defer rows.Close()
	result := make([]PairingRequest, 0)
	for rows.Next() {
		var request PairingRequest
		var metadata []byte
		if err := rows.Scan(&request.ID, &request.Status, &metadata, &request.CreatedAt, &request.ExpiresAt, &request.ExistingScreenID, &request.ExistingScreenName, &request.HasActiveCredential, &request.CredentialReplacementOK, &request.PairingMode); err != nil {
			return nil, err
		}
		request.PreviouslyPaired = request.ExistingScreenID != nil
		if err := json.Unmarshal(metadata, &request.Metadata); err != nil {
			return nil, fmt.Errorf("decode pairing metadata: %w", err)
		}
		result = append(result, request)
	}
	return result, rows.Err()
}

func (s *Service) PollPairing(ctx context.Context, id uuid.UUID, pollSecret string) (PollResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PollResult{}, fmt.Errorf("begin pairing poll: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var result PollResult
	var expected []byte
	err = tx.QueryRow(ctx, `SELECT status,poll_secret_hash,expires_at,resulting_screen_id,COALESCE(failure_reason,'') FROM device_pairing_sessions WHERE id=$1 FOR UPDATE`, id).Scan(
		&result.Status, &expected, &result.ExpiresAt, &result.ScreenID, &result.FailureReason,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PollResult{}, ErrNotFound
	}
	if err != nil {
		return PollResult{}, fmt.Errorf("read pairing session: %w", err)
	}
	if !secretMatches(expected, pollSecret) {
		return PollResult{}, ErrWrongSecret
	}
	if result.ExpiresAt.Before(s.now()) && (result.Status == "pending" || result.Status == "approved") {
		result.Status = "expired"
		if _, err := tx.Exec(ctx, `UPDATE device_pairing_sessions SET status='expired' WHERE id=$1`, id); err != nil {
			return PollResult{}, fmt.Errorf("expire pairing session: %w", err)
		}
	}
	if result.Status == "approved" {
		token, err := randomSecret(32)
		if err != nil {
			return PollResult{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE device_pairing_sessions SET status='claimed',claimed_at=now(),enrollment_token_hash=$2 WHERE id=$1`, id, secretHash(token)); err != nil {
			return PollResult{}, fmt.Errorf("claim pairing session: %w", err)
		}
		result.Status = "claimed"
		result.EnrollmentToken = token
	}
	if err := tx.Commit(ctx); err != nil {
		return PollResult{}, fmt.Errorf("commit pairing poll: %w", err)
	}
	return result, nil
}

func (s *Service) ApprovePairing(ctx context.Context, id, userID uuid.UUID, name string, locationID *uuid.UUID, roomName, roomNumber, description string, replaceExistingCredential bool) (Screen, error) {
	return s.ApprovePairingWithOptions(ctx, id, userID, PairingApproval{
		Name: name, LocationID: locationID, RoomName: roomName, RoomNumber: roomNumber,
		Description: description, ReplaceExistingCredential: replaceExistingCredential,
	})
}

func (s *Service) ApprovePairingWithOptions(ctx context.Context, id, userID uuid.UUID, input PairingApproval) (Screen, error) {
	input.Name, input.RoomName, input.RoomNumber, input.Description = strings.TrimSpace(input.Name), strings.TrimSpace(input.RoomName), strings.TrimSpace(input.RoomNumber), strings.TrimSpace(input.Description)
	if input.ReplaceHardware && input.ReplaceExistingCredential {
		return Screen{}, fmt.Errorf("hardware replacement and credential repair are mutually exclusive: %w", ErrConflict)
	}
	if input.ReplaceHardware && input.ReplacementScreenID == nil {
		return Screen{}, fmt.Errorf("replacement screen is required: %w", ErrConflict)
	}
	if !input.ReplaceHardware && (len(input.Name) < 2 || len(input.Name) > 120 || len(input.RoomName) > 120 || len(input.RoomNumber) > 80 || len(input.Description) > 1000) {
		return Screen{}, errors.New("screen name, room details, or description are invalid")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Screen{}, fmt.Errorf("begin pairing approval: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if input.LocationID != nil && !input.ReplaceHardware {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM locations WHERE id=$1)`, input.LocationID).Scan(&exists); err != nil {
			return Screen{}, err
		}
		if !exists {
			return Screen{}, errors.New("location is invalid")
		}
	}
	var status string
	var expiresAt time.Time
	var encoded []byte
	err = tx.QueryRow(ctx, `SELECT status,expires_at,requested_metadata FROM device_pairing_sessions WHERE id=$1 FOR UPDATE`, id).Scan(&status, &expiresAt, &encoded)
	if errors.Is(err, pgx.ErrNoRows) {
		return Screen{}, ErrNotFound
	}
	if err != nil {
		return Screen{}, fmt.Errorf("read pairing request: %w", err)
	}
	if expiresAt.Before(s.now()) {
		_, _ = tx.Exec(ctx, `UPDATE device_pairing_sessions SET status='expired' WHERE id=$1`, id)
		return Screen{}, ErrExpired
	}
	if status == "approved" {
		var existing uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT resulting_screen_id FROM device_pairing_sessions WHERE id=$1`, id).Scan(&existing); err == nil {
			return s.GetScreen(ctx, existing)
		}
	}
	if status != "pending" {
		return Screen{}, ErrConflict
	}
	var metadata DeviceMetadata
	if err := json.Unmarshal(encoded, &metadata); err != nil {
		return Screen{}, fmt.Errorf("decode pairing metadata: %w", err)
	}
	var organizationID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		return Screen{}, fmt.Errorf("read organization: %w", err)
	}

	screenID := ids.New(ctx)
	var existingID uuid.UUID
	var activeCredential bool
	pairingMode := "new_screen"
	if input.ReplaceHardware {
		var targetOrganization uuid.UUID
		var targetInstallation string
		var archivedAt *time.Time
		err = tx.QueryRow(ctx, `SELECT organization_id,player_installation_id,archived_at FROM screens WHERE id=$1 FOR UPDATE`, *input.ReplacementScreenID).Scan(&targetOrganization, &targetInstallation, &archivedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return Screen{}, ErrNotFound
		}
		if err != nil {
			return Screen{}, fmt.Errorf("read replacement screen: %w", err)
		}
		if targetOrganization != organizationID || archivedAt != nil {
			return Screen{}, fmt.Errorf("replacement screen is not active in this organization: %w", ErrConflict)
		}
		if targetInstallation == metadata.PlayerInstallationID {
			return Screen{}, fmt.Errorf("the player is already paired to the replacement screen; use credential repair: %w", ErrConflict)
		}
		var installationInUse bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens WHERE organization_id=$1 AND player_installation_id=$2 AND id<>$3)`, organizationID, metadata.PlayerInstallationID, *input.ReplacementScreenID).Scan(&installationInUse); err != nil {
			return Screen{}, err
		}
		if installationInUse {
			return Screen{}, fmt.Errorf("player installation is already assigned to another screen: %w", ErrConflict)
		}
		screenID = *input.ReplacementScreenID
		pairingMode = "hardware_replacement"
	} else {
		err = tx.QueryRow(ctx, `SELECT s.id,EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=s.id AND c.revoked_at IS NULL) FROM screens s WHERE s.organization_id=$1 AND s.player_installation_id=$2`, organizationID, metadata.PlayerInstallationID).Scan(&existingID, &activeCredential)
		if err == nil {
			if activeCredential && !input.ReplaceExistingCredential {
				return Screen{}, ErrPairingRecovery
			}
			screenID = existingID
			pairingMode = "credential_repair"
			_, err = tx.Exec(ctx, `UPDATE screens SET name=$2,description=$3,location_id=$4,room_name=$5,room_number=$6,platform=$7,device_manufacturer=$8,device_model=$9,android_version=$10,player_version=$11,screen_width=$12,screen_height=$13,density=$14,locale=$15,timezone=$16,enabled=TRUE,paired_at=now(),updated_at=now() WHERE id=$1`, screenID, input.Name, input.Description, input.LocationID, input.RoomName, input.RoomNumber, metadata.Platform, metadata.Manufacturer, metadata.Model, metadata.AndroidVersion, metadata.PlayerVersion, metadata.ScreenWidth, metadata.ScreenHeight, metadata.Density, metadata.Locale, metadata.Timezone)
		} else if errors.Is(err, pgx.ErrNoRows) {
			_, err = tx.Exec(ctx, `INSERT INTO screens (id,organization_id,player_installation_id,name,description,location_id,room_name,room_number,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, screenID, organizationID, metadata.PlayerInstallationID, input.Name, input.Description, input.LocationID, input.RoomName, input.RoomNumber, metadata.Platform, metadata.Manufacturer, metadata.Model, metadata.AndroidVersion, metadata.PlayerVersion, metadata.ScreenWidth, metadata.ScreenHeight, metadata.Density, metadata.Locale, metadata.Timezone)
		}
	}
	if err != nil {
		return Screen{}, fmt.Errorf("save screen: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE device_pairing_sessions SET status='approved',approved_at=now(),approved_by_user_id=$2,resulting_screen_id=$3,replace_existing_credential=$4,pairing_mode=$5,replacement_screen_id=$6 WHERE id=$1`, id, userID, screenID, input.ReplaceExistingCredential && activeCredential, pairingMode, input.ReplacementScreenID); err != nil {
		return Screen{}, fmt.Errorf("approve pairing session: %w", err)
	}
	auditAction := "screen.pairing.approved"
	if input.ReplaceHardware {
		auditAction = "screen.pairing.replacement_approved"
	}
	if err := insertAudit(ctx, tx, userID, auditAction, screenID); err != nil {
		return Screen{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Screen{}, fmt.Errorf("commit pairing approval: %w", err)
	}
	return s.GetScreen(ctx, screenID)
}

func (s *Service) RejectPairing(ctx context.Context, id, userID uuid.UUID, reason string) error {
	reason = strings.TrimSpace(reason)
	if len(reason) > 500 {
		return errors.New("rejection reason must not exceed 500 characters")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin pairing rejection: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	result, err := tx.Exec(ctx, `UPDATE device_pairing_sessions SET status='rejected',failure_reason=$3,approved_at=now(),approved_by_user_id=$2 WHERE id=$1 AND status='pending' AND expires_at>now()`, id, userID, reason)
	if err != nil {
		return fmt.Errorf("reject pairing request: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrConflict
	}
	if err := insertAudit(ctx, tx, userID, "screen.pairing.rejected", id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func insertAudit(ctx context.Context, db execer, userID uuid.UUID, action string, resourceID uuid.UUID) error {
	if _, err := db.Exec(ctx, `INSERT INTO audit_logs (id,user_id,action,resource_type,resource_id) VALUES ($1,$2,$3,'screen',$4)`, uuid.New(), userID, action, resourceID.String()); err != nil {
		return fmt.Errorf("record audit log: %w", err)
	}
	return nil
}

func remoteAddress(value string) netip.Addr {
	if addressPort, err := netip.ParseAddrPort(value); err == nil {
		return addressPort.Addr()
	}
	return netip.Addr{}
}
