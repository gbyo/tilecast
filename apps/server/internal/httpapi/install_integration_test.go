package httpapi

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

// cacheLinuxRelease writes the release row and on-disk artifact that caching a
// Linux release in Studio produces.
func cacheLinuxRelease(t *testing.T, env activityTestEnvironment, root string, body []byte) string {
	t.Helper()
	digest := sha256.Sum256(body)
	hash := hex.EncodeToString(digest[:])
	id := uuid.New()
	if _, err := env.pool.Exec(context.Background(), `INSERT INTO player_releases(id,github_release_id,github_tag,channel,version_code,version_name,application_id,minimum_sdk,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_signature,apk_download_url,cache_status,verification_status,platform,player_family)
		VALUES($1,$2,$3,'stable',12000,'0.12.0',NULL,NULL,now(),'tilecast-player.AppImage',$4,$5,'','{}'::jsonb,'','https://example.invalid/artifact','cached','verified','linux','electron-linux')`,
		id, int64(4210), "player-linux-v0.12.0", int64(len(body)), hash); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, id.String()+".appimage"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	return hash
}

func TestInstallScriptCarriesTheServerAddress(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.publicURL = "https://signage.example.org/"
		recorder := httptest.NewRecorder()
		env.server.installScript(recorder, httptest.NewRequest(http.MethodGet, "/install.sh", nil))

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d", recorder.Code)
		}
		body := recorder.Body.String()
		if strings.Contains(body, installServerURLToken) {
			t.Fatal("the server address placeholder was not substituted")
		}
		if !strings.Contains(body, `readonly SERVER_URL="https://signage.example.org"`) {
			t.Fatalf("script does not carry the public URL: %s", firstLines(body, 30))
		}
		// A box that can reach only this server must not be sent elsewhere.
		if strings.Contains(body, "github.com") || strings.Contains(body, "githubusercontent") {
			t.Fatal("the installer reaches GitHub; it must fetch everything from the server")
		}
	})
}

func TestInstallScriptFallsBackToTheRequestHost(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.publicURL = ""
		request := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
		request.Host = "tilecast.internal"
		request.Header.Set("X-Forwarded-Proto", "https")
		recorder := httptest.NewRecorder()
		env.server.installScript(recorder, request)

		if !strings.Contains(recorder.Body.String(), `readonly SERVER_URL="https://tilecast.internal"`) {
			t.Fatalf("script does not carry the forwarded host: %s", firstLines(recorder.Body.String(), 30))
		}
	})
}

func TestServedPlayerUnitIncludesManagedHostToolPath(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		recorder := httptest.NewRecorder()
		env.server.playerServiceUnit(
			recorder,
			httptest.NewRequest(http.MethodGet, "/install/tilecast-player.service", nil),
		)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d", recorder.Code)
		}
		if !strings.Contains(
			recorder.Body.String(),
			"Environment=PATH=/usr/local/bin:/usr/bin:/bin",
		) {
			t.Fatal("served player unit does not define the managed host-tool PATH")
		}
	})
}

func TestInstallScriptRejectsAnUnsafeRequestURL(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.publicURL = ""
		request := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
		request.Host = "tilecast.example; touch /tmp/tilecast-owned"
		request.Header.Set("X-Forwarded-Proto", "https\nsh")
		recorder := httptest.NewRecorder()
		env.server.installScript(recorder, request)

		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "SERVER_URL=") {
			t.Fatal("unsafe request URL was interpolated into the installer")
		}
	})
}

func TestInstallScriptRejectsAnUnsafeConfiguredURL(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.publicURL = "https://signage.example.org/$(touch /tmp/tilecast-owned)"
		recorder := httptest.NewRecorder()
		env.server.installScript(recorder, httptest.NewRequest(http.MethodGet, "/install.sh", nil))

		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "SERVER_URL=") {
			t.Fatal("unsafe configured URL was interpolated into the installer")
		}
	})
}

