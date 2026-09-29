package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/airplay"
	"github.com/tilecast/tilecast/apps/server/internal/presentnet"
)

const airplayDefaultDuration = 24 * time.Hour

var (
	airplayPINPattern       = regexp.MustCompile(`^[0-9]{4}$`)
	airplayDeviceIDPattern  = regexp.MustCompile(`(?i)^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)
	airplayHostPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$`)
	airplayMulticastPattern = regexp.MustCompile(`^239\.255\.42\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$`)
)

type airplaySessionInput struct {
	TargetType      string    `json:"targetType"`
	TargetID        uuid.UUID `json:"targetId"`
	DurationMinutes int       `json:"durationMinutes"`
	Transport       string    `json:"transport"`
	AudioMode       string    `json:"audioMode"`
}

type airplayTargetScreen struct {
	ID                 uuid.UUID
	Name               string
	Platform           string
	LastKnownIP        string
	Enabled            bool
	Online             bool
	AirPlaySupported   bool
	GroupSupported     bool
	AudioAvailable     bool
	HardwareDecode     bool
	MaxProfile         string
	MulticastSupported bool
	Wired              bool

	// Presentation Network facts. Assignment is the administrator's intent;
	// the rest is what the player reported about its own hardware and helper.
	PresentationNetworkID       *uuid.UUID
	PresentationNetworkName     string
	PresentationNetworkReady    bool
	WifiAdapterPresent          bool
	PresentationNetworkReported bool

	// WiredIPv4 is the explicitly reported Ethernet address group AirPlay RTP is
	// fanned out to. It is deliberately narrower than LastKnownIP: the address a
	// request happened to arrive from stops being an unambiguous answer once a
	// player can hold a second, temporary Wi-Fi address.
	WiredIPv4         string
	WiredIPv4Reported bool
}

// rtpHost is the destination group AirPlay video is sent to for this display.
//
// The explicitly reported wired address wins whenever the player reports one,
// because it is the only value that stays correct while a Presentation Network is
// active. A player that predates the feature reports nothing, and then the
// historical last_known_ip is used so upgrading the server does not break a fleet
// that has not upgraded its players yet — except when a Presentation Network is in
// use, where airplayWiredAddressError refuses to guess.
func (screen airplayTargetScreen) rtpHost() string {
	if airplay.ValidWiredIPv4(screen.WiredIPv4) {
		return screen.WiredIPv4
	}
	return screen.LastKnownIP
}

type airplaySessionRecord struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Provider       string
	Status         string
	TargetType     string
	TargetID       uuid.UUID
	GatewayID      uuid.UUID
	AudioID        *uuid.UUID
	ReceiverName   string
	PIN            string
	DeviceID       string
	ExpiresAt      time.Time
	CreatedBy      *uuid.UUID
	CreatedAt      time.Time
	EndedAt        *time.Time
	EndReason      string
	Transport      string
	Multicast      string
	VideoPort      int
	AudioPort      int
	Profile        string
	AudioMode      string
	// PresentationNetworkID is the network the *gateway* was asked to join, or
	// nil for an ordinary Ethernet-only session. Recording it lets Studio say
	// "Joining District Staff Wi-Fi…" during preparation and gives the audit trail
	// the network without the credential.
	PresentationNetworkID   *uuid.UUID
	PresentationNetworkName string
}

type airplaySessionState struct {
	ScreenID       uuid.UUID `json:"screenId"`
	ScreenName     string    `json:"screenName"`
	Role           string    `json:"role"`
	State          string    `json:"state"`
	LastUpdatedAt  time.Time `json:"lastUpdatedAt"`
	FailureCode    *string   `json:"failureCode,omitempty"`
	FailureMessage *string   `json:"failureMessage,omitempty"`
	// What the gateway's Presentation Network is doing right now, straight from
	// its capability report. It is what turns "Preparing" into "Joining District
	// Staff Wi-Fi…" in Studio. A follower reports nothing here, which is itself
	// the evidence that followers never touch Wi-Fi.
	PresentationNetworkState *string `json:"presentationNetworkState,omitempty"`
}

