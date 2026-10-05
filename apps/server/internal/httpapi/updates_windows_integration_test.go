package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func (f *edgeFixture) windowsRelease(t *testing.T, arch string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO player_releases(id,platform,player_family,architecture,source,channel,version_code,version_name,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_bytes,manifest_signature,cache_status,verification_status,imported_by) VALUES($1,'windows','windows',$2,'upload','stable',2000,'0.2.0','',now(),'tilecast-windows-0.2.0-'||$2||'.msix',4096,$3,'','{}'::jsonb,$4,'c2lnbmF0dXJl','cached','verified',$5)`, id, arch, "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc", f.envelope, f.user); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestWindowsReleaseReachesOnlyMatchingWindowsScreens(t *testing.T) {
	f := newEdgeFixture(t)
	intel := f.screen(t, "Windows Kiosk", "windows", "windows", "x86_64", 1000)
	arm := f.screen(t, "Windows ARM Kiosk", "windows", "windows", "aarch64", 1000)
	unreported := f.screen(t, "Windows before its first heartbeat", "windows", "windows", "", 1000)
	platformFallback := f.screen(t, "Windows without a reported family", "windows", "", "", 1000)
	edge := f.screen(t, "Edge Lobby", "linux", "edge", "x86_64", 1000)
	electron := f.screen(t, "Electron Lobby", "linux", "", "", 1000)
	android := f.screen(t, "Fire TV", "fire-tv", "", "", 5)

	release := f.windowsRelease(t, "x86_64")
	deployment, count := f.deploy(t, release, intel, arm, unreported, platformFallback, edge, electron, android)
	if count != 4 {
		t.Fatalf("a Windows release targets exactly the four Windows screens, got %d", count)
	}
	for screen, want := range map[uuid.UUID]string{
		intel: "pending", arm: "incompatible", unreported: "incompatible", platformFallback: "incompatible",
		edge: "not_targeted", electron: "not_targeted", android: "not_targeted",
	} {
		if got := f.state(t, deployment, screen); got != want {
			t.Fatalf("windows deployment: screen state %q, want %q", got, want)
		}
	}
	var payload map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT payload FROM player_commands WHERE screen_id=$1 AND type='install_player_update'`, intel).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["playerFamily"] != "windows" {
		t.Fatalf("the command names the release family: %#v", payload)
	}

	if id, _ := f.deploy(t, f.edgeRelease(t, "x86_64"), intel); id != uuid.Nil {
		t.Fatal("an Edge release with only Windows targets must be refused")
	}
	if id, _ := f.deploy(t, release, edge); id != uuid.Nil {
		t.Fatal("a Windows release with only Edge targets must be refused")
	}
}

func TestWindowsPlayerMetadataServesTheSignedEnvelope(t *testing.T) {
	f := newEdgeFixture(t)
	intel := f.screen(t, "Windows Kiosk", "windows", "windows", "x86_64", 1000)
	release := f.windowsRelease(t, "x86_64")
	deployment, _ := f.deploy(t, release, intel)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/player/updates/"+release.String(), nil)
	request = withURLParam(f.asPlayer(intel, request), "releaseId", release.String())
	response := httptest.NewRecorder()
	f.server.playerUpdateMetadata(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("metadata status=%d body=%s", response.Code, response.Body.String())
	}
	var decoded struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	data := decoded.Data
	if data["playerFamily"] != "windows" || data["architecture"] != "x86_64" || data["platform"] != "windows" {
		t.Fatalf("windows metadata names its family and architecture: %#v", data)
	}
	if data["signedManifest"] != base64.StdEncoding.EncodeToString(f.envelope) || data["manifestSignature"] != "c2lnbmF0dXJl" {
		t.Fatalf("windows metadata serves the exact signed envelope: %#v", data)
	}
	if _, ok := data["stateSchemaVersion"]; ok {
		t.Fatalf("windows metadata must not carry an Edge state schema: %#v", data)
	}

	// A Windows target settles like the other non-Edge families: `succeeded`
	// is refused and only the heartbeat of the new build settles it.
	if code := f.report(t, deployment, intel, `{"state":"succeeded"}`); code != http.StatusUnprocessableEntity {
		t.Fatalf("succeeded for a Windows release must be refused, got %d", code)
	}
}