func TestAirplayInstallScriptIsEmbeddedAndServedByTilecast(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		recorder := httptest.NewRecorder()
		env.server.airplayInstallScript(recorder, httptest.NewRequest(http.MethodGet, "/install-airplay.sh", nil))

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d", recorder.Code)
		}
		body := recorder.Body.String()
		if !strings.Contains(body, "UXPLAY_VERSION=\"1.73.6\"") || !strings.Contains(body, "apt-get install") {
			t.Fatalf("unexpected AirPlay installer body: %s", firstLines(body, 20))
		}
	})
}

// The build toolchain is roughly 800 MB with its transitive closure on Debian
// Trixie, which is not something to leave behind on a 4 GB signage box. It must
// be installed only for the build, and only the packages this script actually
// added may be removed again.
func TestAirplayInstallerSeparatesRuntimeFromBuildDependencies(t *testing.T) {
	raw, err := installAssets.ReadFile("install/install-airplay-support.sh")
	if err != nil {
		t.Fatal(err)
	}
	script := string(raw)

	runtimeBlock := installerVariableBlock(t, script, "RUNTIME_PACKAGES")
	buildBlock := installerVariableBlock(t, script, "BUILD_PACKAGES")

	// A package that only exists to compile UxPlay must not be in the set that
	// stays on the machine.
	for _, buildOnly := range []string{"build-essential", "cmake", "pkg-config", "libssl-dev", "libplist-dev", "libx11-dev", "libgstreamer1.0-dev", "libgstreamer-plugins-base1.0-dev", "libavahi-compat-libdnssd-dev"} {
		if strings.Contains(runtimeBlock, buildOnly) {
			t.Errorf("%s is a build-only package but is installed permanently", buildOnly)
		}
		if !strings.Contains(buildBlock, buildOnly) {
			t.Errorf("%s is missing from the build toolchain", buildOnly)
		}
	}
	// UxPlay and the RTP receivers cannot run without these.
	for _, runtime := range []string{"gstreamer1.0-tools", "gstreamer1.0-plugins-base", "gstreamer1.0-plugins-bad", "gstreamer1.0-libav", "avahi-daemon", "vainfo"} {
		if !strings.Contains(runtimeBlock, runtime) {
			t.Errorf("%s is required at run time but is not installed permanently", runtime)
		}
	}

	// Removal is scoped to the diff of dpkg's installed list around the
	// toolchain install, never a blanket autoremove.
	if !strings.Contains(script, "comm -13") || !strings.Contains(script, "airplay-build-packages") {
		t.Error("the installer does not record which packages it installed before removing them")
	}
	// The record must accumulate, not be replaced. A run that installs the
	// toolchain and then fails leaves it on disk; on the retry those packages
	// are already present so the diff is empty, and truncating here would
	// forget them and leak the whole toolchain permanently.
	if !strings.Contains(script, `comm -13 "${before_packages}" "${after_packages}" >> "${BUILD_PACKAGE_STATE}"`) {
		t.Error("the recorded build-package state is overwritten instead of merged, so a failed-then-retried build leaks the toolchain")
	}
	if !strings.Contains(script, `sort -u -o "${BUILD_PACKAGE_STATE}" "${BUILD_PACKAGE_STATE}"`) {
		t.Error("the merged build-package state is not deduplicated and sorted")
	}
	if strings.Contains(script, "apt-get autoremove") {
		t.Error("the installer autoremoves packages instead of removing only what it installed")
	}
	// A verified UxPlay must survive the cleanup, and the cleanup is skipped if
	// apt would take one of its runtime libraries with it.
	if !strings.Contains(script, "apt-get -s purge") {
		t.Error("the installer purges the toolchain without simulating the removal first")
	}
	if !strings.Contains(script, "ldd \"${UXPLAY_BIN}\"") {
		t.Error("the installer does not protect the libraries the built uxplay links against")
	}
	// Re-running on a provisioned box must not reinstall the toolchain at all.
	if !strings.Contains(script, "skipping the build toolchain") {
		t.Error("the installer does not skip the toolchain when UxPlay is already at the baseline")
	}
	if !strings.Contains(script, "uxplay -v") {
		t.Error("the installer does not verify the resulting UxPlay")
	}
}