func (s *server) createAirplaySession(w http.ResponseWriter, r *http.Request) {
	s.expireAirplaySessions(r.Context())
	var input airplaySessionInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if input.TargetType != "screen" && input.TargetType != "group" {
		writeError(w, 422, "airplay_target_invalid", "AirPlay Present supports a screen or screen group target.")
		return
	}
	if input.TargetID == uuid.Nil {
		writeError(w, 422, "airplay_target_invalid", "Choose a screen or group.")
		return
	}
	if input.TargetType == "screen" {
		if !s.authorizeScreenList(w, r, []uuid.UUID{input.TargetID}, nil) {
			return
		}
	} else if !s.authorizeScreenList(w, r, nil, []uuid.UUID{input.TargetID}) {
		return
	}
	if input.DurationMinutes != 0 && input.DurationMinutes != 15 && input.DurationMinutes != 30 && input.DurationMinutes != 60 {
		writeError(w, 422, "airplay_duration_invalid", "Duration must be 15 minutes, 30 minutes, 1 hour, or until stopped.")
		return
	}
	input.Transport = strings.ToLower(strings.TrimSpace(input.Transport))
	if input.Transport == "" {
		input.Transport = "auto"
	}
	if input.Transport != "auto" && input.Transport != "unicast" && input.Transport != "multicast" {
		writeError(w, 422, "airplay_transport_invalid", "Transport must be Auto, Unicast, or Multicast.")
		return
	}
	input.AudioMode = strings.ToLower(strings.TrimSpace(input.AudioMode))
	if input.AudioMode == "" {
		input.AudioMode = "gateway_only"
	}
	if input.AudioMode != "gateway_only" && input.AudioMode != "none" {
		writeError(w, 422, "airplay_audio_mode_invalid", "AirPlay v1 supports gateway-only audio or no audio.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	org, targetName, preferredGateway, screens, err := s.loadAirplayTarget(r.Context(), input.TargetType, input.TargetID)
	if err != nil {
		s.writeAirplayError(w, r, err)
		return
	}
	targetName = cleanAirplayReceiverName(targetName)
	if len(screens) == 0 {
		writeError(w, 422, "airplay_target_empty", "The selected screen group has no members.")
		return
	}
	if len(screens) > airplay.MaxScreens {
		writeError(w, 422, "airplay_group_too_large", fmt.Sprintf("AirPlay groups are limited to %d displays.", airplay.MaxScreens))
		return
	}
	screenIDs := make([]uuid.UUID, 0, len(screens))
	for _, screen := range screens {
		screenIDs = append(screenIDs, screen.ID)
	}
	if activeID, activeErr := s.activeAirplaySessionForScreens(r.Context(), screenIDs); activeErr != nil {
		s.internalError(w, r, activeErr)
		return
	} else if activeID != nil {
		writeError(w, http.StatusConflict, "airplay_already_active", fmt.Sprintf("AirPlay session %s already uses one or more selected displays. Stop it before starting another.", activeID.String()))
		return
	}
	for _, screen := range screens {
		switch {
		case !screen.Enabled:
			writeError(w, 422, "airplay_screen_disabled", fmt.Sprintf("%s is disabled.", screen.Name))
			return
		case !screen.Online:
			writeError(w, 422, "airplay_screen_offline", fmt.Sprintf("%s is not online.", screen.Name))
			return
		case screen.Platform != "linux":
			writeError(w, 422, "airplay_linux_required", fmt.Sprintf("%s is not a Linux AirPlay player.", screen.Name))
			return
		case input.TargetType == "screen" && !screen.AirPlaySupported:
			writeError(w, 422, "airplay_not_ready", fmt.Sprintf("%s is not AirPlay-ready. Check its player capability heartbeat.", screen.Name))
			return
		case input.TargetType == "group" && !screen.GroupSupported:
			writeError(w, 422, "airplay_group_not_ready", fmt.Sprintf("%s has not verified the GStreamer group receiver path.", screen.Name))
			return
		}
	}
	// Does this target use Presentation Networks at all? One assignment anywhere
	// in the room is enough: it means an administrator has decided this room's
	// AirPlay senders live on a Wi-Fi VLAN, and a gateway that stays Ethernet-only
	// would advertise a receiver nobody can discover. A room with no assignment
	// takes none of the branches below and behaves exactly as it did before.
	presentationNetworkRequired := false
	for _, screen := range screens {
		if screen.PresentationNetworkID != nil {
			presentationNetworkRequired = true
			break
		}
	}
	if input.TargetType == "group" {
		// Group fan-out needs an explicit destination per display, including the
		// gateway, which consumes its own forwarded stream over the same Ethernet
		// path. Validate here so a readiness error names the display rather than
		// letting GStreamer be handed an address that cannot work.
		for _, screen := range screens {
			if code, message := airplayWiredAddressError(screen, presentationNetworkRequired); code != "" {
				writeError(w, 422, code, message)
				return
			}
		}
	}
	capabilities := make([]airplay.Capability, 0, len(screens))
	for _, screen := range screens {
		capabilities = append(capabilities, airplay.Capability{
			// A group follower only needs the RTP receiver path. The gateway is
			// selected separately below and must pass the full UxPlay/Avahi
			// AirPlaySupported check.
			AirPlaySupported: screen.AirPlaySupported || (input.TargetType == "group" && screen.GroupSupported),
			HardwareDecode:   screen.HardwareDecode,
			MaxProfile:       screen.MaxProfile,
			MulticastSupport: boolPointer(screen.MulticastSupported),
			Platform:         screen.Platform,
			Online:           screen.Online,
			Wired:            screen.Wired,
			ScreenID:         screen.ID.String(),
			ScreenName:       screen.Name,
			LastKnownIP:      screen.LastKnownIP,
		})
	}
	profile, err := airplay.CommonProfile(capabilities)
	if err != nil {
		writeError(w, 422, "airplay_profile_unavailable", err.Error())
		return
	}
	candidates := make([]airplay.GatewayCandidate, 0, len(screens))
	for _, screen := range screens {
		candidates = append(candidates, airplay.GatewayCandidate{
			ID: screen.ID.String(), Name: screen.Name, Online: screen.Online,
			Platform: screen.Platform, AirPlaySupported: screen.AirPlaySupported,
			HardwareDecode: screen.HardwareDecode, Wired: screen.Wired,
			PresentationNetworkAssigned: screen.PresentationNetworkID != nil,
			PresentationNetworkReady:    screen.PresentationNetworkReady,
			WifiAdapterPresent:          screen.WifiAdapterPresent,
			WiredIPv4:                   screen.rtpHost(),
		})
	}
	requirement := airplay.GatewayRequirement{
		PresentationNetwork: presentationNetworkRequired,
		WiredIPv4:           input.TargetType == "group",
	}
	// Exactly ONE display joins the Presentation Network: this one. Followers
	// prepare only their existing GStreamer receiver, never need a Wi-Fi adapter,
	// and never receive the network's credentials. A room in which only one member
	// has Wi-Fi is therefore fully usable, as long as that member can be the
	// gateway — which is what this selection decides.
	gateway, rejected, ok := airplay.ChooseGateway(candidates, uuidString(preferredGateway), requirement)
	if !ok {
		code := "airplay_gateway_unavailable"
		if presentationNetworkRequired {
			code = "airplay_presentation_network_gateway_unavailable"
		}
		writeError(w, 422, code, airplay.GatewayLimitation(rejected, requirement))
		return
	}
	gatewayScreen := airplayScreenByID(screens, gateway.ID)
	// The gateway is the only display that needs the Presentation Network, so its
	// network is the session's network. A follower's assignment is irrelevant and
	// is deliberately not recorded.
	var sessionNetworkID *uuid.UUID
	sessionNetworkName := ""
	if presentationNetworkRequired && gatewayScreen != nil {
		sessionNetworkID = gatewayScreen.PresentationNetworkID
		sessionNetworkName = gatewayScreen.PresentationNetworkName
	}
	if sessionNetworkID != nil && s.presentationNetworks != nil && !s.presentationNetworks.CredentialsAvailable() {
		// Fail before the player spends a preparation window on a credential
		// request that cannot succeed.
		writeError(w, 422, "airplay_presentation_network_key_unavailable",
			presentnet.KeyUnavailable(fmt.Sprintf("Presenting to %s over %s", targetName, sessionNetworkName)))
		return
	}
	var audioID *uuid.UUID
	if input.AudioMode == "gateway_only" {
		id := uuid.MustParse(gateway.ID)
		for _, screen := range screens {
			if screen.ID == id && !screen.AudioAvailable {
				writeError(w, 422, "airplay_audio_unavailable", fmt.Sprintf("%s has no verified audio sink. Choose no audio or select another gateway.", screen.Name))
				return
			}
		}
		audioID = &id
	}
	transport := "unicast"
	if input.TargetType == "group" {
		allMulticast := true
		for _, screen := range screens {
			allMulticast = allMulticast && screen.MulticastSupported
		}
		transport = airplay.SelectTransport(input.Transport, len(screens), allMulticast)
	}
	if input.TargetType == "screen" {
		transport = "unicast"
	}
	now := time.Now().UTC()
	expiresAt := now.Add(airplayDefaultDuration)
	if input.DurationMinutes > 0 {
		expiresAt = now.Add(time.Duration(input.DurationMinutes) * time.Minute)
	}
	pin, err := airplay.RandomPIN()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	deviceID, err := airplay.RandomDeviceID()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	sessionID := uuid.New()
	gatewayID := uuid.MustParse(gateway.ID)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	// Serialize AirPlay activation decisions for the organization. The fast
	// check above keeps the common path cheap, while this transaction-scoped
	// lock closes the race where two Studio requests otherwise both observe no
	// active session and prepare the same display(s).
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, "airplay:"+org.String()); err != nil {
		s.internalError(w, r, err)
		return
	}
	var lockedActiveID uuid.UUID
	lockedActiveErr := tx.QueryRow(r.Context(), `SELECT ep.id FROM external_presentation_sessions ep JOIN external_presentation_screen_states st ON st.session_id=ep.id WHERE st.screen_id=ANY($1) AND ep.status IN ('preparing','waiting','active','stopping') ORDER BY ep.created_at DESC LIMIT 1`, screenIDs).Scan(&lockedActiveID)
	if lockedActiveErr == nil {
		writeError(w, http.StatusConflict, "airplay_already_active", fmt.Sprintf("AirPlay session %s already uses one or more selected displays. Stop it before starting another.", lockedActiveID.String()))
		return
	}
	if !errors.Is(lockedActiveErr, pgx.ErrNoRows) {
		s.internalError(w, r, lockedActiveErr)
		return
	}
	multicastAddress := ""
	if transport == "multicast" {
		// Multicast is shared across the LAN, not only within one organization.
		// Allocate a currently-unused suffix under a transaction lock so two
		// simultaneous presentations cannot cross-talk. If the controlled range
		// is exhausted, keep the session viable over unicast.
		if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, "airplay:multicast"); err != nil {
			s.internalError(w, r, err)
			return
		}
		for offset := 0; offset < 255; offset++ {
			suffix := byte((int(sessionID[0])+offset)%255 + 1)
			candidate := airplay.MulticastAddress(suffix)
			var inUse bool
			if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM external_presentation_sessions WHERE multicast_address=$1::inet AND status IN ('preparing','waiting','active','stopping'))`, candidate).Scan(&inUse); err != nil {
				s.internalError(w, r, err)
				return
			}
			if !inUse {
				multicastAddress = candidate
				break
			}
		}
		if multicastAddress == "" {
			transport = "unicast"
		}
	}
	record := airplaySessionRecord{ID: sessionID, OrganizationID: org, Provider: "airplay", Status: "preparing", TargetType: input.TargetType, TargetID: input.TargetID, GatewayID: gatewayID, AudioID: audioID, ReceiverName: targetName, PIN: pin, DeviceID: deviceID, ExpiresAt: expiresAt, CreatedBy: &user.ID, CreatedAt: now, Transport: transport, Multicast: multicastAddress, VideoPort: airplay.VideoPort, AudioPort: airplay.AudioPort, Profile: string(profile), AudioMode: input.AudioMode, PresentationNetworkID: sessionNetworkID, PresentationNetworkName: sessionNetworkName}
	// Group preparation is bounded by a deadline stored with the session, not by
	// a timer in this process. A restart mid-preparation must neither lose the
	// bound nor restart it.
	// A gateway that also has to authenticate to WPA2-Enterprise and take a DHCP
	// lease needs a longer window than one that only starts a process. The bound
	// stays durable — it is stamped into the row, not held in a timer — so a
	// restart mid-preparation neither loses it nor restarts it, and a session with
	// no Presentation Network keeps exactly the window it had before.
	var prepareDeadline *time.Time
	if input.TargetType == "group" {
		deadline := airplay.PreparationDeadline(now, sessionNetworkID != nil)
		prepareDeadline = &deadline
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO external_presentation_sessions(id,organization_id,provider,status,target_type,target_id,gateway_screen_id,audio_screen_id,receiver_name,pin,device_id,expires_at,created_by,transport,multicast_address,video_port,audio_port,video_profile,audio_mode,prepare_deadline_at,presentation_network_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULLIF($15,'')::inet,$16,$17,$18,$19,$20,$21)`, record.ID, record.OrganizationID, record.Provider, record.Status, record.TargetType, record.TargetID, record.GatewayID, record.AudioID, record.ReceiverName, record.PIN, record.DeviceID, record.ExpiresAt, user.ID, record.Transport, record.Multicast, record.VideoPort, record.AudioPort, record.Profile, record.AudioMode, prepareDeadline, record.PresentationNetworkID); err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, screen := range screens {
		role := "receiver"
		if screen.ID == gatewayID {
			if input.TargetType == "screen" {
				role = "single"
			} else {
				role = "gateway"
			}
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO external_presentation_screen_states(session_id,screen_id,role,state) VALUES($1,$2,$3,'preparing')`, record.ID, screen.ID, role); err != nil {
			s.internalError(w, r, err)
			return
		}
		// The session assignment is server-owned. Persist it before the player
		// receives a command so a delayed heartbeat from an older presentation
		// cannot claim the newly selected screen while its status row is still
		// empty.
		if _, err = tx.Exec(r.Context(), `INSERT INTO screen_player_status(screen_id,external_presentation_state,external_presentation_session_id,external_presentation_role,airplay_receiver_state,airplay_transport,airplay_connected,external_presentation_expires_at)
			VALUES($1,'preparing',$2,$3,'preparing',$4,false,$5)
			ON CONFLICT(screen_id) DO UPDATE SET
				external_presentation_state=EXCLUDED.external_presentation_state,
				external_presentation_session_id=EXCLUDED.external_presentation_session_id,
				external_presentation_role=EXCLUDED.external_presentation_role,
				airplay_receiver_state=EXCLUDED.airplay_receiver_state,
				airplay_transport=EXCLUDED.airplay_transport,
				airplay_connected=EXCLUDED.airplay_connected,
				external_presentation_expires_at=EXCLUDED.external_presentation_expires_at`, screen.ID, record.ID, role, record.Transport, record.ExpiresAt); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, screen := range screens {
		role := "receiver"
		phase := "prepare"
		if screen.ID == gatewayID {
			if input.TargetType == "screen" {
				role = "single"
				phase = "start"
			} else {
				role = "gateway"
			}
		}
		payload := airplayCommandPayload(record, role, phase, screens)
		validated, validationErr := s.validateCommand("prepare_airplay_session", mustJSON(payload))
		if validationErr != nil {
			s.failAirplaySession(r.Context(), record.ID, user.ID, "invalid_command_payload")
			writeError(w, 422, "airplay_command_invalid", validationErr.Error())
			return
		}
		if _, _, queueErr := s.queueCommand(r.Context(), screen.ID, user.ID, "prepare_airplay_session", validated, uuid.New()); queueErr != nil {
			s.failAirplaySession(r.Context(), record.ID, user.ID, "command_queue_failed")
			writeError(w, 422, "airplay_activation_failed", "Tilecast could not queue AirPlay preparation for every display.")
			return
		}
		s.devices.Notify(screen.ID, map[string]any{"type": "external_presentation.changed", "sessionId": record.ID})
	}
	if input.TargetType == "group" {
		// Nothing is ready yet, so this is normally a no-op. It keeps activation
		// and recovery on one code path, and it releases a one-member group
		// immediately if its only participant already reported.
		s.reconcileAirplaySession(r.Context(), record.ID)
	}
	writeJSON(w, 202, map[string]any{"data": s.airplaySessionResponse(r.Context(), record, screens)})
}

func (s *server) getAirplaySession(w http.ResponseWriter, r *http.Request) {
	s.expireAirplaySessions(r.Context())
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	record, err := s.getAirplayRecord(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "airplay_session_not_found", "AirPlay session was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !s.authorizeAirplayRecord(w, r, record) {
		return
	}
	writeJSON(w, 200, map[string]any{"data": s.airplaySessionResponse(r.Context(), record, nil)})
}

func (s *server) stopAirplaySession(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if len(body.Reason) > 120 {
		writeError(w, 422, "airplay_reason_invalid", "The AirPlay stop reason is too long.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	record, err := s.getAirplayRecord(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "airplay_session_not_found", "AirPlay session was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !s.authorizeAirplayRecord(w, r, record) {
		return
	}
	if record.Status == "ended" || record.Status == "expired" || record.Status == "failed" {
		writeJSON(w, 200, map[string]any{"data": s.airplaySessionResponse(r.Context(), record, nil)})
		return
	}
	if err := s.stopAirplaySessionInternal(r.Context(), record, user.ID, strings.TrimSpace(body.Reason)); err != nil {
		s.internalError(w, r, err)
		return
	}
	record, err = s.getAirplayRecord(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": s.airplaySessionResponse(r.Context(), record, nil)})
}

func (s *server) loadAirplayTarget(ctx context.Context, targetType string, targetID uuid.UUID) (uuid.UUID, string, *uuid.UUID, []airplayTargetScreen, error) {
	var org uuid.UUID
	var name string
	var preferred *uuid.UUID
	if targetType == "screen" {
		if err := s.db.QueryRow(ctx, `SELECT organization_id,name FROM screens WHERE id=$1 AND archived_at IS NULL`, targetID).Scan(&org, &name); err != nil {
			return uuid.Nil, "", nil, nil, err
		}
	} else {
		if err := s.db.QueryRow(ctx, `SELECT organization_id,name,presentation_gateway_screen_id FROM screen_groups WHERE id=$1 AND deleted_at IS NULL`, targetID).Scan(&org, &name, &preferred); err != nil {
			return uuid.Nil, "", nil, nil, err
		}
	}
	where := `sc.id=$1`
	args := []any{targetID}
	if targetType == "group" {
		where = `EXISTS(SELECT 1 FROM screen_group_memberships gm WHERE gm.screen_group_id=$1 AND gm.screen_id=sc.id)`
	}
	rows, err := s.db.Query(ctx, `SELECT `+airplayScreenColumns+` FROM screens sc `+airplayScreenJoins+` WHERE sc.organization_id=$2 AND sc.archived_at IS NULL AND `+where+` ORDER BY lower(sc.name),sc.id`, append(args, org)...)
	if err != nil {
		return uuid.Nil, "", nil, nil, err
	}
	defer rows.Close()
	screens := []airplayTargetScreen{}
	for rows.Next() {
		var screen airplayTargetScreen
		if err := scanAirplayTargetScreen(rows, &screen); err != nil {
			return uuid.Nil, "", nil, nil, err
		}
		screens = append(screens, screen)
	}
	return org, name, preferred, screens, rows.Err()
}

// airplayScreenColumns and airplayScreenJoins are shared by the two places that
// load AirPlay participants — session creation and session reads — so the two
// cannot drift. A missing Presentation Network column in one of them would look
// like an unassigned screen, which is precisely the difference between "keep
// existing Ethernet behavior" and "join the sender's Wi-Fi".
//
// network_link_type is still the telemetry view of the *default-route* interface,
// which is what `Wired` means here. wired_ipv4 is the separate, explicit fact
// AirPlay transport uses.
const airplayScreenColumns = `sc.id,sc.name,sc.platform,COALESCE(host(sc.last_known_ip),''),sc.enabled,
	COALESCE(sc.last_heartbeat_at>now()-interval '5 minutes',false),
	COALESCE(ps.airplay_supported,false),COALESCE(ps.airplay_group_supported,false),
	COALESCE(ps.airplay_audio_available,false),COALESCE(ps.airplay_hardware_decode,false),
	COALESCE(NULLIF(ps.airplay_max_profile,''),'unsupported'),COALESCE(ps.airplay_multicast_supported,false),
	COALESCE(ts.network_link_type='ethernet',false),
	pna.presentation_network_id,COALESCE(pn.name,''),
	COALESCE(
		ps.presentation_network_supported
		AND ps.presentation_network_helper_state='ok'
		AND ps.presentation_network_manager_available
		AND ps.presentation_network_wifi_adapter
		AND ps.presentation_network_state IN ('provisioned','connected')
		AND ps.presentation_network_installed_id=pna.presentation_network_id
		AND ps.presentation_network_installed_revision=pn.config_revision,
		false),
	COALESCE(ps.presentation_network_wifi_adapter,false),
	ps.presentation_network_supported IS NOT NULL,
	COALESCE(host(ps.wired_ipv4),''),ps.wired_ipv4 IS NOT NULL`

const airplayScreenJoins = `LEFT JOIN screen_player_status ps ON ps.screen_id=sc.id
	LEFT JOIN screen_telemetry_snapshots ts ON ts.screen_id=sc.id
	LEFT JOIN screen_presentation_networks pna ON pna.screen_id=sc.id
	LEFT JOIN presentation_networks pn ON pn.id=pna.presentation_network_id`

func scanAirplayTargetScreen(rows pgx.Rows, screen *airplayTargetScreen) error {
	return rows.Scan(&screen.ID, &screen.Name, &screen.Platform, &screen.LastKnownIP,
		&screen.Enabled, &screen.Online, &screen.AirPlaySupported, &screen.GroupSupported,
		&screen.AudioAvailable, &screen.HardwareDecode, &screen.MaxProfile,
		&screen.MulticastSupported, &screen.Wired,
		&screen.PresentationNetworkID, &screen.PresentationNetworkName,
		&screen.PresentationNetworkReady, &screen.WifiAdapterPresent,
		&screen.PresentationNetworkReported, &screen.WiredIPv4, &screen.WiredIPv4Reported)
}

func airplayScreenByID(screens []airplayTargetScreen, id string) *airplayTargetScreen {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return nil
	}
	for index := range screens {
		if screens[index].ID == parsed {
			return &screens[index]
		}
	}
	return nil
}

// airplayWiredAddressError decides whether this display has an address group
// video may be sent to, and says precisely what is missing when it does not.
//
// Three cases, in order:
//
//   - The player reported an explicit wired IPv4 address. Use it. This is the only
//     value that stays unambiguous once a display can hold a temporary Wi-Fi
//     address as well, and it is what prevents a Presentation Network address from
//     accidentally becoming a GStreamer RTP destination.
//   - The player reported nothing, and no Presentation Network is involved. Fall
//     back to last_known_ip exactly as before, so upgrading the server does not
//     break group AirPlay for a fleet whose players have not upgraded yet.
//   - The player reported nothing and a Presentation Network *is* involved. Refuse
//     with a precise error. This is the one situation where the historical address
//     is genuinely ambiguous, and guessing would send a room's video to a Wi-Fi
//     interface or to nowhere.
func airplayWiredAddressError(screen airplayTargetScreen, presentationNetworkRequired bool) (string, string) {
	if airplay.ValidWiredIPv4(screen.WiredIPv4) {
		return "", ""
	}
	if presentationNetworkRequired || screen.WiredIPv4Reported {
		return "airplay_wired_address_unavailable", fmt.Sprintf(
			"%s has not reported a usable Ethernet IPv4 address for group video fan-out. Group AirPlay sends compressed video over Ethernet, so every display needs one.",
			screen.Name)
	}
	switch {
	case screen.LastKnownIP == "":
		return "airplay_ip_unavailable", fmt.Sprintf("%s has no current LAN address for group video fan-out.", screen.Name)
	case !airplay.ValidWiredIPv4(screen.LastKnownIP):
		return "airplay_ip_invalid", fmt.Sprintf("%s has no usable IPv4 LAN address for group video fan-out.", screen.Name)
	}
	return "", ""
}

func boolPointer(value bool) *bool { return &value }

func cleanAirplayReceiverName(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > 120 {
		runes = runes[:120]
	}
	if len(runes) == 0 {
		return "Tilecast AirPlay"
	}
	return string(runes)
}

func uuidString(value *uuid.UUID) string {
	if value == nil {
		return ""
	}
	return value.String()
}

func airplayAudioScreenID(record airplaySessionRecord) string {
	if record.AudioID != nil {
		return record.AudioID.String()
	}
	// The player still receives an identity when audio is disabled; v1 simply
	// does not enable an audio forwarding path.
	return record.GatewayID.String()
}

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

func airplayCommandPayload(record airplaySessionRecord, role, phase string, screens []airplayTargetScreen) map[string]any {
	destinations := []map[string]any{}
	if role == "gateway" {
		for _, screen := range screens {
			// The explicitly reported Ethernet address, never the temporary
			// Presentation Network address. rtpHost() falls back to last_known_ip
			// only for a player that predates wired-address reporting, and session
			// creation has already refused that combination when a Presentation
			// Network is involved.
			host := screen.rtpHost()
			if screen.ID == record.GatewayID {
				// The gateway consumes its own forwarded stream locally, over the same
				// transport as the rest of the room.
				host = "127.0.0.1"
			}
			destinations = append(destinations, map[string]any{"screenId": screen.ID.String(), "host": host, "port": record.VideoPort})
		}
	}
	payload := map[string]any{
		"provider": "airplay", "sessionId": record.ID.String(), "role": role, "phase": phase,
		"targetType": record.TargetType, "targetId": record.TargetID.String(),
		"gatewayScreenId": record.GatewayID.String(), "audioScreenId": airplayAudioScreenID(record),
		"receiverName": record.ReceiverName, "pin": record.PIN, "deviceId": record.DeviceID,
		"expiresAt": record.ExpiresAt.UTC().Format(time.RFC3339Nano), "transport": record.Transport,
		"videoPort": record.VideoPort, "audioPort": record.AudioPort, "destinations": destinations,
		"multicastAddress": record.Multicast, "profile": record.Profile, "audioMode": record.AudioMode,
	}
	// Only the gateway is told to join a Presentation Network, and it is told the
	// identifier and revision — never the SSID's credential, which the player
	// fetches over its own authenticated no-store channel. A follower's payload
	// carries no Presentation Network field at all, so a follower can neither be
	// asked to join Wi-Fi nor learn which network the gateway used.
	if record.PresentationNetworkID != nil && (role == "gateway" || role == "single") {
		payload["presentationNetworkId"] = record.PresentationNetworkID.String()
	}
	return payload
}

func (s *server) getAirplayRecord(ctx context.Context, id uuid.UUID) (airplaySessionRecord, error) {
	return getAirplayRecordFrom(ctx, s.db, id)
}

func getAirplayRecordFrom(ctx context.Context, q airplayQuerier, id uuid.UUID) (airplaySessionRecord, error) {
	var record airplaySessionRecord
	// host(), not ::text: casting an inet to text appends the netmask, and
	// "239.255.42.7/32" is neither a valid multicast address in the command
	// payload nor something the player's validator accepts.
	err := q.QueryRow(ctx, `SELECT ep.id,ep.organization_id,ep.provider,ep.status,ep.target_type,ep.target_id,ep.gateway_screen_id,ep.audio_screen_id,ep.receiver_name,COALESCE(ep.pin,''),COALESCE(ep.device_id,''),ep.expires_at,ep.created_by,ep.created_at,ep.ended_at,COALESCE(ep.end_reason,''),ep.transport,COALESCE(host(ep.multicast_address),''),ep.video_port,ep.audio_port,ep.video_profile,ep.audio_mode,ep.presentation_network_id,COALESCE(pn.name,'') FROM external_presentation_sessions ep LEFT JOIN presentation_networks pn ON pn.id=ep.presentation_network_id WHERE ep.id=$1`, id).Scan(&record.ID, &record.OrganizationID, &record.Provider, &record.Status, &record.TargetType, &record.TargetID, &record.GatewayID, &record.AudioID, &record.ReceiverName, &record.PIN, &record.DeviceID, &record.ExpiresAt, &record.CreatedBy, &record.CreatedAt, &record.EndedAt, &record.EndReason, &record.Transport, &record.Multicast, &record.VideoPort, &record.AudioPort, &record.Profile, &record.AudioMode, &record.PresentationNetworkID, &record.PresentationNetworkName)
	return record, err
}

func (s *server) airplaySessionResponse(ctx context.Context, record airplaySessionRecord, knownScreens []airplayTargetScreen) map[string]any {
	states := []airplaySessionState{}
	rows, err := s.db.Query(ctx, `SELECT st.screen_id,sc.name,st.role,st.state,st.last_updated_at,st.failure_code,st.safe_failure_message,
		CASE WHEN st.role IN ('gateway','single') THEN ps.presentation_network_state ELSE NULL END
		FROM external_presentation_screen_states st
		JOIN screens sc ON sc.id=st.screen_id
		LEFT JOIN screen_player_status ps ON ps.screen_id=st.screen_id
		WHERE st.session_id=$1 ORDER BY lower(sc.name),sc.id`, record.ID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var state airplaySessionState
			if rows.Scan(&state.ScreenID, &state.ScreenName, &state.Role, &state.State, &state.LastUpdatedAt, &state.FailureCode, &state.FailureMessage, &state.PresentationNetworkState) == nil {
				states = append(states, state)
			}
		}
	}
	ready, connected, failed := 0, 0, 0
	for _, state := range states {
		if state.State == "ready" || state.State == "waiting" || state.State == "connected" {
			ready++
		}
		if state.State == "connected" {
			connected++
		}
		if state.State == "failed" || state.State == "degraded" {
			failed++
		}
	}
	result := map[string]any{
		"id": record.ID, "provider": record.Provider, "status": record.Status,
		"targetType": record.TargetType, "targetId": record.TargetID,
		"gatewayScreenId": record.GatewayID, "audioScreenId": record.AudioID,
		"receiverName": record.ReceiverName, "createdAt": record.CreatedAt, "expiresAt": record.ExpiresAt, "endedAt": record.EndedAt, "endReason": record.EndReason,
		"transport": record.Transport, "videoProfile": record.Profile, "audioMode": record.AudioMode,
		"screenCount": len(states), "readyCount": ready, "connectedCount": connected,
		"failedCount": failed, "screens": states,
		// The network the gateway joins, by name. Studio turns this into
		// "Joining District Staff Wi-Fi…" during preparation so the dialog is not
		// stuck on a generic "Preparing". The credential is not here, and the SSID
		// is not here either — the display name is what an operator recognizes.
		"presentationNetworkId":   record.PresentationNetworkID,
		"presentationNetworkName": record.PresentationNetworkName,
	}
	if record.Status == "preparing" || record.Status == "waiting" || record.Status == "active" {
		if record.PIN != "" {
			result["pin"] = record.PIN
		}
	}
	if knownScreens != nil {
		result["screenCount"] = len(knownScreens)
	}
	return result
}

func (s *server) airplaySessionScreens(ctx context.Context, sessionID uuid.UUID) ([]airplayTargetScreen, error) {
	return airplaySessionScreensFrom(ctx, s.db, sessionID)
}

func airplaySessionScreensFrom(ctx context.Context, q airplayQuerier, sessionID uuid.UUID) ([]airplayTargetScreen, error) {
	rows, err := q.Query(ctx, `SELECT `+airplayScreenColumns+` FROM external_presentation_screen_states st JOIN screens sc ON sc.id=st.screen_id `+airplayScreenJoins+` WHERE st.session_id=$1 ORDER BY lower(sc.name),sc.id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []airplayTargetScreen{}
	for rows.Next() {
		var screen airplayTargetScreen
		if err := scanAirplayTargetScreen(rows, &screen); err != nil {
			return nil, err
		}
		result = append(result, screen)
	}
	return result, rows.Err()
}

func (s *server) activeAirplaySessionForScreens(ctx context.Context, screenIDs []uuid.UUID) (*uuid.UUID, error) {
	if len(screenIDs) == 0 {
		return nil, nil
	}
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT ep.id FROM external_presentation_sessions ep JOIN external_presentation_screen_states st ON st.session_id=ep.id WHERE st.screen_id=ANY($1) AND ep.status IN ('preparing','waiting','active','stopping') ORDER BY ep.created_at DESC LIMIT 1`, screenIDs).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (s *server) authorizeAirplayRecord(w http.ResponseWriter, r *http.Request, record airplaySessionRecord) bool {
	screens, err := s.airplaySessionScreens(r.Context(), record.ID)
	if err != nil {
		s.internalError(w, r, err)
		return false
	}
	ids := make([]uuid.UUID, 0, len(screens))
	for _, screen := range screens {
		ids = append(ids, screen.ID)
	}
	return s.authorizeScreenList(w, r, ids, nil)
}

func (s *server) stopAirplaySessionInternal(ctx context.Context, record airplaySessionRecord, userID uuid.UUID, reason string) error {
	if reason == "" {
		reason = "stopped"
	}
	screens, err := s.airplaySessionScreens(ctx, record.ID)
	if err != nil {
		return err
	}

	// "stopping" is a durable, retryable intermediate state. If a previous
	// request reached it but failed to enqueue cleanup or finish database
	// cleanup, a later stop retries the remaining work instead of reporting a
	// false success.
	if record.Status != "stopping" {
		tag, err := s.db.Exec(ctx, `UPDATE external_presentation_sessions SET status='stopping',end_reason=$2 WHERE id=$1 AND status IN ('preparing','waiting','active')`, record.ID, reason)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Another stop/expiry/failure path already owns the terminal
			// transition. The caller reloads the authoritative state.
			return nil
		}
	}

	if _, err := s.db.Exec(ctx, `UPDATE player_commands SET state='cancelled',completed_at=now(),updated_at=now(),safe_result_code='airplay_session_stopped',safe_result_message='The AirPlay session ended before this command was delivered.' WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1 AND state IN ('pending','delivered','acknowledged','running')`, record.ID.String()); err != nil {
		return err
	}
	stopPayload, err := s.validateCommand("stop_airplay_session", mustJSON(map[string]any{"sessionId": record.ID.String(), "reason": reason}))
	if err != nil {
		return err
	}
	for _, screen := range screens {
		if err := s.queueAirplayStopCommand(ctx, record.OrganizationID, screen.ID, userID, stopPayload); err != nil {
			return err
		}
		if s.devices != nil {
			s.devices.Notify(screen.ID, map[string]any{"type": "external_presentation.changed", "sessionId": record.ID})
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE external_presentation_screen_states SET state='stopped',last_updated_at=now(),failure_code=NULL,safe_failure_message=NULL WHERE session_id=$1`, record.ID); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE screen_player_status SET external_presentation_state=NULL,external_presentation_session_id=NULL,external_presentation_role=NULL,airplay_receiver_state=NULL,airplay_transport=NULL,airplay_connected=NULL,external_presentation_expires_at=NULL WHERE external_presentation_session_id=$1`, record.ID); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE external_presentation_sessions SET status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'ended' END,ended_at=COALESCE(ended_at,now()),end_reason=COALESCE(end_reason,$2),pin=NULL,device_id=NULL WHERE id=$1 AND status='stopping'`, record.ID, reason); err != nil {
		return err
	}
	// Do not retain the PIN/device identity in the persistent command history.
	if _, err := s.db.Exec(ctx, `UPDATE player_commands SET payload='{}'::jsonb WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1`, record.ID.String()); err != nil {
		return err
	}
	return nil
}

