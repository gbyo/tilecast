package demo

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSimulatorAcknowledgesUnsupportedCapture(t *testing.T) {
	for _, test := range []struct {
		name            string
		active, capture bool
		wantUploads     int
	}{
		{"inactive", false, true, 0},
		{"no capture requested", true, false, 0},
		{"capture requested", true, true, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			uploads := 0
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-only-credential" {
					t.Error("missing device authentication")
				}
				switch r.URL.Path {
				case "/api/v1/player/preview-session":
					if r.Method != http.MethodGet {
						t.Error("session must use GET")
					}
					_, _ = fmt.Fprintf(w, `{"data":{"active":%t,"captureNow":%t}}`, test.active, test.capture)
				case "/api/v1/player/preview":
					uploads++
					if r.Method != http.MethodPost {
						t.Error("upload must use POST")
					}
					if err := r.ParseMultipartForm(1024); err != nil {
						t.Fatal(err)
					}
					defer r.MultipartForm.RemoveAll()
					if r.FormValue("failureStatus") != "capture_unsupported" || r.FormValue("playerVersion") != "0.25.0" || len(r.MultipartForm.File) != 0 {
						t.Errorf("unexpected capture: %+v", r.MultipartForm)
					}
					w.WriteHeader(http.StatusNoContent)
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer api.Close()
			simulator := &Simulator{baseURL: api.URL, client: api.Client()}
			player := Player{Credential: "test-only-credential", Device: Device{PlayerVersion: "0.25.0"}}
			if err := simulator.handlePreview(context.Background(), player); err != nil {
				t.Fatal(err)
			}
			if uploads != test.wantUploads {
				t.Errorf("uploads = %d, want %d", uploads, test.wantUploads)
			}
		})
	}
}