// The served scripts are only ever executed on a signage box during
// provisioning, where a syntax error costs a site visit. Parse them here.
func TestServedInstallScriptsParse(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not available")
	}
	for _, name := range []string{"install/install-tilecast-player.sh", "install/install-airplay-support.sh"} {
		raw, readErr := installAssets.ReadFile(name)
		if readErr != nil {
			t.Fatal(readErr)
		}
		// The served script always has the token substituted; parse the same
		// shape a player receives.
		script := strings.ReplaceAll(string(raw), installServerURLToken, "https://tilecast.example.org")
		command := exec.Command(bash, "-n")
		command.Stdin = strings.NewReader(script)
		if output, runErr := command.CombinedOutput(); runErr != nil {
			t.Errorf("%s does not parse: %v\n%s", name, runErr, output)
		}
	}
}

// installerVariableBlock returns the body of a `readonly NAME="..."` assignment.
func installerVariableBlock(t *testing.T, script, name string) string {
	t.Helper()
	match := regexp.MustCompile(`(?s)readonly ` + regexp.QuoteMeta(name) + `="(.*?)"`).FindStringSubmatch(script)
	if match == nil {
		t.Fatalf("the AirPlay installer does not define %s", name)
	}
	return match[1]
}

func TestAirplayCleanupCommandWakesThePlayerAndDeduplicates(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		var organizationID uuid.UUID
		if err := env.pool.QueryRow(context.Background(), `SELECT organization_id FROM screens WHERE id=$1`, env.screenID).Scan(&organizationID); err != nil {
			t.Fatal(err)
		}
		messages := make(chan map[string]any, 2)
		unregister := env.server.devices.RegisterPresenceWithNotifier(env.screenID, nil, func(message map[string]any) error {
			messages <- message
			return nil
		})
		defer unregister()

		sessionID := uuid.New()
		payload := []byte(`{"sessionId":"` + sessionID.String() + `","reason":"expired"}`)
		if err := env.server.queueAirplayStopCommand(context.Background(), organizationID, env.screenID, uuid.Nil, payload); err != nil {
			t.Fatal(err)
		}
		if err := env.server.queueAirplayStopCommand(context.Background(), organizationID, env.screenID, uuid.Nil, payload); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_commands WHERE screen_id=$1 AND type='stop_airplay_session' AND payload->>'sessionId'=$2`, env.screenID, sessionID.String()).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("cleanup command count = %d, want one", count)
		}
		select {
		case message := <-messages:
			if message["type"] != "commands.available" {
				t.Fatalf("wake message = %#v", message)
			}
		case <-time.After(time.Second):
			t.Fatal("cleanup command did not wake the connected player")
		}
	})
}

func TestAirPlayInstallScriptUsesOnlyTheTilecastServer(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.installLimiter = newRateLimiter(60, time.Minute)
		origin := httptest.NewServer(env.server.routes())
		defer origin.Close()
		env.server.publicURL = origin.URL

		response, err := origin.Client().Get(origin.URL + "/install-airplay.sh")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("script status = %d, body = %s", response.StatusCode, string(body))
		}
		script := string(body)
		if strings.Contains(script, installServerURLToken) {
			t.Fatal("the server address placeholder was not substituted")
		}
		if !strings.Contains(script, `readonly SERVER_URL="`+origin.URL+`"`) {
			t.Fatalf("script does not carry the server URL: %s", firstLines(script, 20))
		}
		if strings.Contains(script, "git clone") || strings.Contains(script, "github.com") || strings.Contains(script, "githubusercontent") {
			t.Fatal("the AirPlay installer reaches a source-code host")
		}
		if !strings.Contains(script, "uxplay -v") || strings.Contains(script, "uxplay --version") {
			t.Fatal("the AirPlay installer does not use UxPlay's supported version flag")
		}
		for _, match := range regexp.MustCompile(`https?://[^[:space:]"']+`).FindAllString(script, -1) {
			if !strings.HasPrefix(match, origin.URL) {
				t.Fatalf("the AirPlay installer contains a non-Tilecast URL: %s", match)
			}
		}

		paths := scriptFetchPaths(script)
		if len(paths) != 2 {
			t.Fatalf("AirPlay installer fetch paths = %v, want checksum and archive", paths)
		}
		for _, path := range paths {
			fetched, err := origin.Client().Get(origin.URL + path)
			if err != nil {
				t.Fatalf("GET %s: %v", path, err)
			}
			fetchedBody, _ := io.ReadAll(fetched.Body)
			fetched.Body.Close()
			if fetched.StatusCode != http.StatusOK || len(fetchedBody) == 0 {
				t.Fatalf("GET %s = %d with %d bytes", path, fetched.StatusCode, len(fetchedBody))
			}
		}
	})
}

