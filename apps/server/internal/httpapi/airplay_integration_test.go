package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

func airplayCreateTestSetup(t *testing.T, env activityTestEnvironment) {
	t.Helper()
	env.server.operations = OperationsConfig{
		MaxPendingCommands:          50,
		DefaultCommandExpiryMinutes: 10,
		CommandRetentionDays:        30,
	}
	if _, err := env.pool.Exec(context.Background(), `UPDATE screens SET last_heartbeat_at=now(),last_known_ip='192.0.2.10'::inet,enabled=true WHERE id=$1`, env.screenID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `UPDATE screens SET platform='linux',android_version='' WHERE id=$1`, env.screenID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `INSERT INTO screen_player_status(screen_id,airplay_supported,airplay_uxplay_installed,airplay_gstreamer_installed,airplay_h264_decoder_available,airplay_hardware_decode,airplay_decoder,airplay_max_profile,airplay_group_supported,airplay_audio_available,airplay_avahi_available,airplay_mdns_advertisement_available,airplay_multicast_supported)
		VALUES($1,true,true,true,true,true,'vah264dec','1080p30',true,true,true,true,true)`, env.screenID); err != nil {
		t.Fatal(err)
	}
}

func airplayDashboardRequest(method, path string, body []byte, session auth.Session) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if session.User.ID != uuid.Nil {
		request = requestWithTestPrincipal(request, session)
	}
	if id := pathParam(path, "airplay/sessions/"); id != "" {
		route := chi.NewRouteContext()
		route.URLParams.Add("id", id)
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
	}
	return request
}

func pathParam(path, prefix string) string {
	start := 0
	if index := bytes.Index([]byte(path), []byte(prefix)); index >= 0 {
		start = index + len(prefix)
	} else {
		return ""
	}
	end := start
	for end < len(path) && path[end] != '/' && path[end] != '?' {
		end++
	}
	return path[start:end]
}

func airplayCreateBody(screenID uuid.UUID) []byte {
	body, _ := json.Marshal(airplaySessionInput{
		TargetType:      "screen",
		TargetID:        screenID,
		DurationMinutes: 15,
		Transport:       "auto",
		AudioMode:       "none",
	})
	return body
}

