package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/presentnet"
)

// Presentation Network management.
//
// Two rules shape every handler in this file:
//
//  1. A credential is write-only. It arrives in a request body, is sealed
//     immediately, and no read path — list, get, assignment, audit metadata,
//     error message, or log line — can produce it again. An absent `secret`
//     field on an update means "keep the stored one"; a present one rotates it
//     and bumps the configuration revision so assigned players re-provision.
//  2. Authorization matches the equivalent settings and screen operations:
//     Owner and Administrator, with CSRF on every mutation, and per-screen scope
//     checks whenever a specific screen is named.
const (
	// A CA certificate makes this body larger than the default request cap, but
	// it is still a bounded configuration document rather than an upload.
	presentationNetworkBodyLimit = 128 << 10
	// A bounded test has to fail rather than hang. Enterprise authentication plus
	// DHCP is slower than a process start, which is what this budget reflects.
	presentationNetworkTestWindow = 90 * time.Second
)

type presentationNetworkInput struct {
	Name     string `json:"name"`
	SSID     string `json:"ssid"`
	Hidden   bool   `json:"hidden"`
	Security string `json:"security"`
	// Secret is a pointer so "absent" and "empty string" are different requests.
	// Absent keeps the stored credential; empty is a validation error, because an
	// operator who cleared the field almost certainly did not mean "no password".
	Secret            *string `json:"secret"`
	Identity          string  `json:"identity"`
	AnonymousIdentity string  `json:"anonymousIdentity"`
	CACertificatePEM  string  `json:"caCertificatePem"`
	DomainSuffixMatch string  `json:"domainSuffixMatch"`
}

func (input presentationNetworkInput) toServiceInput() presentnet.Input {
	return presentnet.Input{
		Name:     input.Name,
		SSID:     input.SSID,
		Hidden:   input.Hidden,
		Security: presentnet.Security(strings.TrimSpace(strings.ToLower(input.Security))),
		Auth: presentnet.AuthMetadata{
			Identity:          input.Identity,
			AnonymousIdentity: input.AnonymousIdentity,
			CACertificatePEM:  input.CACertificatePEM,
			DomainSuffixMatch: input.DomainSuffixMatch,
		},
		Secret: input.Secret,
	}
}

// requirePresentationNetworks guards every route in this file. The service is
// only nil in a build assembled without it, which is not a state an operator can
// reach, but returning a typed error beats a panic.
func (s *server) requirePresentationNetworks(w http.ResponseWriter) bool {
	if s.presentationNetworks == nil {
		writeError(w, http.StatusNotImplemented, "presentation_networks_unavailable",
			"Presentation Networks are not available on this server.")
		return false
	}
	return true
}

func (s *server) listPresentationNetworks(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	networks, err := s.presentationNetworks.List(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"items": networks,
		// Studio needs to say why the Add button is unavailable rather than
		// letting an administrator fill a form that cannot be saved.
		"credentialsAvailable":         s.presentationNetworks.CredentialsAvailable(),
		"credentialsUnavailableReason": presentationNetworkKeyReason(s.presentationNetworks.CredentialsAvailable()),
		"supportedSecurity":            supportedSecurityOptions(),
	}})
}

func supportedSecurityOptions() []map[string]any {
	options := make([]map[string]any, 0, len(presentnet.SupportedSecurity))
	for _, security := range presentnet.SupportedSecurity {
		options = append(options, map[string]any{
			"value":      string(security),
			"label":      security.Label(),
			"enterprise": security.Enterprise(),
		})
	}
	return options
}

func presentationNetworkKeyReason(available bool) string {
	if available {
		return ""
	}
	return presentnet.KeyUnavailableMessage
}

func (s *server) getPresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	network, err := s.presentationNetworks.Get(r.Context(), id)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	assignments, err := s.presentationNetworks.AssignmentsFor(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"network":     network,
		"assignments": assignments,
	}})
}

func (s *server) createPresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	var input presentationNetworkInput
	if err := decodeJSONLimit(w, r, &input, presentationNetworkBodyLimit); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	network, err := s.presentationNetworks.Create(r.Context(), user.ID, input.toServiceInput())
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	s.auditPresentationNetwork(r, user.ID, "presentation_network.created", network, nil)
	writeJSON(w, http.StatusCreated, map[string]any{"data": network})
}

