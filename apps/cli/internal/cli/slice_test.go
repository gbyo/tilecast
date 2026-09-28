package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

func sliceFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_slice")
	return f
}

func TestStatusHumanAndJSON(t *testing.T) {
	f := sliceFixture(t)
	out, err := f.execute(t, "", "status")
	if err != nil || !strings.Contains(out, "op (owner)") {
		t.Fatalf("status = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("status --json is not JSON: %q", out)
	}
	if payload["username"] != "op" || payload["authenticated"] != true {
		t.Fatalf("status payload = %v", payload)
	}
}

// Result data belongs on stdout so pipelines such as `tilecast screen list
// --json | jq` receive it; stderr is for progress and warnings only. The
// process streams are captured directly because production sets no Cobra
// writers, and Cobra's Print helpers fall back to stderr in that case.
func TestResultDataGoesToStdout(t *testing.T) {
	f := sliceFixture(t)
	for _, args := range [][]string{
		{"screen", "list", "--json"},
		{"status", "--json"},
		{"whoami"},
		{"context", "current"},
	} {
		stdout, stderr := captureProcessOutput(t, func() {
			root := NewRootCommandWithEnv(f.env)
			root.SetArgs(args)
			if err := root.Execute(); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
		if stdout == "" || stderr != "" {
			t.Fatalf("%v: stdout %q, stderr %q", args, stdout, stderr)
		}
	}
}

func captureProcessOutput(t *testing.T, run func()) (string, string) {
	t.Helper()
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errRead, errWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	savedOut, savedErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outWrite, errWrite
	run()
	os.Stdout, os.Stderr = savedOut, savedErr
	_ = outWrite.Close()
	_ = errWrite.Close()
	stdout, _ := io.ReadAll(outRead)
	stderr, _ := io.ReadAll(errRead)
	return string(stdout), string(stderr)
}

func TestScreenListAndGet(t *testing.T) {
	f := sliceFixture(t)
	out, err := f.execute(t, "", "screen", "list")
	if err != nil || !strings.Contains(out, "lobby") || !strings.Contains(out, "online") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "screen", "list", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var screens []map[string]any
	if err := json.Unmarshal([]byte(out), &screens); err != nil || len(screens) != 3 {
		t.Fatalf("list --json = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "screen", "get", "11111111-1111-1111-1111-111111111111")
	if err != nil || !strings.Contains(out, "lobby") {
		t.Fatalf("get id = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "screen", "get", "lobby")
	if err != nil || !strings.Contains(out, "11111111") {
		t.Fatalf("get name = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "screen", "get", "hall"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous name accepted: %v", err)
	}
	if _, err := f.execute(t, "", "screen", "get", "missing"); err == nil {
		t.Fatal("unknown name accepted")
	}
	if _, err := f.execute(t, "", "screen", "get", "99999999-9999-9999-9999-999999999999"); err == nil {
		t.Fatal("unknown id accepted")
	}
}

func TestSettingsGetSetEffective(t *testing.T) {
	f := sliceFixture(t)
	out, err := f.execute(t, "", "settings", "get")
	if err != nil || !strings.Contains(out, "power.active_hours_end=\"17:00\"") || !strings.Contains(out, "revision=7") {
		t.Fatalf("get = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "settings", "set", "power.active_hours_end=18:00", "display.brightness=80")
	if err != nil || !strings.Contains(out, "revision=8") {
		t.Fatalf("set = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "settings", "get", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var document settingsDocument
	if err := json.Unmarshal([]byte(out), &document); err != nil {
		t.Fatalf("get --json is not JSON: %q", out)
	}
	if document.Values["display.brightness"] != float64(80) || document.Revision != 8 {
		t.Fatalf("document = %+v", document)
	}
	out, err = f.execute(t, "", "settings", "effective", "lobby")
	if err != nil || !strings.Contains(out, "scheduled") {
		t.Fatalf("effective = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "settings", "set", "no-equals"); err == nil {
		t.Fatal("bad assignment accepted")
	}
	if _, err := f.execute(t, "", "settings", "get", "--scope", "screen"); err == nil {
		t.Fatal("bad scope accepted")
	}
}

func TestSettingsSetSurfacesConflict(t *testing.T) {
	f := sliceFixture(t)
	out, err := f.execute(t, "", "settings", "set", "a.b=c")
	if err != nil || !strings.Contains(out, "Updated 1 setting(s)") {
		t.Fatalf("set = %q, %v", out, err)
	}
	// A server that always conflicts must surface the clean retry
	// message, never a raw dump.
	stale := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/settings" && r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"data":{"revision":1,"values":{}}}`))
			return
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"revision_conflict","message":"stale"},"data":{"expectedRevision":1,"currentRevision":9}}`))
	}))
	defer stale.Close()
	_, err = f.execute(t, "", "settings", "set", "--server", stale.URL, "a.b=c")
	if err == nil || !strings.Contains(err.Error(), "changed under you") {
		t.Fatalf("conflict = %v", err)
	}
}

func TestTimeoutFlagValidation(t *testing.T) {
	f := sliceFixture(t)
	if _, err := f.execute(t, "", "status", "--timeout", "forever"); err == nil {
		t.Fatal("bad timeout accepted")
	}
}