func TestAirplaySessionCreationPersistsAssignmentAndStopIsIdempotent(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		airplayCreateTestSetup(t, env)

		unauthenticated := httptest.NewRecorder()
		env.server.createAirplaySession(unauthenticated, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions", airplayCreateBody(env.screenID), auth.Session{}))
		if unauthenticated.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated create status = %d, want 401", unauthenticated.Code)
		}

		created := httptest.NewRecorder()
		env.server.createAirplaySession(created, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions", airplayCreateBody(env.screenID), env.owner))
		if created.Code != http.StatusAccepted {
			t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
		}
		var createdEnvelope struct {
			Data struct {
				ID uuid.UUID `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(created.Body.Bytes(), &createdEnvelope); err != nil {
			t.Fatal(err)
		}
		if createdEnvelope.Data.ID == uuid.Nil {
			t.Fatal("create response did not contain a session ID")
		}

		var assignedSession uuid.UUID
		var assignedState, assignedRole string
		if err := env.pool.QueryRow(context.Background(), `SELECT external_presentation_session_id,external_presentation_state,external_presentation_role FROM screen_player_status WHERE screen_id=$1`, env.screenID).Scan(&assignedSession, &assignedState, &assignedRole); err != nil {
			t.Fatal(err)
		}
		if assignedSession != createdEnvelope.Data.ID || assignedState != "preparing" || assignedRole != "single" {
			t.Fatalf("server assignment = %s/%s/%s, want created/preparing/single", assignedSession, assignedState, assignedRole)
		}
		var prepareCount int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_commands WHERE screen_id=$1 AND type='prepare_airplay_session' AND payload->>'sessionId'=$2`, env.screenID, createdEnvelope.Data.ID.String()).Scan(&prepareCount); err != nil {
			t.Fatal(err)
		}
		if prepareCount != 1 {
			t.Fatalf("prepare command count = %d, want one", prepareCount)
		}

		duplicate := httptest.NewRecorder()
		env.server.createAirplaySession(duplicate, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions", airplayCreateBody(env.screenID), env.owner))
		if duplicate.Code != http.StatusConflict {
			t.Fatalf("duplicate create status = %d, body = %s", duplicate.Code, duplicate.Body.String())
		}

		stopBody := []byte(`{"reason":"manual_stop"}`)
		stopped := httptest.NewRecorder()
		env.server.stopAirplaySession(stopped, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions/"+createdEnvelope.Data.ID.String()+"/stop", stopBody, env.owner))
		if stopped.Code != http.StatusOK {
			t.Fatalf("stop status = %d, body = %s", stopped.Code, stopped.Body.String())
		}
		var sessionStatus string
		var pin, deviceID *string
		if err := env.pool.QueryRow(context.Background(), `SELECT status,pin,device_id FROM external_presentation_sessions WHERE id=$1`, createdEnvelope.Data.ID).Scan(&sessionStatus, &pin, &deviceID); err != nil {
			t.Fatal(err)
		}
		if sessionStatus != "ended" || pin != nil || deviceID != nil {
			t.Fatalf("stopped session = %q pin=%v device=%v", sessionStatus, pin, deviceID)
		}
		var clearedSession *uuid.UUID
		if err := env.pool.QueryRow(context.Background(), `SELECT external_presentation_session_id FROM screen_player_status WHERE screen_id=$1`, env.screenID).Scan(&clearedSession); err != nil {
			t.Fatal(err)
		}
		if clearedSession != nil {
			t.Fatalf("screen assignment retained session %s", *clearedSession)
		}
		var stopCount int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_commands WHERE screen_id=$1 AND type='stop_airplay_session' AND payload->>'sessionId'=$2`, env.screenID, createdEnvelope.Data.ID.String()).Scan(&stopCount); err != nil {
			t.Fatal(err)
		}
		if stopCount != 1 {
			t.Fatalf("stop command count = %d, want one", stopCount)
		}

		stoppedAgain := httptest.NewRecorder()
		env.server.stopAirplaySession(stoppedAgain, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions/"+createdEnvelope.Data.ID.String()+"/stop", stopBody, env.owner))
		if stoppedAgain.Code != http.StatusOK {
			t.Fatalf("idempotent stop status = %d, body = %s", stoppedAgain.Code, stoppedAgain.Body.String())
		}
		var stopCountAfter int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_commands WHERE screen_id=$1 AND type='stop_airplay_session' AND payload->>'sessionId'=$2`, env.screenID, createdEnvelope.Data.ID.String()).Scan(&stopCountAfter); err != nil {
			t.Fatal(err)
		}
		if stopCountAfter != 1 {
			t.Fatalf("idempotent stop added a command: count = %d", stopCountAfter)
		}
	})
}

func TestAirplayManualStopReportsCommandQueueFailureAndCanRetry(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		airplayCreateTestSetup(t, env)
		sessionID := createAirplaySessionForStopTest(t, env)
		removeFailure := installAirplayStopCommandFailure(t, env)

		stopped := httptest.NewRecorder()
		env.server.stopAirplaySession(stopped, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions/"+sessionID.String()+"/stop", []byte(`{"reason":"manual_stop"}`), env.owner))
		assertAirplayStopFailure(t, stopped)
		assertAirplayStopRolledBack(t, env, sessionID)

		removeFailure()
		retried := httptest.NewRecorder()
		env.server.stopAirplaySession(retried, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions/"+sessionID.String()+"/stop", []byte(`{"reason":"manual_stop"}`), env.owner))
		if retried.Code != http.StatusOK {
			t.Fatalf("retry stop status = %d, body = %s", retried.Code, retried.Body.String())
		}
		assertAirplayStopCommitted(t, env, sessionID)
	})
}

func TestAirplayManualStopReportsDatabaseFailureAndRollsBackQueuedCommand(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		airplayCreateTestSetup(t, env)
		sessionID := createAirplaySessionForStopTest(t, env)
		installAirplayStoppedStateFailure(t, env)

		stopped := httptest.NewRecorder()
		env.server.stopAirplaySession(stopped, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions/"+sessionID.String()+"/stop", []byte(`{"reason":"manual_stop"}`), env.owner))
		assertAirplayStopFailure(t, stopped)
		assertAirplayStopRolledBack(t, env, sessionID)
	})
}