func (s *server) updatePresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input presentationNetworkInput
	if err := decodeJSONLimit(w, r, &input, presentationNetworkBodyLimit); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	before, err := s.presentationNetworks.Get(r.Context(), id)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	network, err := s.presentationNetworks.Update(r.Context(), user.ID, id, input.toServiceInput())
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	// The audit trail records *that* a credential was rotated, using the revision
	// and timestamp as the evidence. It never records the value, the previous
	// value, or the ciphertext.
	rotated := input.Secret != nil
	s.auditPresentationNetwork(r, user.ID, "presentation_network.updated", network, map[string]any{
		"previousConfigRevision": before.ConfigRevision,
		"credentialRotated":      rotated,
	})
	if rotated {
		s.auditPresentationNetwork(r, user.ID, "presentation_network.credential_rotated", network, nil)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": network})
}

func (s *server) deletePresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	network, err := s.presentationNetworks.Delete(r.Context(), id)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	s.auditPresentationNetwork(r, user.ID, "presentation_network.deleted", network, nil)
	writeJSON(w, http.StatusOK, map[string]any{"data": network})
}

type presentationNetworkAssignmentInput struct {
	ScreenIDs []uuid.UUID `json:"screenIds"`
}

func (s *server) replacePresentationNetworkAssignments(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input presentationNetworkAssignmentInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if len(input.ScreenIDs) > airplayMaxAssignmentScreens {
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_too_many_screens",
			fmt.Sprintf("Assign at most %d screens in one request.", airplayMaxAssignmentScreens))
		return
	}
	// Both the screens gaining the assignment and the screens losing it are
	// operated on, so both sets have to be inside the caller's scope.
	previous, err := s.presentationNetworks.AssignmentsFor(r.Context(), id)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	targets := append([]uuid.UUID(nil), input.ScreenIDs...)
	for _, assignment := range previous {
		targets = append(targets, assignment.ScreenID)
	}
	if !s.authorizeScreenList(w, r, targets, nil) {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	assignments, err := s.presentationNetworks.ReplaceAssignments(r.Context(), user.ID, id, input.ScreenIDs)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	network, err := s.presentationNetworks.Get(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.auditPresentationNetwork(r, user.ID, "presentation_network.assignment_changed", network, map[string]any{
		"screenCount": len(assignments),
	})
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"assignments": assignments}})
}

// airplayMaxAssignmentScreens mirrors the AirPlay group ceiling. A Presentation
// Network legitimately serves a whole building, but a single request that names
// thousands of screens is a mistake rather than a plan.
const airplayMaxAssignmentScreens = 500

type screenPresentationNetworkInput struct {
	PresentationNetworkID uuid.UUID `json:"presentationNetworkId"`
}

func (s *server) getScreenPresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	assignment, err := s.presentationNetworks.AssignmentForScreen(r.Context(), id)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	readiness, err := s.presentationNetworkReadiness(r, id, assignment)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": readiness})
}

func (s *server) putScreenPresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input screenPresentationNetworkInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.PresentationNetworkID == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_required", "Choose a Presentation Network.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	assignment, err := s.presentationNetworks.Assign(r.Context(), user.ID, id, input.PresentationNetworkID)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	s.auditPresentationNetworkAssignment(r, user.ID, id, "presentation_network.assignment_changed", &input.PresentationNetworkID, assignment.NetworkName)
	writeJSON(w, http.StatusOK, map[string]any{"data": assignment})
}

func (s *server) deleteScreenPresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	assignment, err := s.presentationNetworks.Unassign(r.Context(), id)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	s.auditPresentationNetworkAssignment(r, user.ID, id, "presentation_network.assignment_changed", nil, "")
	writeJSON(w, http.StatusOK, map[string]any{"data": assignment})
}

