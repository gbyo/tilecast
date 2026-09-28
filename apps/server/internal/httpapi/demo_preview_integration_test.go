package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/tilecast/tilecast/apps/server/internal/demo"
)

// Cross production device authentication and preview handlers, then verify
// that the simulator consumed the real PostgreSQL capture request.
func TestDemoPreviewAcknowledgementUsesAuthenticatedUpload(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		publicID := strings.ToLower(ulid.Make().String())
		secretBytes := make([]byte, 32)
		if _, err := rand.Read(secretBytes); err != nil {
			t.Fatal(err)
		}
		secret := base64.RawURLEncoding.EncodeToString(secretBytes)
		hash := sha256.Sum256([]byte(secret))
		if _, err := env.pool.Exec(ctx, `UPDATE device_credentials SET public_id=$1,secret_hash=$2 WHERE screen_id=$3`, publicID, hash[:], env.screenID); err != nil {
			t.Fatal(err)
		}
		service := env.server.previewService()
		if _, err := service.Renew(ctx, env.screenID, true); err != nil {
			t.Fatal(err)
		}
		// Only unrelated transport responses are abbreviated here. Preview
		// routes below use unmodified production handlers and authentication.
		transport := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/system/identity":
				_, _ = fmt.Fprintf(w, `{"data":{"installationId":%q}}`, demo.InstallationID)
			case "/api/v1/player/manifest":
				_, _ = w.Write([]byte(`{"data":{"manifestVersion":1}}`))
			case "/api/v1/player/heartbeat":
				w.WriteHeader(http.StatusNoContent)
			case "/api/v1/player/commands":
				_, _ = w.Write([]byte(`{"data":{"items":[]}}`))
			default:
				http.NotFound(w, r)
			}
		})
		api := httptest.NewServer(env.server.previewRoutes(transport))
		defer api.Close()
		response, err := api.Client().Get(api.URL + "/api/v1/player/preview-session")
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated session = %d", response.StatusCode)
		}
		simulator := demo.StartSimulator(ctx, api.URL, []demo.Player{{ScreenID: env.screenID, ScreenName: "Demo TV", Credential: "tc_device_" + publicID + "." + secret, Device: demo.Device{PlayerVersion: "0.25.0"}}}, slog.New(slog.DiscardHandler))
		defer simulator.Stop()
		for {
			metadata, err := service.GetMetadata(ctx, env.screenID)
			if err != nil {
				t.Fatal(err)
			}
			if metadata.Status == "capture_error" {
				if metadata.CaptureFailureStatus != "capture_unsupported" || metadata.ImageAvailable || metadata.CapturedAt != nil || metadata.PlayerVersion != "0.25.0" {
					t.Fatalf("unexpected metadata: %+v", metadata)
				}
				session, err := service.PlayerSession(ctx, env.screenID)
				if err != nil || session.CaptureNow {
					t.Fatalf("capture request was not consumed: %+v, %v", session, err)
				}
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("capture acknowledgement did not arrive: %+v", simulator.Statuses())
			case <-time.After(20 * time.Millisecond):
			}
		}
	})
}