func createAirplaySessionForStopTest(t *testing.T, env activityTestEnvironment) uuid.UUID {
	t.Helper()
	created := httptest.NewRecorder()
	env.server.createAirplaySession(created, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions", airplayCreateBody(env.screenID), env.owner))
	if created.Code != http.StatusAccepted {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var envelope struct {
		Data struct {
			ID uuid.UUID `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.ID == uuid.Nil {
		t.Fatal("create response did not contain a session ID")
	}
	return envelope.Data.ID
}

func installAirplayStopCommandFailure(t *testing.T, env activityTestEnvironment) func() {
	t.Helper()
	_, _ = env.pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS tilecast_test_reject_airplay_stop_command ON player_commands`)
	_, _ = env.pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS tilecast_test_reject_airplay_stop_command()`)
	if _, err := env.pool.Exec(context.Background(), `CREATE OR REPLACE FUNCTION tilecast_test_reject_airplay_stop_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.type = 'stop_airplay_session' THEN
		RAISE EXCEPTION 'injected AirPlay stop command failure';
	END IF;
	RETURN NEW;
END;
$$`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `CREATE TRIGGER tilecast_test_reject_airplay_stop_command BEFORE INSERT ON player_commands FOR EACH ROW EXECUTE FUNCTION tilecast_test_reject_airplay_stop_command()`); err != nil {
		t.Fatal(err)
	}
	remove := func() {
		_, _ = env.pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS tilecast_test_reject_airplay_stop_command ON player_commands`)
		_, _ = env.pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS tilecast_test_reject_airplay_stop_command()`)
	}
	t.Cleanup(remove)
	return remove
}

func installAirplayStoppedStateFailure(t *testing.T, env activityTestEnvironment) {
	t.Helper()
	_, _ = env.pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS tilecast_test_reject_airplay_stopped_state ON external_presentation_screen_states`)
	_, _ = env.pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS tilecast_test_reject_airplay_stopped_state()`)
	if _, err := env.pool.Exec(context.Background(), `CREATE OR REPLACE FUNCTION tilecast_test_reject_airplay_stopped_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.state = 'stopped' THEN
		RAISE EXCEPTION 'injected AirPlay participant state failure';
	END IF;
	RETURN NEW;
END;
$$`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `CREATE TRIGGER tilecast_test_reject_airplay_stopped_state BEFORE UPDATE ON external_presentation_screen_states FOR EACH ROW EXECUTE FUNCTION tilecast_test_reject_airplay_stopped_state()`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS tilecast_test_reject_airplay_stopped_state ON external_presentation_screen_states`)
		_, _ = env.pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS tilecast_test_reject_airplay_stopped_state()`)
	})
}

func assertAirplayStopFailure(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("stop status = %d, want %d; body = %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "airplay_stop_failed" {
		t.Fatalf("stop error code = %q, want airplay_stop_failed", envelope.Error.Code)
	}
}

func assertAirplayStopRolledBack(t *testing.T, env activityTestEnvironment, sessionID uuid.UUID) {
	t.Helper()
	var status, prepareState string
	var assignedSession *uuid.UUID
	var stopCount int
	if err := env.pool.QueryRow(context.Background(), `SELECT status FROM external_presentation_sessions WHERE id=$1`, sessionID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(context.Background(), `SELECT state FROM player_commands WHERE type='prepare_airplay_session' AND payload->>'sessionId'=$1`, sessionID.String()).Scan(&prepareState); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(context.Background(), `SELECT external_presentation_session_id FROM screen_player_status WHERE screen_id=$1`, env.screenID).Scan(&assignedSession); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_commands WHERE type='stop_airplay_session' AND payload->>'sessionId'=$1`, sessionID.String()).Scan(&stopCount); err != nil {
		t.Fatal(err)
	}
	if status != "preparing" || prepareState != "pending" || assignedSession == nil || *assignedSession != sessionID || stopCount != 0 {
		t.Fatalf("failed stop left status=%q prepare=%q assigned=%v stop_commands=%d", status, prepareState, assignedSession, stopCount)
	}
}

func assertAirplayStopCommitted(t *testing.T, env activityTestEnvironment, sessionID uuid.UUID) {
	t.Helper()
	var status string
	var stopCount int
	if err := env.pool.QueryRow(context.Background(), `SELECT status FROM external_presentation_sessions WHERE id=$1`, sessionID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_commands WHERE type='stop_airplay_session' AND payload->>'sessionId'=$1`, sessionID.String()).Scan(&stopCount); err != nil {
		t.Fatal(err)
	}
	if status != "ended" || stopCount != 1 {
		t.Fatalf("successful stop left status=%q and %d stop commands", status, stopCount)
	}
}

func TestConcurrentAirplayActivationAllowsOnlyOneSession(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		airplayCreateTestSetup(t, env)
		responses := make(chan int, 2)
		var group sync.WaitGroup
		for i := 0; i < 2; i++ {
			group.Add(1)
			go func() {
				defer group.Done()
				recorder := httptest.NewRecorder()
				env.server.createAirplaySession(recorder, airplayDashboardRequest(http.MethodPost, "/api/v1/airplay/sessions", airplayCreateBody(env.screenID), env.owner))
				responses <- recorder.Code
			}()
		}
		group.Wait()
		close(responses)
		accepted, conflicts := 0, 0
		for status := range responses {
			switch status {
			case http.StatusAccepted:
				accepted++
			case http.StatusConflict:
				conflicts++
			default:
				t.Fatalf("concurrent create status = %d", status)
			}
		}
		if accepted != 1 || conflicts != 1 {
			t.Fatalf("concurrent activation results accepted=%d conflicts=%d", accepted, conflicts)
		}
	})
}