func TestEmbeddedUxPlayArtifactMatchesPinnedIdentity(t *testing.T) {
	archive, err := installAssets.ReadFile(installUxPlayArchive)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(archive)
	if got := hex.EncodeToString(digest[:]); got != installUxPlaySHA256 {
		t.Fatalf("embedded archive SHA-256 = %s, want %s", got, installUxPlaySHA256)
	}

	gzipReader, err := gzip.NewReader(strings.NewReader(string(archive)))
	if err != nil {
		t.Fatal(err)
	}
	defer gzipReader.Close()
	want := map[string]bool{
		"UxPlay-" + installUxPlayVersion + "/CMakeLists.txt": false,
		"UxPlay-" + installUxPlayVersion + "/LICENSE":        false,
		"UxPlay-" + installUxPlayVersion + "/uxplay.cpp":     false,
	}
	tarReader := tar.NewReader(gzipReader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := want[header.Name]; ok {
			want[header.Name] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("embedded UxPlay archive is missing %s", name)
		}
	}

	server := &server{}
	artifact := httptest.NewRecorder()
	server.installableUxPlayArtifact(artifact, httptest.NewRequest(http.MethodGet, installUxPlayArchiveURL, nil))
	if artifact.Code != http.StatusOK {
		t.Fatalf("artifact status = %d", artifact.Code)
	}
	served := sha256.Sum256(artifact.Body.Bytes())
	if hex.EncodeToString(served[:]) != installUxPlaySHA256 {
		t.Fatal("served UxPlay artifact does not match its pinned checksum")
	}

	checksum := httptest.NewRecorder()
	server.installableUxPlayChecksum(checksum, httptest.NewRequest(http.MethodGet, installUxPlayArchiveURL+".sha256", nil))
	if strings.TrimSpace(checksum.Body.String()) != installUxPlaySHA256 {
		t.Fatalf("published checksum = %q", checksum.Body.String())
	}
}
func TestInstallableLinuxReleaseReportsNothingUntilOneIsCached(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.updates = newTestUpdateService(t, env, t.TempDir())
		recorder := httptest.NewRecorder()
		env.server.installableLinuxRelease(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/install/linux", nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404 before a release is cached", recorder.Code)
		}
	})
}

