package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplestate"
)

// TestPluginDeliveryStatusAPI drives the status route and the parked
// delivery actions through the production router: every plugin user reads
// the status, only an Owner retries or discards, and neither the status nor
// the audit event carries a payload.
func TestPluginDeliveryStatusAPI(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(samplestate.New()))
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		sessions := map[string]auth.Session{}
		var ownerID uuid.UUID
		for _, role := range []string{"owner", "administrator", "viewer"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			id := uuid.New()
			if role == "owner" {
				ownerID = id
			}
			if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`,
				id, role, "deliveries-"+role, hash, role); err != nil {
				t.Fatal(err)
			}
			result, err := authService.Login(ctx, auth.LoginInput{Username: "deliveries-" + role, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
			if err != nil || result.Session == nil {
				t.Fatalf("login %s: %v", role, err)
			}
			sessions[role] = *result.Session
		}
		if _, _, err := env.server.plugins.Install(ctx, samplestate.ID, ownerID); err != nil {
			t.Fatal(err)
		}
		park := func(key, payload string) uuid.UUID {
			t.Helper()
			id := uuid.New()
			if _, err := env.pool.Exec(ctx, `INSERT INTO plugin_deliveries(id,plugin_id,definition_version,kind,source,subject,payload,due_at,next_attempt_at,attempts,state,parked_at,last_error)
				VALUES($1,$2,1,'timer',$3,'timer:'||$3,$4,now(),now(),8,'parked',now(),'handler_error')`, id, samplestate.ID, key, []byte(payload)); err != nil {
				t.Fatal(err)
			}
			return id
		}
		call := func(role, method, path string) (int, string) {
			t.Helper()
			request, err := http.NewRequest(method, router.URL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			session := sessions[role]
			request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
			request.Header.Set("X-CSRF-Token", session.CSRFToken)
			response, err := router.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			raw, _ := io.ReadAll(response.Body)
			return response.StatusCode, string(raw)
		}
		parked := park("sync", "secret-looking payload")
		base := "/api/v1/plugins/" + samplestate.ID
		status, body := call("viewer", http.MethodGet, base+"/status")
		if status != http.StatusOK || strings.Contains(body, "secret-looking") {
			t.Fatalf("status = %d %s", status, body)
		}
		var decoded struct {
			Data plugins.PluginStatus `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &decoded); err != nil {
			t.Fatal(err)
		}
		if !decoded.Data.Installed || decoded.Data.Deliveries.ParkedCount != 1 || decoded.Data.Deliveries.Parked[0].ID != parked ||
			decoded.Data.Deliveries.Parked[0].Subject != "sync" || decoded.Data.Deliveries.Parked[0].LastError != "handler_error" {
			t.Fatalf("status = %+v", decoded.Data)
		}
		// An Administrator holds plugins.manage but not the Owner-reserved
		// capability; a viewer holds neither.
		for _, role := range []string{"administrator", "viewer"} {
			if status, _ := call(role, http.MethodPost, base+"/deliveries/"+parked.String()+"/retry"); status != http.StatusForbidden {
				t.Fatalf("%s retry = %d", role, status)
			}
			if status, _ := call(role, http.MethodDelete, base+"/deliveries/"+parked.String()); status != http.StatusForbidden {
				t.Fatalf("%s discard = %d", role, status)
			}
		}
		if status, body := call("owner", http.MethodPost, base+"/deliveries/"+parked.String()+"/retry"); status != http.StatusOK || strings.Contains(body, "secret-looking") {
			t.Fatalf("owner retry = %d %s", status, body)
		}
		// The retried delivery is pending again; a second retry finds nothing parked.
		if status, _ := call("owner", http.MethodPost, base+"/deliveries/"+parked.String()+"/retry"); status != http.StatusNotFound {
			t.Fatalf("retry of a pending delivery = %d", status)
		}
		discarded := park("sync-later", "x")
		if status, _ := call("owner", http.MethodDelete, base+"/deliveries/"+discarded.String()); status != http.StatusOK {
			t.Fatalf("owner discard = %d", status)
		}
		if status, _ := call("owner", http.MethodDelete, base+"/deliveries/not-a-uuid"); status != http.StatusNotFound {
			t.Fatalf("discard of a malformed ID = %d", status)
		}
		rows, err := env.pool.Query(ctx, `SELECT action, metadata::text FROM audit_logs WHERE action LIKE 'plugin.delivery.%' ORDER BY created_at`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		actions := []string{}
		for rows.Next() {
			var action, metadata string
			if err := rows.Scan(&action, &metadata); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(metadata, "secret-looking") || !strings.Contains(metadata, `"subject": "sync`) || !strings.Contains(metadata, `"kind": "timer"`) {
				t.Fatalf("audit metadata = %s", metadata)
			}
			actions = append(actions, action)
		}
		if strings.Join(actions, ",") != "plugin.delivery.retried,plugin.delivery.discarded" {
			t.Fatalf("audit = %v", actions)
		}
	})
}
