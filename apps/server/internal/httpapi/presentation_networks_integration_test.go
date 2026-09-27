package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/oklog/ulid/v2"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/presentnet"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

const presentationNetworkTestCSRF = "presentation-network-test-csrf"

// withPresentationNetworkDatabase assembles the same service boundary as the
// production server around the shared integration fixture. The feature is
// deliberately exercised through HTTP handlers and authentication middleware;
// direct service tests cannot prove the credential and CSRF boundaries.
func withPresentationNetworkDatabase(t *testing.T, run func(activityTestEnvironment)) {
	t.Helper()
	withActivityDatabase(t, func(env activityTestEnvironment) {
		cipher, err := presentnet.LoadCipher(strings.Repeat("ab", 32))
		if err != nil {
			t.Fatal(err)
		}
		settingsService := settings.NewService(env.pool, nil, settings.HardLimits{})
		networkService := presentnet.NewService(env.pool, cipher)
		networkService.SetConfigBumper(settingsService)
		env.server.auth = auth.NewService(env.pool, time.Hour)
		env.server.cookieName = "tilecast_session"
		env.server.presentationNetworks = networkService
		env.server.settings = settingsService
		env.server.operations = OperationsConfig{
			MaxPendingCommands:          50,
			DefaultCommandExpiryMinutes: 10,
			CommandRetentionDays:        30,
		}
		env.owner.CSRFToken = presentationNetworkTestCSRF
		if _, err := env.pool.Exec(context.Background(), `UPDATE screens
			SET platform='linux',android_version='',enabled=true,last_heartbeat_at=now(),last_known_ip='192.0.2.10'::inet
			WHERE id=$1`, env.screenID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(context.Background(), `INSERT INTO screen_config_state(screen_id)
			VALUES($1) ON CONFLICT DO NOTHING`, env.screenID); err != nil {
			t.Fatal(err)
		}
		run(env)
	})
}

func presentationNetworkRequest(method, path string, body []byte, session auth.Session, csrf bool, params map[string]string) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request = requestWithTestPrincipal(request, session)
	if csrf {
		request.Header.Set("X-CSRF-Token", session.CSRFToken)
	}
	return routeContext(request, params)
}

func invokePresentationNetwork(t *testing.T, handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func presentationNetworkAdminHandler(s *server, handler http.HandlerFunc) http.Handler {
	return s.requireRoles("owner", "administrator")(s.requireCSRF(handler))
}

func presentationNetworkReadHandler(s *server, handler http.HandlerFunc) http.Handler {
	return s.requireRoles("owner", "administrator")(handler)
}

func testDeviceCredential(t *testing.T, env activityTestEnvironment, screenID uuid.UUID) string {
	t.Helper()
	secret := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte("d"), 32))
	publicID := strings.ToLower(ulid.Make().String())
	credential := "tc_device_" + publicID + "." + secret
	hash := sha256.Sum256([]byte(secret))
	if _, err := env.pool.Exec(context.Background(), `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash)
		VALUES($1,$2,$3,$4)`, uuid.New(), screenID, publicID, hash[:]); err != nil {
		t.Fatal(err)
	}
	return credential
}

func addPresentationNetworkScreen(t *testing.T, env activityTestEnvironment, name, ip string) (uuid.UUID, string) {
	t.Helper()
	var organizationID uuid.UUID
	if err := env.pool.QueryRow(context.Background(), `SELECT organization_id FROM screens WHERE id=$1`, env.screenID).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	screenID := uuid.New()
	if _, err := env.pool.Exec(context.Background(), `INSERT INTO screens(
		id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,
		android_version,player_version,screen_width,screen_height,density,locale,timezone,
		enabled,last_heartbeat_at,last_known_ip)
		VALUES($1,$2,$3,$4,'linux','Test','Linux x64','', '0.13.1',1920,1080,1,'en-US','America/New_York',true,now(),$5::inet)`,
		screenID, organizationID, uuid.NewString(), name, ip); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `INSERT INTO screen_config_state(screen_id) VALUES($1)`, screenID); err != nil {
		t.Fatal(err)
	}
	return screenID, testDeviceCredential(t, env, screenID)
}