func TestInstallableLinuxReleaseServesTheCachedArtifact(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		root := t.TempDir()
		env.server.updates = newTestUpdateService(t, env, root)
		body := []byte("AppImage payload")
		hash := cacheLinuxRelease(t, env, root, body)

		recorder := httptest.NewRecorder()
		env.server.installableLinuxRelease(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/install/linux", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
		var payload struct {
			Data struct {
				VersionName string `json:"versionName"`
				SizeBytes   int64  `json:"sizeBytes"`
				SHA256      string `json:"sha256"`
			} `json:"data"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Data.VersionName != "0.12.0" || payload.Data.SHA256 != hash || payload.Data.SizeBytes != int64(len(body)) {
			t.Fatalf("release metadata = %#v", payload.Data)
		}

		// The checksum the script verifies has to match the bytes it receives,
		// or every install fails on a mismatch it cannot diagnose.
		artifact := httptest.NewRecorder()
		env.server.installableLinuxArtifact(artifact, httptest.NewRequest(http.MethodGet, "/api/v1/install/linux/artifact", nil))
		if artifact.Code != http.StatusOK {
			t.Fatalf("artifact status = %d", artifact.Code)
		}
		served := sha256.Sum256(artifact.Body.Bytes())
		if hex.EncodeToString(served[:]) != hash {
			t.Fatal("served artifact does not match the advertised checksum")
		}
	})
}

// A beta or unverified release must not be handed to a new machine.
func TestInstallableLinuxReleaseIgnoresBetaAndUnverifiedReleases(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		root := t.TempDir()
		env.server.updates = newTestUpdateService(t, env, root)
		cacheLinuxRelease(t, env, root, []byte("AppImage payload"))
		if _, err := env.pool.Exec(context.Background(), `UPDATE player_releases SET channel='beta'`); err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		env.server.installableLinuxRelease(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/install/linux", nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("beta release status = %d, want 404", recorder.Code)
		}

		if _, err := env.pool.Exec(context.Background(), `UPDATE player_releases SET channel='stable',verification_status='verified_manifest'`); err != nil {
			t.Fatal(err)
		}
		recorder = httptest.NewRecorder()
		env.server.installableLinuxRelease(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/install/linux", nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("unverified release status = %d, want 404", recorder.Code)
		}
	})
}

func newTestUpdateService(t *testing.T, env activityTestEnvironment, root string) *updates.Service {
	t.Helper()
	service, err := updates.NewService(env.pool, nil, updates.Config{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func firstLines(body string, count int) string {
	lines := strings.SplitN(body, "\n", count+1)
	if len(lines) > count {
		lines = lines[:count]
	}
	return strings.Join(lines, "\n")
}

// Every URL the served script fetches has to be a route this server answers. A
// typo here is invisible until a provisioning run fails on a real machine, so
// the paths are extracted from the script itself rather than restated.
func TestInstallScriptOnlyFetchesRoutesTheServerServes(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		root := t.TempDir()
		env.server.updates = newTestUpdateService(t, env, root)
		cacheLinuxRelease(t, env, root, []byte("AppImage payload"))

		// The shared harness builds a server value directly, so the limiters
		// New() would have created are nil. Provisioning routes go through one.
		env.server.installLimiter = newRateLimiter(60, time.Minute)
		origin := httptest.NewServer(env.server.routes())
		defer origin.Close()
		env.server.publicURL = origin.URL

		script := httptest.NewRecorder()
		env.server.installScript(script, httptest.NewRequest(http.MethodGet, "/install.sh", nil))
		paths := scriptFetchPaths(script.Body.String())
		if len(paths) < 4 {
			t.Fatalf("expected the installer to fetch several server paths, found %v", paths)
		}

		for _, path := range paths {
			response, err := origin.Client().Get(origin.URL + path)
			if err != nil {
				t.Fatalf("GET %s: %v", path, err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("GET %s = %d, body = %s", path, response.StatusCode, string(body))
			}
			if len(body) == 0 {
				t.Fatalf("GET %s served an empty body", path)
			}
		}
	})
}

// scriptFetchPaths pulls the "${SERVER_URL}/..." targets out of the script.
func scriptFetchPaths(script string) []string {
	seen := map[string]bool{}
	paths := []string{}
	for _, match := range regexp.MustCompile(`\$\{SERVER_URL\}(/[A-Za-z0-9._/-]+)`).FindAllStringSubmatch(script, -1) {
		path := match[1]
		// /screens is the Studio link printed in the summary, not a fetch.
		if seen[path] || path == "/screens" {
			continue
		}
		seen[path] = true
		paths = append(paths, path)
	}
	return paths
}