// presentationNetworkReadiness composes the assignment with what the player has
// actually reported. Studio shows exactly one of these statuses per screen, so
// the mapping lives on the server where the reported facts are, rather than being
// re-derived in React from a dozen nullable columns.
func (s *server) presentationNetworkReadiness(r *http.Request, screenID uuid.UUID, assignment presentnet.Assignment) (map[string]any, error) {
	var (
		platform          string
		supported         *bool
		helperState       *string
		managerAvailable  *bool
		wifiAdapter       *bool
		radioEnabled      *bool
		state             *string
		installedID       *uuid.UUID
		installedRevision *int64
		activeID          *uuid.UUID
		lastConnectedAt   *time.Time
		lastFailureAt     *time.Time
		lastFailureCode   *string
		limitation        *string
		wiredAvailable    *bool
		wiredIPv4         *string
		networkRevision   *int64
	)
	err := s.db.QueryRow(r.Context(), `SELECT sc.platform,
		ps.presentation_network_supported, ps.presentation_network_helper_state,
		ps.presentation_network_manager_available, ps.presentation_network_wifi_adapter,
		ps.presentation_network_radio_enabled, ps.presentation_network_state,
		ps.presentation_network_installed_id, ps.presentation_network_installed_revision,
		ps.presentation_network_active_id, ps.presentation_network_last_connected_at,
		ps.presentation_network_last_failure_at, ps.presentation_network_last_failure_code,
		ps.presentation_network_limitation, ps.wired_interface_available,
		host(ps.wired_ipv4), n.config_revision
		FROM screens sc
		LEFT JOIN screen_player_status ps ON ps.screen_id=sc.id
		LEFT JOIN screen_presentation_networks a ON a.screen_id=sc.id
		LEFT JOIN presentation_networks n ON n.id=a.presentation_network_id
		WHERE sc.id=$1`, screenID).
		Scan(&platform, &supported, &helperState, &managerAvailable, &wifiAdapter, &radioEnabled,
			&state, &installedID, &installedRevision, &activeID, &lastConnectedAt,
			&lastFailureAt, &lastFailureCode, &limitation, &wiredAvailable, &wiredIPv4, &networkRevision)
	if err != nil {
		return nil, err
	}
	status, detail := presentationNetworkStatus(presentationNetworkFacts{
		platform:          platform,
		assigned:          assignment.NetworkID != nil,
		networkID:         assignment.NetworkID,
		networkName:       assignment.NetworkName,
		networkRevision:   networkRevision,
		supported:         supported,
		helperState:       helperState,
		managerAvailable:  managerAvailable,
		wifiAdapter:       wifiAdapter,
		state:             state,
		installedID:       installedID,
		installedRevision: installedRevision,
		activeID:          activeID,
		lastFailureCode:   lastFailureCode,
		limitation:        limitation,
	})
	return map[string]any{
		"screenId":                screenID,
		"platform":                platform,
		"presentationNetworkId":   assignment.NetworkID,
		"presentationNetworkName": assignment.NetworkName,
		"assignedAt":              assignment.AssignedAt,
		// A Presentation Network is a Linux capability. Studio uses this to hide
		// the controls entirely on an Android player instead of showing a row that
		// will never report anything.
		"applicable":              strings.EqualFold(platform, "linux"),
		"status":                  status,
		"detail":                  detail,
		"helperState":             helperState,
		"networkManagerAvailable": managerAvailable,
		"wifiAdapterPresent":      wifiAdapter,
		"radioEnabled":            radioEnabled,
		"reportedState":           state,
		"installedNetworkId":      installedID,
		"installedRevision":       installedRevision,
		"activeNetworkId":         activeID,
		"lastConnectedAt":         lastConnectedAt,
		"lastFailureAt":           lastFailureAt,
		"lastFailureCode":         lastFailureCode,
		"limitation":              limitation,
		"wiredInterfaceAvailable": wiredAvailable,
		"wiredIpv4":               wiredIPv4,
		"credentialsAvailable":    s.presentationNetworks.CredentialsAvailable(),
	}, nil
}

type presentationNetworkFacts struct {
	platform          string
	assigned          bool
	networkID         *uuid.UUID
	networkName       string
	networkRevision   *int64
	supported         *bool
	helperState       *string
	managerAvailable  *bool
	wifiAdapter       *bool
	state             *string
	installedID       *uuid.UUID
	installedRevision *int64
	activeID          *uuid.UUID
	lastFailureCode   *string
	limitation        *string
}