// queueAirplayStopCommand also handles server-owned cleanup. A session can
// outlive its Studio creator, so expiry and failure recovery must still be
// able to deliver a stop command without inventing a user identity.
func (s *server) queueAirplayStopCommand(ctx context.Context, organizationID, screenID, userID uuid.UUID, payload []byte) error {
	// Teardown is already authorized by the session transition. It must not be
	// blocked by the ordinary user-command quota: leaving the player in a local
	// AirPlay process after the server has ended the session is worse than adding
	// one bounded cleanup command. Keep the command durable and deduplicated by
	// session instead of routing it through queueCommand.
	var createdBy any
	if userID != uuid.Nil {
		createdBy = userID
	}
	var commandID uuid.UUID
	err := s.db.QueryRow(ctx, `INSERT INTO player_commands(id,organization_id,screen_id,type,payload,idempotency_key,created_by,expires_at)
		SELECT $1,$2,$3,'stop_airplay_session',$4::jsonb,$5,$6,now()+interval '5 minutes'
		WHERE NOT EXISTS(
			SELECT 1 FROM player_commands
			WHERE screen_id=$3 AND type='stop_airplay_session'
			  AND payload->>'sessionId'=$7
			  AND state IN ('pending','delivered','acknowledged','running','succeeded')
		) RETURNING id`, uuid.New(), organizationID, screenID, string(payload), uuid.New(), createdBy, extractAirplaySessionID(payload)).Scan(&commandID)
	if errors.Is(err, pgx.ErrNoRows) {
		// A live cleanup command already exists. The caller can still wake the
		// player below; no second command or audit entry is needed.
		err = nil
	}
	if err == nil && commandID != uuid.Nil && userID != uuid.Nil {
		// queueCommand records the same action for dashboard-created commands.
		// Keep that audit trail when this specialized teardown path is used for a
		// manual stop; server-owned expiry/failure commands have no actor.
		_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'command.created','player_command',$3)`, uuid.New(), userID, commandID.String())
	}
	if err == nil && s.devices != nil {
		// This path intentionally bypasses queueCommand's quota and audit logic,
		// so it must retain the socket wake that makes a newly inserted cleanup
		// command prompt. The player's periodic poll remains the backstop.
		s.devices.Notify(screenID, map[string]any{"type": "commands.available"})
	}
	return err
}

func extractAirplaySessionID(payload []byte) string {
	var value struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(payload, &value) != nil {
		return ""
	}
	return value.SessionID
}

// AirPlay is priority 2, immediately below emergency takeover. Querying the
// session through screen states means a takeover affecting one group member
// stops the complete room session rather than leaving a partially mirrored
// room behind.
func (s *server) stopAirplayForScreens(ctx context.Context, screens []uuid.UUID, userID uuid.UUID, reason string) {
	if len(screens) == 0 {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT DISTINCT ep.id FROM external_presentation_sessions ep JOIN external_presentation_screen_states st ON st.session_id=ep.id WHERE st.screen_id=ANY($1) AND ep.status IN ('preparing','waiting','active','stopping')`, screens)
	if err != nil {
		return
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		record, err := s.getAirplayRecord(ctx, id)
		if err == nil {
			if stopErr := s.stopAirplaySessionInternal(ctx, record, userID, reason); stopErr != nil && s.logger != nil {
				s.logger.Error("AirPlay stop cleanup failed", "session_id", record.ID, "error", stopErr)
			}
		}
	}
}