func createPresentationNetworkHTTP(t *testing.T, env activityTestEnvironment, name, ssid, secret string) presentnet.Network {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"name": name, "ssid": ssid, "hidden": false, "security": "wpa_psk", "secret": secret,
	})
	handler := presentationNetworkAdminHandler(env.server, env.server.createPresentationNetwork)
	response := invokePresentationNetwork(t, handler, presentationNetworkRequest(http.MethodPost,
		"/api/v1/presentation-networks", body, env.owner, true, nil))
	if response.Code != http.StatusCreated {
		t.Fatalf("create Presentation Network status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), secret) || strings.Contains(response.Body.String(), "TCPN") {
		t.Fatalf("create response leaked credential material: %s", response.Body.String())
	}
	var envelope struct {
		Data presentnet.Network `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if !envelope.Data.CredentialSet {
		t.Fatal("create response did not report a saved credential")
	}
	return envelope.Data
}

func fetchPresentationNetworkMaterial(t *testing.T, env activityTestEnvironment, credential string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/player/presentation-network", nil)
	request.Header.Set("Authorization", "Bearer "+credential)
	handler := env.server.requireDevice(http.HandlerFunc(env.server.playerPresentationNetworkSecret))
	return invokePresentationNetwork(t, handler, request)
}

func TestPresentationNetworkHTTPLifecycleRedactsSecretsAndEnforcesBoundaries(t *testing.T) {
	withPresentationNetworkDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		credentialA := testDeviceCredential(t, env, env.screenID)
		_, credentialB := addPresentationNetworkScreen(t, env, "Gym TV", "192.0.2.11")
		firstSecret := "test-only-psk"
		secondSecret := "test-only-second-psk"
		rotatedSecret := "test-only-rotated-psk"
		first := createPresentationNetworkHTTP(t, env, "District Staff Wi-Fi", "District-Staff", firstSecret)
		second := createPresentationNetworkHTTP(t, env, "Visitor Wi-Fi", "District-Visitors", secondSecret)

		// A read is administrative, and both a Viewer and an Editor are denied.
		viewer := env.owner
		viewer.User.Role = "viewer"
		viewerResponse := invokePresentationNetwork(t,
			presentationNetworkReadHandler(env.server, env.server.listPresentationNetworks),
			presentationNetworkRequest(http.MethodGet, "/api/v1/presentation-networks", nil, viewer, false, nil))
		if viewerResponse.Code != http.StatusForbidden {
			t.Fatalf("Viewer list status=%d, want 403", viewerResponse.Code)
		}
		editor := env.owner
		editor.User.Role = "editor"
		editorResponse := invokePresentationNetwork(t,
			presentationNetworkAdminHandler(env.server, env.server.deletePresentationNetwork),
			presentationNetworkRequest(http.MethodDelete, "/api/v1/presentation-networks/"+second.ID.String(), nil, editor, true, map[string]string{"id": second.ID.String()}))
		if editorResponse.Code != http.StatusForbidden {
			t.Fatalf("Editor delete status=%d, want 403", editorResponse.Code)
		}
		noCSRF := invokePresentationNetwork(t,
			presentationNetworkAdminHandler(env.server, env.server.deletePresentationNetwork),
			presentationNetworkRequest(http.MethodDelete, "/api/v1/presentation-networks/"+second.ID.String(), nil, env.owner, false, map[string]string{"id": second.ID.String()}))
		if noCSRF.Code != http.StatusForbidden {
			t.Fatalf("mutation without CSRF status=%d, want 403", noCSRF.Code)
		}

		listResponse := invokePresentationNetwork(t,
			presentationNetworkReadHandler(env.server, env.server.listPresentationNetworks),
			presentationNetworkRequest(http.MethodGet, "/api/v1/presentation-networks", nil, env.owner, false, nil))
		if listResponse.Code != http.StatusOK || strings.Contains(listResponse.Body.String(), firstSecret) || strings.Contains(listResponse.Body.String(), secondSecret) || strings.Contains(listResponse.Body.String(), "TCPN") {
			t.Fatalf("list response status/body is unsafe: %d %s", listResponse.Code, listResponse.Body.String())
		}
		getResponse := invokePresentationNetwork(t,
			presentationNetworkReadHandler(env.server, env.server.getPresentationNetwork),
			presentationNetworkRequest(http.MethodGet, "/api/v1/presentation-networks/"+first.ID.String(), nil, env.owner, false, map[string]string{"id": first.ID.String()}))
		if getResponse.Code != http.StatusOK || strings.Contains(getResponse.Body.String(), firstSecret) || strings.Contains(getResponse.Body.String(), "TCPN") {
			t.Fatalf("get response status/body is unsafe: %d %s", getResponse.Code, getResponse.Body.String())
		}

		var sealed []byte
		if err := env.pool.QueryRow(ctx, `SELECT secret_ciphertext FROM presentation_networks WHERE id=$1`, first.ID).Scan(&sealed); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(sealed, []byte(firstSecret)) {
			t.Fatal("database ciphertext contains the plaintext credential")
		}
		var auditMetadata string
		if err := env.pool.QueryRow(ctx, `SELECT COALESCE(string_agg(metadata::text,' '),'') FROM audit_logs WHERE resource_id=$1`, first.ID.String()).Scan(&auditMetadata); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(auditMetadata, firstSecret) || strings.Contains(auditMetadata, "TCPN") {
			t.Fatalf("audit metadata contains credential material: %s", auditMetadata)
		}

		// Screen assignment is a real HTTP operation and is intentionally scoped.
		initialConfigRevision := screenConfigRevision(t, env, env.screenID)
		assign := func(networkID uuid.UUID) *httptest.ResponseRecorder {
			body, _ := json.Marshal(map[string]uuid.UUID{"presentationNetworkId": networkID})
			return invokePresentationNetwork(t,
				presentationNetworkAdminHandler(env.server, env.server.putScreenPresentationNetwork),
				presentationNetworkRequest(http.MethodPut, "/api/v1/screens/"+env.screenID.String()+"/presentation-network", body, env.owner, true, map[string]string{"id": env.screenID.String()}))
		}
		if response := assign(first.ID); response.Code != http.StatusOK {
			t.Fatalf("first assignment status=%d body=%s", response.Code, response.Body.String())
		}
		if got := screenConfigRevision(t, env, env.screenID); got <= initialConfigRevision {
			t.Fatalf("assignment config revision=%d, want > %d", got, initialConfigRevision)
		}
		if response := assign(second.ID); response.Code != http.StatusOK {
			t.Fatalf("reassignment status=%d body=%s", response.Code, response.Body.String())
		}
		var assignedID uuid.UUID
		if err := env.pool.QueryRow(ctx, `SELECT presentation_network_id FROM screen_presentation_networks WHERE screen_id=$1`, env.screenID).Scan(&assignedID); err != nil {
			t.Fatal(err)
		}
		if assignedID != second.ID {
			t.Fatalf("reassigned network=%s, want %s", assignedID, second.ID)
		}
		unassign := invokePresentationNetwork(t,
			presentationNetworkAdminHandler(env.server, env.server.deleteScreenPresentationNetwork),
			presentationNetworkRequest(http.MethodDelete, "/api/v1/screens/"+env.screenID.String()+"/presentation-network", nil, env.owner, true, map[string]string{"id": env.screenID.String()}))
		if unassign.Code != http.StatusOK {
			t.Fatalf("unassign status=%d body=%s", unassign.Code, unassign.Body.String())
		}
		if count := screenAssignmentCount(t, env, env.screenID); count != 0 {
			t.Fatalf("screen assignment count=%d after unassign, want 0", count)
		}
		if response := assign(first.ID); response.Code != http.StatusOK {
			t.Fatalf("assignment before provisioning status=%d body=%s", response.Code, response.Body.String())
		}

		// The player endpoint has a separate authentication boundary: dashboard
		// sessions cannot reach it, and a player can only fetch its own assignment.
		playerWithDashboardSession := env.server.requireDevice(http.HandlerFunc(env.server.playerPresentationNetworkSecret))
		dashboardAttempt := presentationNetworkRequest(http.MethodGet, "/api/v1/player/presentation-network", nil, env.owner, false, nil)
		if response := invokePresentationNetwork(t, playerWithDashboardSession, dashboardAttempt); response.Code != http.StatusUnauthorized {
			t.Fatalf("player route with dashboard context status=%d, want 401", response.Code)
		}
		dashboardRoute := env.server.requireSession(presentationNetworkReadHandler(env.server, env.server.listPresentationNetworks))
		playerToDashboard := httptest.NewRequest(http.MethodGet, "/api/v1/presentation-networks", nil)
		playerToDashboard.Header.Set("Authorization", "Bearer "+credentialA)
		if response := invokePresentationNetwork(t, dashboardRoute, playerToDashboard); response.Code != http.StatusUnauthorized {
			t.Fatalf("dashboard route with player credential status=%d, want 401", response.Code)
		}

		otherPlayer := fetchPresentationNetworkMaterial(t, env, credentialB)
		if otherPlayer.Code != http.StatusNotFound {
			t.Fatalf("unassigned player secret fetch status=%d, want 404 body=%s", otherPlayer.Code, otherPlayer.Body.String())
		}
		material := fetchPresentationNetworkMaterial(t, env, credentialA)
		if material.Code != http.StatusOK || material.Header().Get("Cache-Control") != "no-store" || material.Header().Get("Pragma") != "no-cache" || !strings.Contains(material.Body.String(), firstSecret) {
			t.Fatalf("assigned player material response is wrong: status=%d headers=%v body=%s", material.Code, material.Header(), material.Body.String())
		}

		// A connection test queues only safe identifiers. It never serializes the
		// credential into the durable player command.
		testBody, _ := json.Marshal(map[string]uuid.UUID{"screenId": env.screenID})
		testResponse := invokePresentationNetwork(t,
			presentationNetworkAdminHandler(env.server, env.server.testPresentationNetwork),
			presentationNetworkRequest(http.MethodPost, "/api/v1/presentation-networks/"+first.ID.String()+"/test", testBody, env.owner, true, map[string]string{"id": first.ID.String()}))
		if testResponse.Code != http.StatusAccepted {
			t.Fatalf("connection test status=%d body=%s", testResponse.Code, testResponse.Body.String())
		}
		var commandPayload string
		if err := env.pool.QueryRow(ctx, `SELECT payload::text FROM player_commands WHERE screen_id=$1 AND type='test_presentation_network' ORDER BY created_at DESC LIMIT 1`, env.screenID).Scan(&commandPayload); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(commandPayload, firstSecret) || strings.Contains(commandPayload, "TCPN") || !strings.Contains(commandPayload, first.ID.String()) {
			t.Fatalf("connection-test command payload is unsafe: %s", commandPayload)
		}

		// Omitting secret retains the sealed value and revision. Supplying one
		// rotates it and advances the revision visible to assigned players.
		updateBody, _ := json.Marshal(map[string]any{
			"name": "District Staff Wi-Fi Renamed", "ssid": "District-Staff", "hidden": false, "security": "wpa_psk",
		})
		updateResponse := invokePresentationNetwork(t,
			presentationNetworkAdminHandler(env.server, env.server.updatePresentationNetwork),
			presentationNetworkRequest(http.MethodPatch, "/api/v1/presentation-networks/"+first.ID.String(), updateBody, env.owner, true, map[string]string{"id": first.ID.String()}))
		if updateResponse.Code != http.StatusOK || strings.Contains(updateResponse.Body.String(), firstSecret) {
			t.Fatalf("secret-retaining update status/body=%d %s", updateResponse.Code, updateResponse.Body.String())
		}
		var retained presentnet.Network
		if err := json.Unmarshal(updateResponse.Body.Bytes(), &struct {
			Data *presentnet.Network `json:"data"`
		}{Data: &retained}); err != nil {
			t.Fatal(err)
		}
		if retained.ConfigRevision != first.ConfigRevision {
			t.Fatalf("metadata-only update revision=%d, want retained %d", retained.ConfigRevision, first.ConfigRevision)
		}
		var retainedSealed []byte
		if err := env.pool.QueryRow(ctx, `SELECT secret_ciphertext FROM presentation_networks WHERE id=$1`, first.ID).Scan(&retainedSealed); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(sealed, retainedSealed) {
			t.Fatal("update without a secret replaced the stored ciphertext")
		}

		rotatedBody, _ := json.Marshal(map[string]any{
			"name": "District Staff Wi-Fi Renamed", "ssid": "District-Staff", "hidden": false, "security": "wpa_psk", "secret": rotatedSecret,
		})
		rotatedResponse := invokePresentationNetwork(t,
			presentationNetworkAdminHandler(env.server, env.server.updatePresentationNetwork),
			presentationNetworkRequest(http.MethodPatch, "/api/v1/presentation-networks/"+first.ID.String(), rotatedBody, env.owner, true, map[string]string{"id": first.ID.String()}))
		if rotatedResponse.Code != http.StatusOK || strings.Contains(rotatedResponse.Body.String(), rotatedSecret) {
			t.Fatalf("credential rotation status/body=%d %s", rotatedResponse.Code, rotatedResponse.Body.String())
		}
		var rotated presentnet.Network
		if err := json.Unmarshal(rotatedResponse.Body.Bytes(), &struct {
			Data *presentnet.Network `json:"data"`
		}{Data: &rotated}); err != nil {
			t.Fatal(err)
		}
		if rotated.ConfigRevision != retained.ConfigRevision+1 {
			t.Fatalf("rotated revision=%d, want %d", rotated.ConfigRevision, retained.ConfigRevision+1)
		}
		material = fetchPresentationNetworkMaterial(t, env, credentialA)
		if material.Code != http.StatusOK || !strings.Contains(material.Body.String(), rotatedSecret) || strings.Contains(material.Body.String(), firstSecret) {
			t.Fatalf("rotated player material is wrong: %s", material.Body.String())
		}

		// A wrong key and a missing key both fail closed, with neither revealing
		// the ciphertext or plaintext. Restore the working service for cleanup.
		wrongCipher, err := presentnet.LoadCipher(strings.Repeat("cd", 32))
		if err != nil {
			t.Fatal(err)
		}
		wrongService := presentnet.NewService(env.pool, wrongCipher)
		wrongService.SetConfigBumper(env.server.settings)
		env.server.presentationNetworks = wrongService
		wrongKey := fetchPresentationNetworkMaterial(t, env, credentialA)
		if wrongKey.Code != http.StatusConflict || strings.Contains(wrongKey.Body.String(), rotatedSecret) || strings.Contains(wrongKey.Body.String(), "TCPN") {
			t.Fatalf("wrong-key response=%d %s", wrongKey.Code, wrongKey.Body.String())
		}
		env.server.presentationNetworks = presentnet.NewService(env.pool, nil)
		missingKey := fetchPresentationNetworkMaterial(t, env, credentialA)
		if missingKey.Code != http.StatusServiceUnavailable || strings.Contains(missingKey.Body.String(), rotatedSecret) {
			t.Fatalf("missing-key response=%d %s", missingKey.Code, missingKey.Body.String())
		}
		env.server.presentationNetworks = networkServiceForTest(t, env)

		// Deletion cascades the assignment and bumps the player's durable config,
		// so an offline player will still remove its Tilecast-owned profile.
		beforeDeleteRevision := screenConfigRevision(t, env, env.screenID)
		deleteResponse := invokePresentationNetwork(t,
			presentationNetworkAdminHandler(env.server, env.server.deletePresentationNetwork),
			presentationNetworkRequest(http.MethodDelete, "/api/v1/presentation-networks/"+first.ID.String(), nil, env.owner, true, map[string]string{"id": first.ID.String()}))
		if deleteResponse.Code != http.StatusOK {
			t.Fatalf("delete assigned network status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
		}
		if screenAssignmentCount(t, env, env.screenID) != 0 || screenConfigRevision(t, env, env.screenID) <= beforeDeleteRevision {
			t.Fatalf("delete did not clear assignment/config revision")
		}
		if response := fetchPresentationNetworkMaterial(t, env, credentialA); response.Code != http.StatusNotFound {
			t.Fatalf("deleted network player fetch status=%d, want 404", response.Code)
		}
		if invalid := invokePresentationNetwork(t,
			presentationNetworkReadHandler(env.server, env.server.getPresentationNetwork),
			presentationNetworkRequest(http.MethodGet, "/api/v1/presentation-networks/not-an-id", nil, env.owner, false, map[string]string{"id": "not-an-id"})); invalid.Code != http.StatusNotFound {
			t.Fatalf("invalid network ID status=%d, want 404", invalid.Code)
		}
	})
}

func networkServiceForTest(t *testing.T, env activityTestEnvironment) *presentnet.Service {
	t.Helper()
	cipher, err := presentnet.LoadCipher(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	service := presentnet.NewService(env.pool, cipher)
	service.SetConfigBumper(env.server.settings)
	return service
}

func screenConfigRevision(t *testing.T, env activityTestEnvironment, screenID uuid.UUID) int64 {
	t.Helper()
	var revision int64
	if err := env.pool.QueryRow(context.Background(), `SELECT config_revision FROM screen_config_state WHERE screen_id=$1`, screenID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}

func screenAssignmentCount(t *testing.T, env activityTestEnvironment, screenID uuid.UUID) int {
	t.Helper()
	var count int
	if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM screen_presentation_networks WHERE screen_id=$1`, screenID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestPresentationNetworkStatusMapsReportedFactsToOperatorStates(t *testing.T) {
	networkID := uuid.New()
	revision := int64(4)
	installedRevision := int64(4)
	supported := true
	manager := true
	wifi := true
	state := "provisioned"
	installedID := networkID
	activeID := networkID
	cases := []struct {
		name   string
		facts  presentationNetworkFacts
		status string
	}{
		{name: "android", facts: presentationNetworkFacts{platform: "android-tv"}, status: "not_applicable"},
		{name: "manager unavailable", facts: presentationNetworkFacts{platform: "linux", managerAvailable: boolPtr(false)}, status: "network_manager_unavailable"},
		{name: "helper missing", facts: presentationNetworkFacts{platform: "linux", helperState: stringPtr("missing")}, status: "helper_missing"},
		{name: "no wifi", facts: presentationNetworkFacts{platform: "linux", wifiAdapter: boolPtr(false)}, status: "wifi_adapter_unavailable"},
		{name: "unassigned", facts: presentationNetworkFacts{platform: "linux", assigned: false}, status: "unassigned"},
		{name: "waiting for report", facts: presentationNetworkFacts{platform: "linux", assigned: true, networkID: &networkID}, status: "reporting_pending"},
		{name: "unsupported", facts: presentationNetworkFacts{platform: "linux", assigned: true, networkID: &networkID, supported: boolPtr(false)}, status: "unsupported"},
		{name: "configuration pending", facts: presentationNetworkFacts{platform: "linux", assigned: true, networkID: &networkID, networkRevision: &revision, supported: &supported, helperState: stringPtr("ok"), managerAvailable: &manager, wifiAdapter: &wifi, state: &state, installedID: uuidPtr(uuid.New()), installedRevision: &installedRevision}, status: "configuration_pending"},
		{name: "ready", facts: presentationNetworkFacts{platform: "linux", assigned: true, networkID: &networkID, networkName: "District Staff Wi-Fi", networkRevision: &revision, supported: &supported, helperState: stringPtr("ok"), managerAvailable: &manager, wifiAdapter: &wifi, state: &state, installedID: &installedID, installedRevision: &installedRevision}, status: "ready"},
		{name: "connected", facts: presentationNetworkFacts{platform: "linux", assigned: true, networkID: &networkID, networkName: "District Staff Wi-Fi", networkRevision: &revision, supported: &supported, helperState: stringPtr("ok"), managerAvailable: &manager, wifiAdapter: &wifi, state: &state, installedID: &installedID, installedRevision: &installedRevision, activeID: &activeID}, status: "connected"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, _ := presentationNetworkStatus(testCase.facts)
			if status != testCase.status {
				t.Fatalf("status=%q, want %q", status, testCase.status)
			}
		})
	}
}

func boolPtr(value bool) *bool           { return &value }
func stringPtr(value string) *string     { return &value }
func uuidPtr(value uuid.UUID) *uuid.UUID { return &value }