// presentationNetworkStatus maps reported facts onto one status an operator can
// act on. The order is the order in which an operator fixes things: platform,
// then the dependency chain on the box, then the assignment, then provisioning,
// then the last session outcome. Nothing is guessed: a fact the player has not
// reported produces "Waiting for the player to report", not a healthy status.
func presentationNetworkStatus(facts presentationNetworkFacts) (string, string) {
	if !strings.EqualFold(facts.platform, "linux") {
		return "not_applicable", "Presentation Networks apply to Linux players only."
	}
	if facts.managerAvailable != nil && !*facts.managerAvailable {
		return "network_manager_unavailable",
			"NetworkManager is not available or not running on this player, so Tilecast cannot manage a temporary Wi-Fi connection."
	}
	if facts.helperState != nil && *facts.helperState != "ok" {
		switch *facts.helperState {
		case "missing":
			return "helper_missing",
				"The Tilecast presentation-network helper is not installed. Re-run the player installer to add it."
		case "unsupported":
			return "unsupported", stringOr(facts.limitation,
				"This player does not support Presentation Networks.")
		default:
			return "helper_unhealthy", stringOr(facts.limitation,
				"The Tilecast presentation-network helper is installed but not responding.")
		}
	}
	if facts.wifiAdapter != nil && !*facts.wifiAdapter {
		return "wifi_adapter_unavailable",
			"This player has no usable Wi-Fi adapter, so it cannot join a Presentation Network."
	}
	if !facts.assigned {
		return "unassigned", "No Presentation Network assigned. AirPlay uses Ethernet only."
	}
	if facts.supported == nil {
		return "reporting_pending",
			"Waiting for this player to report Presentation Network capability."
	}
	if !*facts.supported {
		return "unsupported", stringOr(facts.limitation,
			"This player does not support Presentation Networks.")
	}
	if facts.state == nil {
		return "reporting_pending",
			"Waiting for this player to report Presentation Network state."
	}
	if facts.activeID != nil && facts.networkID != nil && *facts.activeID == *facts.networkID {
		return "connected", fmt.Sprintf("Connected to %s for AirPlay.", facts.networkName)
	}
	if *facts.state == "failed" {
		return "failed", presentationNetworkFailureDetail(facts)
	}
	if facts.networkID == nil || facts.installedID == nil || *facts.installedID != *facts.networkID ||
		(facts.networkRevision != nil && (facts.installedRevision == nil || *facts.installedRevision != *facts.networkRevision)) {
		return "configuration_pending",
			fmt.Sprintf("%s is assigned; the player has not installed the current configuration yet.", facts.networkName)
	}
	return "ready", fmt.Sprintf("%s is provisioned and ready for AirPlay.", facts.networkName)
}

// presentationNetworkFailureDetail names what went wrong in operator language.
// The player reports a stable code; nothing here echoes raw nmcli output, and
// nothing here can contain a credential.
func presentationNetworkFailureDetail(facts presentationNetworkFacts) string {
	code := ""
	if facts.lastFailureCode != nil {
		code = *facts.lastFailureCode
	}
	switch code {
	case "authentication_failed":
		return fmt.Sprintf("Authentication to %s failed. Check the saved credential and, for Enterprise networks, the identity.", facts.networkName)
	case "ssid_not_found":
		return fmt.Sprintf("%s was not found in range of this player.", facts.networkName)
	case "dhcp_timeout":
		return fmt.Sprintf("This player associated with %s but did not receive an IP address.", facts.networkName)
	case "radio_unavailable":
		return "The Wi-Fi radio could not be enabled on this player."
	case "credential_unavailable":
		return "The Presentation Network credential could not be provisioned. Re-enter it in Settings."
	case "helper_unavailable":
		return "The Tilecast presentation-network helper stopped responding during the last attempt."
	case "ethernet_default_route_lost":
		return "Ethernet stopped being the default route, so Tilecast disconnected the temporary Wi-Fi connection."
	case "":
		return fmt.Sprintf("The last attempt to join %s failed.", facts.networkName)
	default:
		return fmt.Sprintf("The last attempt to join %s failed (%s).", facts.networkName, strings.ReplaceAll(code, "_", " "))
	}
}

func stringOr(value *string, fallback string) string {
	if value != nil && strings.TrimSpace(*value) != "" {
		return *value
	}
	return fallback
}