func (s *server) failAirplaySession(ctx context.Context, sessionID, userID uuid.UUID, reason string) {
	record, err := s.getAirplayRecord(ctx, sessionID)
	if err != nil {
		return
	}
	if record.Status == "ended" || record.Status == "expired" || record.Status == "failed" {
		return
	}
	if record.Status == "stopping" {
		// Stop owns this transition. A late follower/gateway failure must not
		// reopen it through multicast fallback or replace the user's reason.
		return
	}
	if record.TargetType == "group" && record.Transport == "multicast" {
		if s.fallbackAirplaySession(ctx, record, userID, reason) {
			return
		}
		// A second participant can report the same multicast failure while the
		// first report is already converting the session to unicast. Do not let
		// that loser turn the successful fallback into a terminal failure.
		latest, latestErr := s.getAirplayRecord(ctx, sessionID)
		if latestErr == nil && latest.Transport == "unicast" && latest.Status != "ended" && latest.Status != "expired" && latest.Status != "failed" && latest.Status != "stopping" {
			return
		}
	}
	screens, err := s.airplaySessionScreens(ctx, sessionID)
	if err != nil {
		return
	}
	tag, updateErr := s.db.Exec(ctx, `UPDATE external_presentation_sessions SET status='failed',ended_at=COALESCE(ended_at,now()),end_reason=$2,pin=NULL,device_id=NULL WHERE id=$1 AND status IN ('preparing','waiting','active')`, sessionID, reason)
	if updateErr != nil || tag.RowsAffected() == 0 {
		// A concurrent stop or another failure path won the terminal transition.
		return
	}
	_, _ = s.db.Exec(ctx, `UPDATE external_presentation_screen_states SET state='failed',last_updated_at=now(),failure_code=$2,safe_failure_message='AirPlay could not prepare every participating display.' WHERE session_id=$1`, sessionID, reason)
	_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET external_presentation_state=NULL,external_presentation_session_id=NULL,external_presentation_role=NULL,airplay_receiver_state=NULL,airplay_transport=NULL,airplay_connected=NULL,external_presentation_expires_at=NULL WHERE external_presentation_session_id=$1`, sessionID)
	_, _ = s.db.Exec(ctx, `UPDATE player_commands SET state='cancelled',completed_at=now(),updated_at=now(),safe_result_code=$2,safe_result_message='The AirPlay session failed during preparation.' WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1 AND state IN ('pending','delivered','acknowledged','running')`, sessionID.String(), reason)
	stopPayload, _ := s.validateCommand("stop_airplay_session", mustJSON(map[string]any{"sessionId": sessionID.String(), "reason": reason}))
	for _, screen := range screens {
		s.queueAirplayStopCommand(ctx, record.OrganizationID, screen.ID, userID, stopPayload)
		s.devices.Notify(screen.ID, map[string]any{"type": "external_presentation.changed", "sessionId": sessionID})
	}
	_, _ = s.db.Exec(ctx, `UPDATE player_commands SET payload='{}'::jsonb WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1`, sessionID.String())
}

// fallbackAirplaySession converts a multicast group to unicast fan-out while
// preserving the same temporary receiver identity and expiration. It is only
// attempted once: after the session transport is unicast, a later preparation
// failure is terminal. This keeps multicast an optimization rather than a
// single point of failure.
func (s *server) fallbackAirplaySession(ctx context.Context, record airplaySessionRecord, userID uuid.UUID, reason string) bool {
	if record.TargetType != "group" || record.Transport != "multicast" {
		return false
	}
	// player_commands.created_by is a nullable user reference, but the command
	// coordinator still requires a concrete actor for its audit/idempotency path.
	// A deleted creator therefore gets a terminal failure instead of a half-
	// reconfigured session.
	if userID == uuid.Nil {
		return false
	}
	screens, err := s.airplaySessionScreens(ctx, record.ID)
	if err != nil || len(screens) == 0 {
		return false
	}
	// The fallback restarts preparation, so it also restarts the durable
	// preparation deadline. Reusing the original one would fail the unicast
	// attempt immediately whenever multicast burned the first window.
	// The fallback restarts preparation, so it re-stamps the deadline using the
	// same rule as creation: a session whose gateway must also join a Presentation
	// Network gets the longer window on the retry too.
	fallbackWindow := airplay.PreparationDeadline(time.Now(), record.PresentationNetworkID != nil).Sub(time.Now())
	if tag, execErr := s.db.Exec(ctx, `UPDATE external_presentation_sessions SET transport='unicast',multicast_address=NULL,status='preparing',ended_at=NULL,end_reason=NULL,prepare_deadline_at=now()+make_interval(secs=>$2) WHERE id=$1 AND status IN ('preparing','waiting','active') AND transport='multicast'`, record.ID, fallbackWindow.Seconds()); execErr != nil || tag.RowsAffected() != 1 {
		return false
	}
	_, _ = s.db.Exec(ctx, `UPDATE player_commands SET state='cancelled',completed_at=now(),updated_at=now(),safe_result_code='airplay_transport_fallback',safe_result_message='Multicast was unavailable; Tilecast is restarting this session over unicast.' WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1 AND state IN ('pending','delivered','acknowledged','running')`, record.ID.String())
	_, _ = s.db.Exec(ctx, `UPDATE player_commands SET payload='{}'::jsonb WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1`, record.ID.String())
	_, _ = s.db.Exec(ctx, `UPDATE external_presentation_screen_states SET state='preparing',last_updated_at=now(),failure_code='multicast_fallback',safe_failure_message='Multicast was unavailable; preparing a unicast receiver.' WHERE session_id=$1`, record.ID)
	stopPayload, _ := s.validateCommand("stop_airplay_session", mustJSON(map[string]any{"sessionId": record.ID.String(), "reason": "multicast_fallback"}))
	for _, screen := range screens {
		_ = s.queueAirplayStopCommand(ctx, record.OrganizationID, screen.ID, userID, stopPayload)
		s.devices.Notify(screen.ID, map[string]any{"type": "external_presentation.changed", "sessionId": record.ID})
	}
	reconfigured := record
	reconfigured.Transport = "unicast"
	reconfigured.Multicast = ""
	for _, screen := range screens {
		role := "receiver"
		phase := "prepare"
		if screen.ID == record.GatewayID {
			role = "gateway"
		}
		payload := airplayCommandPayload(reconfigured, role, phase, screens)
		validated, validationErr := s.validateCommand("prepare_airplay_session", mustJSON(payload))
		if validationErr != nil {
			s.failAirplaySession(ctx, record.ID, userID, "multicast_fallback_invalid")
			return false
		}
		if _, _, queueErr := s.queueCommand(ctx, screen.ID, userID, "prepare_airplay_session", validated, uuid.New()); queueErr != nil {
			s.failAirplaySession(ctx, record.ID, userID, "multicast_fallback_queue_failed")
			return false
		}
	}
	s.logger.Warn("AirPlay multicast failed; restarting group over unicast", "session_id", record.ID, "reason", reason)
	s.reconcileAirplaySession(ctx, record.ID)
	return true
}

func (s *server) fallbackAirplayForScreen(ctx context.Context, screenID uuid.UUID) {
	rows, err := s.db.Query(ctx, `SELECT ep.id,ep.created_by FROM external_presentation_sessions ep JOIN external_presentation_screen_states st ON st.session_id=ep.id WHERE ep.transport='multicast' AND ep.status IN ('preparing','waiting','active') AND st.screen_id=$1 AND st.state IN ('failed','degraded')`, screenID)
	if err != nil {
		return
	}
	type sessionRef struct {
		id        uuid.UUID
		createdBy *uuid.UUID
	}
	refs := make([]sessionRef, 0)
	for rows.Next() {
		var sessionID uuid.UUID
		var createdBy *uuid.UUID
		if rows.Scan(&sessionID, &createdBy) != nil {
			continue
		}
		refs = append(refs, sessionRef{id: sessionID, createdBy: createdBy})
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	for _, ref := range refs {
		sessionID, createdBy := ref.id, ref.createdBy
		record, recordErr := s.getAirplayRecord(ctx, sessionID)
		if recordErr != nil {
			continue
		}
		actor := uuid.Nil
		if createdBy != nil {
			actor = *createdBy
		}
		if !s.fallbackAirplaySession(ctx, record, actor, "multicast_receiver_degraded") {
			// If another heartbeat won the fallback race, the session is already
			// unicast and should be left alone. Otherwise fail it explicitly rather
			// than leaving a multicast session in degraded limbo.
			latest, latestErr := s.getAirplayRecord(ctx, sessionID)
			if latestErr == nil && latest.Transport == "multicast" {
				s.failAirplaySession(ctx, sessionID, actor, "multicast_fallback_failed")
			}
		}
	}
}

func (s *server) expireAirplaySessions(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT id,created_by FROM external_presentation_sessions WHERE status IN ('preparing','waiting','active','stopping') AND expires_at<=now()`)
	if err != nil {
		return
	}
	type sessionRef struct {
		id        uuid.UUID
		createdBy *uuid.UUID
	}
	refs := make([]sessionRef, 0)
	for rows.Next() {
		var id uuid.UUID
		var userID *uuid.UUID
		if rows.Scan(&id, &userID) == nil {
			refs = append(refs, sessionRef{id: id, createdBy: userID})
		}
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	for _, ref := range refs {
		record, recordErr := s.getAirplayRecord(ctx, ref.id)
		if recordErr != nil {
			continue
		}
		actor := uuid.Nil
		if ref.createdBy != nil {
			actor = *ref.createdBy
		}
		if stopErr := s.stopAirplaySessionInternal(ctx, record, actor, "expired"); stopErr != nil && s.logger != nil {
			s.logger.Error("AirPlay expiry cleanup failed", "session_id", record.ID, "error", stopErr)
		}
	}
}