// testPresentationNetwork runs a bounded connection test on one assigned Linux
// screen. It deliberately does not start UxPlay or create an AirPlay session:
// the player associates, confirms it obtained an address, confirms Ethernet is
// still the default route, then disconnects and restores the prior radio state.
func (s *server) testPresentationNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		ScreenID uuid.UUID `json:"screenId"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.ScreenID == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_test_screen_required",
			"Choose an assigned Linux screen to test from.")
		return
	}
	if !s.authorizeScreenList(w, r, []uuid.UUID{input.ScreenID}, nil) {
		return
	}
	if !s.presentationNetworks.CredentialsAvailable() {
		writeError(w, http.StatusConflict, "presentation_network_key_unavailable",
			presentnet.KeyUnavailable("Testing a Presentation Network"))
		return
	}
	network, err := s.presentationNetworks.Get(r.Context(), id)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	assignment, err := s.presentationNetworks.AssignmentForScreen(r.Context(), input.ScreenID)
	if err != nil {
		s.writePresentationNetworkError(w, r, err)
		return
	}
	if assignment.NetworkID == nil || *assignment.NetworkID != id {
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_not_assigned",
			fmt.Sprintf("%s is not assigned to %s. Assign it first, then test.", assignment.ScreenName, network.Name))
		return
	}
	if !strings.EqualFold(assignment.Platform, "linux") {
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_linux_required",
			fmt.Sprintf("%s is not a Linux player.", assignment.ScreenName))
		return
	}
	// A test that runs while the display is mirroring would disconnect the
	// session it is meant to validate.
	if active, activeErr := s.activeAirplaySessionForScreens(r.Context(), []uuid.UUID{input.ScreenID}); activeErr != nil {
		s.internalError(w, r, activeErr)
		return
	} else if active != nil {
		writeError(w, http.StatusConflict, "presentation_network_airplay_active",
			fmt.Sprintf("%s is part of an active AirPlay session. Stop it before testing.", assignment.ScreenName))
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	// The payload carries identifiers only. The credential is fetched by the
	// player over its own authenticated channel, so it never enters a durable
	// command row.
	payload, validationErr := s.validateCommand("test_presentation_network", mustJSON(map[string]any{
		"presentationNetworkId": id.String(),
		"timeoutSeconds":        int(presentationNetworkTestWindow / time.Second),
	}))
	if validationErr != nil {
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_command_invalid", validationErr.Error())
		return
	}
	commandID, _, queueErr := s.queueCommand(r.Context(), input.ScreenID, user.ID, "test_presentation_network", payload, uuid.New())
	switch {
	case errors.Is(queueErr, errScreenNotFound):
		writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
		return
	case errors.Is(queueErr, errCommandLimit):
		writeError(w, http.StatusTooManyRequests, "command_limit_reached", "This screen has reached its pending-command limit.")
		return
	case queueErr != nil:
		s.internalError(w, r, queueErr)
		return
	}
	s.devices.Notify(input.ScreenID, map[string]any{"type": "commands.available"})
	s.auditPresentationNetwork(r, user.ID, "presentation_network.test_requested", network, map[string]any{
		"screenId":   input.ScreenID.String(),
		"screenName": assignment.ScreenName,
		"commandId":  commandID.String(),
	})
	writeJSON(w, http.StatusAccepted, map[string]any{"data": map[string]any{
		"commandId":      commandID,
		"screenId":       input.ScreenID,
		"timeoutSeconds": int(presentationNetworkTestWindow / time.Second),
	}})
}

// playerPresentationNetworkSecret is the only path a Wi-Fi credential travels
// after it is sealed.
//
// Every property here is load-bearing:
//
//   - It requires the permanent player credential (the route is mounted behind
//     requireDevice), so a dashboard session cannot reach it.
//   - It derives the network from the *authenticated screen's* assignment. The
//     request body is empty and no network identifier is accepted, which is what
//     makes it impossible for one player to fetch another player's network.
//   - Cache-Control: no-store, so no intermediary retains the body.
//   - The response body is never logged, and errors describe the situation
//     without quoting anything from the credential.
func (s *server) playerPresentationNetworkSecret(w http.ResponseWriter, r *http.Request) {
	if !s.requirePresentationNetworks(w) {
		return
	}
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	material, err := s.presentationNetworks.ProvisioningMaterialFor(r.Context(), principal.ScreenID)
	switch {
	case errors.Is(err, presentnet.ErrNotFound):
		writeError(w, http.StatusNotFound, "presentation_network_not_assigned",
			"This screen has no Presentation Network assignment.")
		return
	case errors.Is(err, presentnet.ErrKeyNotConfigured):
		writeError(w, http.StatusServiceUnavailable, "presentation_network_key_unavailable",
			presentnet.KeyUnavailable("Presentation Network provisioning"))
		return
	case errors.Is(err, presentnet.ErrSecretUnreadable):
		// Fail closed. The stored envelope cannot be opened with the configured
		// key, so the credential has to be re-entered. Nothing about the stored
		// bytes appears here or in the log line.
		s.logger.Error("presentation network credential could not be decrypted",
			"screen_id", principal.ScreenID)
		writeError(w, http.StatusConflict, "presentation_network_credential_unreadable",
			"The stored Presentation Network credential cannot be decrypted with the configured key. Re-enter it in Settings → Presentation Networks.")
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": material})
}

// presentationNetworkConfigSection renders the assignment for the player
// configuration document.
//
// A nil assignment produces a section that explicitly says "assigned: false"
// rather than being omitted. The difference matters: an absent section means an
// older server that knows nothing about Presentation Networks, while a present
// section saying "not assigned" is an instruction to remove any Tilecast-managed
// Wi-Fi profile the player still holds. That is how an assignment removal
// reaches a player that was offline when it happened, without a command that
// could expire first.
func presentationNetworkConfigSection(assignment *presentnet.PlayerAssignment) map[string]any {
	if assignment == nil {
		return map[string]any{"assigned": false}
	}
	return map[string]any{
		"assigned":              true,
		"presentationNetworkId": assignment.NetworkID.String(),
		"name":                  assignment.Name,
		"ssid":                  assignment.SSID,
		"hidden":                assignment.Hidden,
		"security":              string(assignment.Security),
		"configRevision":        assignment.ConfigRevision,
		"profileName":           assignment.ProfileName,
		"credentialAvailable":   assignment.CredentialAvailable,
		// Non-secret 802.1X metadata travels with the configuration so the player
		// can tell a metadata-only change from a credential rotation without
		// requesting the credential.
		"identity":          assignment.Auth.Identity,
		"anonymousIdentity": assignment.Auth.AnonymousIdentity,
		"domainSuffixMatch": assignment.Auth.DomainSuffixMatch,
		"caCertificateSet":  assignment.Auth.CACertificatePEM != "",
	}
}

func (s *server) writePresentationNetworkError(w http.ResponseWriter, r *http.Request, err error) {
	if validation, ok := presentnet.AsValidationError(err); ok {
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_invalid", validation.Message)
		return
	}
	switch {
	case errors.Is(err, presentnet.ErrNotFound):
		writeError(w, http.StatusNotFound, "presentation_network_not_found", "The Presentation Network was not found.")
	case errors.Is(err, presentnet.ErrNameTaken):
		writeError(w, http.StatusConflict, "presentation_network_name_taken", "A Presentation Network with that name already exists.")
	case errors.Is(err, presentnet.ErrScreenNotEligible):
		writeError(w, http.StatusUnprocessableEntity, "presentation_network_screen_ineligible",
			"Presentation Networks can only be assigned to Linux screens.")
	case errors.Is(err, presentnet.ErrKeyNotConfigured):
		writeError(w, http.StatusConflict, "presentation_network_key_unavailable",
			presentnet.KeyUnavailable("Saving a Presentation Network credential"))
	case errors.Is(err, presentnet.ErrSecretUnreadable):
		writeError(w, http.StatusConflict, "presentation_network_credential_unreadable",
			"The stored credential cannot be decrypted with the configured key. Re-enter it to continue.")
	default:
		s.internalError(w, r, err)
	}
}

// auditPresentationNetwork records identity, not credentials. presentnet.Describe
// is the single place that decides what a network's audit shape is, so a field
// added to the record cannot leak into the log by accident.
func (s *server) auditPresentationNetwork(r *http.Request, actor uuid.UUID, action string, network presentnet.Network, extra map[string]any) {
	metadata := presentnet.Describe(network)
	for key, value := range extra {
		metadata[key] = value
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return
	}
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,$3,'presentation_network',$4,$5::jsonb)`,
		uuid.New(), actor, action, network.ID.String(), string(encoded))
}

func (s *server) auditPresentationNetworkAssignment(r *http.Request, actor, screenID uuid.UUID, action string, networkID *uuid.UUID, networkName string) {
	metadata := map[string]any{"screenId": screenID.String()}
	if networkID != nil {
		metadata["presentationNetworkId"] = networkID.String()
		metadata["name"] = networkName
	} else {
		metadata["presentationNetworkId"] = nil
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return
	}
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,$3,'screen',$4,$5::jsonb)`,
		uuid.New(), actor, action, screenID.String(), string(encoded))
}