func (s *server) writeAirplayError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "airplay_target_not_found", "The selected screen or group was not found.")
		return
	}
	s.internalError(w, r, err)
}

func (s *server) recordAirplayCommandResult(ctx context.Context, commandID uuid.UUID, state, code, message string) {
	var typ string
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT type,payload FROM player_commands WHERE id=$1`, commandID).Scan(&typ, &raw); err != nil || typ != "prepare_airplay_session" {
		return
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return
	}
	sessionID, err := uuid.Parse(fmt.Sprint(payload["sessionId"]))
	if err != nil {
		return
	}
	if state == "succeeded" {
		// Player command completion is immediate, while heartbeats are periodic.
		// Mark the display ready here so reconciliation can release the gateway
		// without waiting for the next heartbeat interval.
		_, _ = s.db.Exec(ctx, `UPDATE external_presentation_screen_states SET state='waiting',last_updated_at=now(),failure_code=NULL,safe_failure_message=NULL WHERE session_id=$1 AND screen_id=(SELECT screen_id FROM player_commands WHERE id=$2) AND EXISTS(SELECT 1 FROM external_presentation_sessions WHERE id=$1 AND status IN ('preparing','waiting','active'))`, sessionID, commandID)
		s.reconcileAirplaySession(ctx, sessionID)
		return
	}
	role := fmt.Sprint(payload["role"])
	_, _ = s.db.Exec(ctx, `UPDATE external_presentation_screen_states SET state='failed',last_updated_at=now(),failure_code=$3,safe_failure_message=$4 WHERE session_id=$1 AND screen_id=(SELECT screen_id FROM player_commands WHERE id=$2) AND EXISTS(SELECT 1 FROM external_presentation_sessions WHERE id=$1 AND status IN ('preparing','waiting','active'))`, sessionID, commandID, codeOrDefault(code, "airplay_command_failed"), safeAirplayMessage(message))
	if role == "gateway" || role == "single" {
		record, recordErr := s.getAirplayRecord(ctx, sessionID)
		if recordErr == nil {
			actor := uuid.Nil
			if record.CreatedBy != nil {
				actor = *record.CreatedBy
			}
			s.failAirplaySession(ctx, sessionID, actor, codeOrDefault(code, "airplay_command_failed"))
			return
		}
	}
	_, _ = s.db.Exec(ctx, `UPDATE player_commands SET payload='{}'::jsonb WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1`, sessionID.String())
}

func codeOrDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func safeAirplayMessage(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "The Linux player could not start the AirPlay process."
	}
	// By rune, like airplay_limitation: slicing bytes can cut a multi-byte
	// character in half, and Postgres rejects the invalid UTF-8 that produces.
	if runes := []rune(value); len(runes) > 240 {
		return string(runes[:240])
	}
	return value
}

func validateAirplayCommandPayload(typ string, object map[string]any) error {
	if typ == "stop_airplay_session" {
		allowed := map[string]bool{"sessionId": true, "reason": true}
		for key := range object {
			if !allowed[key] {
				return errors.New("AirPlay stop payload contains an unsupported field")
			}
		}
		if _, err := uuid.Parse(fmt.Sprint(object["sessionId"])); err != nil {
			return errors.New("AirPlay session ID is invalid")
		}
		if reason, ok := object["reason"].(string); ok && len(reason) > 120 {
			return errors.New("AirPlay stop reason is too long")
		}
		return nil
	}
	allowed := map[string]bool{"provider": true, "sessionId": true, "role": true, "phase": true, "targetType": true, "targetId": true, "gatewayScreenId": true, "audioScreenId": true, "receiverName": true, "pin": true, "deviceId": true, "expiresAt": true, "transport": true, "videoPort": true, "audioPort": true, "destinations": true, "multicastAddress": true, "profile": true, "audioMode": true, "presentationNetworkId": true}
	for key := range object {
		if !allowed[key] {
			return errors.New("AirPlay payload contains an unsupported field")
		}
	}
	for _, key := range []string{"provider", "sessionId", "role", "targetType", "targetId", "gatewayScreenId", "audioScreenId", "receiverName", "pin", "deviceId", "expiresAt", "transport", "profile", "audioMode"} {
		if value, ok := object[key].(string); !ok || strings.TrimSpace(value) == "" {
			return fmt.Errorf("AirPlay payload field %s is invalid", key)
		}
	}
	if object["provider"] != "airplay" || (object["role"] != "single" && object["role"] != "gateway" && object["role"] != "receiver") || (object["targetType"] != "screen" && object["targetType"] != "group") || (object["transport"] != "unicast" && object["transport"] != "multicast") || (object["profile"] != "1080p30" && object["profile"] != "720p30") || (object["audioMode"] != "gateway_only" && object["audioMode"] != "none") {
		return errors.New("AirPlay payload role, profile, or transport is invalid")
	}
	if phase, ok := object["phase"].(string); !ok || (phase != "prepare" && phase != "start") {
		return errors.New("AirPlay command phase is invalid")
	}
	if object["role"] == "receiver" && object["targetType"] != "group" || object["role"] == "gateway" && object["targetType"] != "group" {
		return errors.New("AirPlay group roles require a group target")
	}
	if object["role"] == "single" && object["targetType"] != "screen" {
		return errors.New("AirPlay single role requires a screen target")
	}
	if _, err := uuid.Parse(fmt.Sprint(object["sessionId"])); err != nil {
		return errors.New("AirPlay session ID is invalid")
	}
	if _, err := uuid.Parse(fmt.Sprint(object["targetId"])); err != nil {
		return errors.New("AirPlay target ID is invalid")
	}
	if _, err := uuid.Parse(fmt.Sprint(object["gatewayScreenId"])); err != nil {
		return errors.New("AirPlay gateway screen ID is invalid")
	}
	if _, err := uuid.Parse(fmt.Sprint(object["audioScreenId"])); err != nil {
		return errors.New("AirPlay audio screen ID is invalid")
	}
	if raw, present := object["presentationNetworkId"]; present {
		// An identifier and nothing else. A credential must never appear in a
		// durable command payload, and a follower must never carry this field.
		value, ok := raw.(string)
		if !ok {
			return errors.New("AirPlay Presentation Network ID is invalid")
		}
		if _, err := uuid.Parse(value); err != nil {
			return errors.New("AirPlay Presentation Network ID is invalid")
		}
		if object["role"] == "receiver" {
			return errors.New("an AirPlay group receiver must not be given a Presentation Network")
		}
	}
	if pin, ok := object["pin"].(string); !ok || !airplayPINPattern.MatchString(pin) {
		return errors.New("AirPlay PIN is invalid")
	}
	if deviceID, ok := object["deviceId"].(string); !ok || !validAirplayDeviceID(deviceID) {
		return errors.New("AirPlay device identity is invalid")
	}
	if _, err := time.Parse(time.RFC3339, fmt.Sprint(object["expiresAt"])); err != nil {
		return errors.New("AirPlay expiration is invalid")
	}
	if port, ok := object["videoPort"].(float64); !ok || port != airplay.VideoPort {
		return errors.New("AirPlay video port is invalid")
	}
	if port, ok := object["audioPort"].(float64); !ok || (port != airplay.AudioPort && port != 0) {
		return errors.New("AirPlay audio port is invalid")
	}
	if object["transport"] == "multicast" {
		address, ok := object["multicastAddress"].(string)
		if !ok || !airplayMulticastPattern.MatchString(address) {
			return errors.New("AirPlay multicast address is invalid")
		}
	}
	if destinations, ok := object["destinations"].([]any); ok {
		for _, item := range destinations {
			entry, ok := item.(map[string]any)
			if !ok {
				return errors.New("AirPlay destination is invalid")
			}
			host, hostOK := entry["host"].(string)
			port, portOK := entry["port"].(float64)
			if !hostOK || !airplayHostPattern.MatchString(host) || !portOK || port != airplay.VideoPort {
				return errors.New("AirPlay destination is invalid")
			}
			if _, err := uuid.Parse(fmt.Sprint(entry["screenId"])); err != nil {
				return errors.New("AirPlay destination screen ID is invalid")
			}
		}
	} else if object["role"] == "gateway" {
		return errors.New("AirPlay gateway destinations are required")
	}
	return nil
}

func validAirplayDeviceID(value string) bool {
	if !airplayDeviceIDPattern.MatchString(value) {
		return false
	}
	first, err := strconv.ParseUint(value[:2], 16, 8)
	return err == nil && first&0x02 != 0 && first&0x01 == 0
}
