package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// activity.read@1 against the Studio Activity routes on the same seeded
// rows. Both read internal/activityreport; these tests make sure a later
// change cannot make Studio report one number while a plugin receives
// another, and that the plugin view stays the safe one.

type activityEvidence struct {
	group, takeover        uuid.UUID
	playlist, content      string
	schedule               string
	tiedA, tiedB, failedID uuid.UUID
	old                    uuid.UUID
}

func seedActivityEvidence(t *testing.T, env activityTestEnvironment) activityEvidence {
	t.Helper()
	ctx := context.Background()
	evidence := activityEvidence{group: uuid.New(), takeover: uuid.New(), playlist: uuid.NewString(), content: uuid.NewString(), schedule: uuid.NewString()}
	var org uuid.UUID
	if err := env.pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name) VALUES($1,$2,'Hallways')`, evidence.group, org); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	insert := func(start time.Time, duration time.Duration, result, sessionType, reason string, mutate func(map[string]any)) uuid.UUID {
		t.Helper()
		id := uuid.New()
		row := map[string]any{"presentation_type": nil, "presentation_id": nil, "presentation_name": nil, "content_type": nil, "content_id": nil, "content_name": nil, "schedule_id": nil, "takeover_id": nil, "group_id": nil, "failure_code": nil}
		if mutate != nil {
			mutate(row)
		}
		if _, err := env.pool.Exec(ctx, `
			INSERT INTO playback_sessions(id,screen_id,activity_session_id,started_at,ended_at,actual_duration_ms,result,session_type,terminal_reason,
				presentation_type,presentation_id,presentation_name,content_type,content_id,content_name,schedule_id,takeover_id,group_id,failure_code,metadata)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
				'{"ipAddress":"10.1.2.3","requestId":"req-secret","accessToken":"tok-secret","diagnostics":{"trace":"raw-trace"},"failurePayload":"raw-failure"}')`,
			id, env.screenID, id.String(), start, start.Add(duration), duration.Milliseconds(), result, sessionType, reason,
			row["presentation_type"], row["presentation_id"], row["presentation_name"], row["content_type"], row["content_id"], row["content_name"],
			row["schedule_id"], row["takeover_id"], row["group_id"], row["failure_code"]); err != nil {
			t.Fatal(err)
		}
		return id
	}
	presentation := func(row map[string]any) {
		row["presentation_type"], row["presentation_id"], row["presentation_name"] = "playlist", evidence.playlist, "Morning loop"
		row["schedule_id"], row["group_id"] = evidence.schedule, evidence.group
	}
	insert(now.Add(-3*time.Hour), time.Hour, "completed", "presentation", "schedule_transition", presentation)
	insert(now.Add(-150*time.Minute), 10*time.Minute, "completed", "content", "completed_duration", func(row map[string]any) {
		presentation(row)
		row["content_type"], row["content_id"], row["content_name"] = "image", evidence.content, "Lunch menu"
	})
	evidence.failedID = insert(now.Add(-2*time.Hour), time.Minute, "failed", "presentation", "renderer_failure", func(row map[string]any) {
		row["failure_code"] = "renderer_failure"
		row["takeover_id"] = evidence.takeover.String()
	})
	tied := now.Add(-90 * time.Minute)
	evidence.tiedA = insert(tied, time.Minute, "partial", "presentation", "heartbeat_gap", nil)
	evidence.tiedB = insert(tied, time.Minute, "partial", "presentation", "unknown", nil)
	evidence.old = insert(now.Add(-30*time.Hour), time.Hour, "completed", "presentation", "schedule_transition", nil)
	if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, env.screenID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,playback_state,active_manifest_version,foreground_state) VALUES($1,'playing',3,'foreground') ON CONFLICT (screen_id) DO UPDATE SET playback_state='playing',active_manifest_version=3,foreground_state='foreground'`, env.screenID); err != nil {
		t.Fatal(err)
	}
	// Expected windows for compliance: one confirmed, one missed, one
	// overridden by a takeover.
	windowStart := now.Add(-6 * time.Hour)
	insertWindow(t, env, windowStart, windowStart.Add(30*time.Minute), func(row *expectedWindowRow) { row.ScheduleID = evidence.schedule })
	insertRootSession(t, env, windowStart, windowStart.Add(30*time.Minute), "completed")
	insertWindow(t, env, windowStart.Add(time.Hour), windowStart.Add(90*time.Minute), func(row *expectedWindowRow) { row.ScheduleID = evidence.schedule })
	insertWindow(t, env, windowStart.Add(2*time.Hour), windowStart.Add(150*time.Minute), func(row *expectedWindowRow) {
		takeover := createTakeoverFixture(t, env)
		row.TakeoverID = &takeover
	})
	// An open presentation is what the screen is playing now. It is inserted
	// last: inserting a root session closes every open one on the screen.
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO playback_sessions(id,screen_id,activity_session_id,started_at,result,session_type,presentation_type,presentation_id,presentation_name)
		VALUES($1,$2,'open-root',$3,'playing','presentation','playlist',$4,'Morning loop')`, uuid.New(), env.screenID, now.Add(-10*time.Minute), evidence.playlist); err != nil {
		t.Fatal(err)
	}
	return evidence
}

func activityDispatcher(env activityTestEnvironment) *services.Dispatcher {
	return services.NewDispatcher(services.Dependencies{DB: env.pool})
}

func activityActor(t *testing.T, session auth.Session) *services.Actor {
	t.Helper()
	capabilities, ok := auth.BuiltinCapabilities(session.User.Role)
	if !ok {
		t.Fatalf("role %s has no capabilities", session.User.Role)
	}
	return &services.Actor{UserID: session.User.ID, Role: session.User.Role, Capabilities: capabilities}
}

type activityAnswer struct {
	data    map[string]any
	raw     string
	denial  *services.Denial
	failure *services.CallError
}

func callActivity(t *testing.T, d *services.Dispatcher, invocation string, actor *services.Actor, operation string, input any) activityAnswer {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	data, denial, failure := d.Call(context.Background(), services.Call{
		PackageID: "acme.analysis", Context: invocation, Actor: actor,
		Grants:    []packagemanifest.ServiceGrant{{ID: "activity.read", Version: 1}},
		Operation: operation, Input: raw,
	})
	answer := activityAnswer{denial: denial, failure: failure}
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		answer.raw = string(encoded)
		if err := json.Unmarshal(encoded, &answer.data); err != nil {
			t.Fatal(err)
		}
	}
	return answer
}

func (a activityAnswer) must(t *testing.T) map[string]any {
	t.Helper()
	if a.denial != nil || a.failure != nil {
		t.Fatalf("denial=%+v failure=%+v", a.denial, a.failure)
	}
	return a.data
}

func answerIDs(t *testing.T, data map[string]any, key string) []string {
	t.Helper()
	items, _ := data["items"].([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, fmt.Sprint(item.(map[string]any)[key]))
	}
	return out
}

func httpProof(t *testing.T, env activityTestEnvironment, query url.Values) []string {
	t.Helper()
	request := requestWithTestPrincipal(httptest.NewRequest(http.MethodGet, "/api/v1/activity/proof-of-play?"+query.Encode(), nil), env.owner)
	response := httptest.NewRecorder()
	env.server.listProofOfPlay(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("proof status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data proofOfPlayPage `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, item := range envelope.Data.Items {
		ids = append(ids, item.ID.String())
	}
	return ids
}

func TestActivityReadProofMatchesTheStudioRoute(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		evidence := seedActivityEvidence(t, env)
		d := activityDispatcher(env)
		for _, filter := range []map[string]string{
			{},
			{"screen": env.screenID.String()},
			{"group": evidence.group.String()},
			{"result": "failed"},
			{"sessionType": "content"},
			{"terminalReason": "unexpected"},
			{"terminalReason": "renderer_failure"},
			{"content": evidence.content},
			{"schedule": evidence.schedule},
			{"takeover": evidence.takeover.String()},
			{"search": "Lunch"},
			{"from": time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339), "to": time.Now().UTC().Format(time.RFC3339)},
		} {
			query, input := url.Values{}, map[string]any{}
			for key, value := range filter {
				query.Set(key, value)
				input[key] = value
			}
			want := httpProof(t, env, query)
			got := answerIDs(t, callActivity(t, d, services.ContextBackground, nil, "activity.read@1/proof.list", input).must(t), "id")
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Errorf("filter %v: service %v, studio %v", filter, got, want)
			}
			if len(want) == 0 {
				t.Errorf("filter %v selects nothing; the parity check is empty", filter)
			}
		}
		// Presentation selects a presentation of any type; the Studio route
		// names the type.
		want := httpProof(t, env, url.Values{"playlist": {evidence.playlist}})
		got := answerIDs(t, callActivity(t, d, services.ContextBackground, nil, "activity.read@1/proof.list", map[string]any{"presentation": evidence.playlist}).must(t), "id")
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("presentation: service %v, studio %v", got, want)
		}
	})
}

func TestActivityReadProofIsTheSafeView(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		seedActivityEvidence(t, env)
		d := activityDispatcher(env)
		// Even an Owner, who holds activity.manage, receives the safe view.
		for _, answer := range []activityAnswer{
			callActivity(t, d, services.ContextStudio, activityActor(t, env.owner), "activity.read@1/proof.list", map[string]any{}),
			callActivity(t, d, services.ContextSystem, nil, "activity.read@1/proof.list", map[string]any{}),
			callActivity(t, d, services.ContextBackground, nil, "activity.read@1/screens.current", map[string]any{}),
		} {
			answer.must(t)
			for _, leaked := range []string{"10.1.2.3", "req-secret", "tok-secret", "raw-trace", "raw-failure", `"details"`, `"metadata"`, "ipAddress", "requestId"} {
				if strings.Contains(answer.raw, leaked) {
					t.Errorf("activity answer leaked %q: %s", leaked, answer.raw)
				}
			}
		}
	})
}

func TestActivityReadProofWindowAndPagination(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		evidence := seedActivityEvidence(t, env)
		d := activityDispatcher(env)
		list := func(input map[string]any) activityAnswer {
			return callActivity(t, d, services.ContextBackground, nil, "activity.read@1/proof.list", input)
		}
		// The default range is the last 24 hours; the old session is outside.
		defaults := list(map[string]any{}).must(t)
		if strings.Contains(strings.Join(answerIDs(t, defaults, "id"), ","), evidence.old.String()) {
			t.Fatal("the default range reached a 30-hour-old session")
		}
		explicit := list(map[string]any{"from": time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339)}).must(t)
		if !strings.Contains(strings.Join(answerIDs(t, explicit, "id"), ","), evidence.old.String()) {
			t.Fatal("an explicit range missed the old session")
		}
		now := time.Now().UTC()
		for name, input := range map[string]map[string]any{
			"over five years": {"from": now.Add(-6 * 365 * 24 * time.Hour).Format(time.RFC3339), "to": now.Format(time.RFC3339)},
			"reversed range":  {"from": now.Format(time.RFC3339), "to": now.Add(-time.Hour).Format(time.RFC3339)},
			"bad timestamp":   {"from": "yesterday"},
			"bad result":      {"result": "exploded"},
			"bad sessionType": {"sessionType": "window"},
			"bad reason":      {"terminalReason": "gremlins"},
			"bad screen":      {"screen": "not-a-uuid"},
			"long search":     {"search": strings.Repeat("s", 201)},
			"long content":    {"content": strings.Repeat("c", 129)},
			"over maximum":    {"limit": 251},
			"unknown member":  {"metadata": true},
		} {
			if answer := list(input); answer.failure == nil || answer.failure.Code != services.ErrCodeInvalidInput {
				t.Errorf("%s = %+v, want invalid_input", name, answer.failure)
			}
		}
		if answer := list(map[string]any{"from": now.Add(-5 * 365 * 24 * time.Hour).Format(time.RFC3339), "to": now.Format(time.RFC3339)}); answer.failure != nil {
			t.Fatalf("five years exactly = %+v", answer.failure)
		}
		if items := answerIDs(t, list(map[string]any{"limit": 250}).must(t), "id"); len(items) != len(answerIDs(t, defaults, "id")) {
			t.Fatalf("maximum limit = %v", items)
		}
		// Walk one row at a time: newest first, the id breaks the tie, and no
		// row appears twice.
		walked := []string{}
		cursor := ""
		for range 20 {
			page := list(map[string]any{"limit": 1, "cursor": cursor}).must(t)
			walked = append(walked, answerIDs(t, page, "id")...)
			next, _ := page["nextCursor"].(string)
			if next == "" {
				break
			}
			cursor = next
		}
		if strings.Join(walked, ",") != strings.Join(answerIDs(t, defaults, "id"), ",") {
			t.Fatalf("walk %v != page %v", walked, answerIDs(t, defaults, "id"))
		}
		tiedFirst, tiedSecond := evidence.tiedA.String(), evidence.tiedB.String()
		if tiedFirst < tiedSecond {
			tiedFirst, tiedSecond = tiedSecond, tiedFirst
		}
		joined := strings.Join(walked, ",")
		if strings.Index(joined, tiedFirst) > strings.Index(joined, tiedSecond) {
			t.Fatalf("tied sessions are not ordered by id descending: %v", walked)
		}
		first := list(map[string]any{"limit": 1}).must(t)
		token := first["nextCursor"].(string)
		if answer := list(map[string]any{"limit": 1, "cursor": token, "result": "failed"}); answer.failure == nil || answer.failure.Code != services.ErrCodeInvalidInput {
			t.Fatalf("a cursor continued under another filter: %+v", answer.failure)
		}
	})
}

func httpSummary(t *testing.T, env activityTestEnvironment, query url.Values) []proofSummaryItem {
	t.Helper()
	request := requestWithTestPrincipal(httptest.NewRequest(http.MethodGet, "/api/v1/activity/proof-of-play/summary?"+query.Encode(), nil), env.owner)
	response := httptest.NewRecorder()
	env.server.proofOfPlaySummary(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("summary status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data struct {
			Items []proofSummaryItem `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data.Items
}

func TestActivityReadSummaryMatchesTheStudioRoute(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		seedActivityEvidence(t, env)
		d := activityDispatcher(env)
		// A fixed window: an open session is clipped at the range end, so two
		// reads of "now" would differ by the milliseconds between them.
		to := time.Now().UTC().Truncate(time.Second)
		from := to.Add(-48 * time.Hour)
		for _, dimension := range []string{"screen", "content", "presentation", "schedule"} {
			want := httpSummary(t, env, url.Values{"dimension": {dimension}, "from": {from.Format(time.RFC3339)}, "to": {to.Format(time.RFC3339)}})
			window := map[string]any{"dimension": dimension, "from": from.Format(time.RFC3339), "to": to.Format(time.RFC3339)}
			answer := callActivity(t, d, services.ContextBackground, nil, "activity.read@1/proof.summary", window).must(t)
			encoded, _ := json.Marshal(answer["items"])
			var got []proofSummaryItem
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if len(want) == 0 || fmt.Sprintf("%+v", got) != fmt.Sprintf("%+v", want) {
				t.Errorf("%s summary:\n service %+v\n studio  %+v", dimension, got, want)
			}
			// One group at a time reaches the same groups.
			walked := []proofSummaryItem{}
			cursor := ""
			for range 20 {
				page := callActivity(t, d, services.ContextBackground, nil, "activity.read@1/proof.summary", map[string]any{"dimension": dimension, "from": window["from"], "to": window["to"], "limit": 1, "cursor": cursor}).must(t)
				encoded, _ := json.Marshal(page["items"])
				var items []proofSummaryItem
				_ = json.Unmarshal(encoded, &items)
				walked = append(walked, items...)
				next, _ := page["nextCursor"].(string)
				if next == "" {
					break
				}
				cursor = next
			}
			if fmt.Sprintf("%+v", walked) != fmt.Sprintf("%+v", want) {
				t.Errorf("%s walk %+v != %+v", dimension, walked, want)
			}
		}
		if answer := callActivity(t, d, services.ContextBackground, nil, "activity.read@1/proof.summary", map[string]any{"dimension": "weather"}); answer.failure == nil || answer.failure.Code != services.ErrCodeInvalidInput {
			t.Fatalf("unknown dimension = %+v", answer.failure)
		}
	})
}

func TestActivityReadComplianceMatchesTheStudioRoute(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		evidence := seedActivityEvidence(t, env)
		d := activityDispatcher(env)
		for _, query := range []map[string]string{{}, {"dimension": "schedule"}, {"dimension": "reason"}, {"schedule": evidence.schedule}, {"screen": env.screenID.String(), "dimension": "date"}} {
			values, input := url.Values{}, map[string]any{}
			for key, value := range query {
				values.Set(key, value)
				input[key] = value
			}
			want := readCompliance(t, env, "?"+values.Encode())
			answer := callActivity(t, d, services.ContextBackground, nil, "activity.read@1/compliance.summary", input).must(t)
			var totals struct {
				MeasurableExpectedMS int64    `json:"measurableExpectedMs"`
				ConfirmedMS          int64    `json:"confirmedMs"`
				MissedMS             int64    `json:"missedMs"`
				CompliancePercent    *float64 `json:"compliancePercent"`
				TakeoverOverriddenMS int64    `json:"takeoverOverriddenMs"`
				Windows              int64    `json:"windows"`
				NeverStarted         int64    `json:"neverStarted"`
			}
			encoded, _ := json.Marshal(answer["totals"])
			_ = json.Unmarshal(encoded, &totals)
			if totals.MeasurableExpectedMS != want.MeasurableExpectedMS || totals.ConfirmedMS != want.ConfirmedMS || totals.MissedMS != want.MissedMS ||
				totals.TakeoverOverriddenMS != want.TakeoverOverriddenMS || totals.Windows != want.Windows || totals.NeverStarted != want.NeverStarted ||
				fmt.Sprint(totals.CompliancePercent == nil) != fmt.Sprint(want.CompliancePercent == nil) ||
				(totals.CompliancePercent != nil && *totals.CompliancePercent != *want.CompliancePercent) {
				t.Errorf("%v totals: service %+v, studio %+v", query, totals, want)
			}
			if want.Windows == 0 {
				t.Errorf("%v selects no windows; the parity check is empty", query)
			}
			encoded, _ = json.Marshal(answer["items"])
			var groups []complianceBreakdown
			_ = json.Unmarshal(encoded, &groups)
			gotJSON, _ := json.Marshal(groups)
			wantJSON, _ := json.Marshal(want.Breakdown)
			if string(gotJSON) != string(wantJSON) {
				t.Errorf("%v breakdown:\n service %+v\n studio  %+v", query, groups, want.Breakdown)
			}
		}
	})
}

func TestActivityReadScreensCurrentMatchesTheFleet(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		seedActivityEvidence(t, env)
		_, outOfScope, scoped := scopedActivityFixture(t, env)
		d := activityDispatcher(env)
		fleet, err := env.server.fleetHealth(context.Background(), time.Now().UTC(), authz.ScreenAccess{All: true})
		if err != nil {
			t.Fatal(err)
		}
		answer := callActivity(t, d, services.ContextBackground, nil, "activity.read@1/screens.current", map[string]any{}).must(t)
		items, _ := answer["items"].([]any)
		counts := map[string]int64{}
		var online int64
		var current map[string]any
		for _, item := range items {
			screen := item.(map[string]any)
			counts[screen["health"].(string)]++
			if screen["online"] == true {
				online++
			}
			if screen["screenId"] == env.screenID.String() {
				current = screen
			}
		}
		if int64(len(items)) != fleet.Measured || counts["healthy"] != fleet.Healthy || counts["impaired"] != fleet.Impaired ||
			counts["offline"] != fleet.Offline || counts["unmeasured"] != fleet.Unmeasured || online != fleet.Online {
			t.Fatalf("screens.current counts %v online %d, fleet %+v", counts, online, fleet)
		}
		if current == nil || current["health"] != "healthy" || current["healthReason"] != "playing" {
			t.Fatalf("current screen = %+v", current)
		}
		presentation, _ := current["currentPresentation"].(map[string]any)
		if presentation == nil || presentation["name"] != "Morning loop" || presentation["type"] != "playlist" {
			t.Fatalf("current presentation = %+v", current["currentPresentation"])
		}
		// Studio narrows the current view to the operator's screens; an
		// unattended call reads every screen.
		narrowed := callActivity(t, d, services.ContextStudio, activityActor(t, scoped), "activity.read@1/screens.current", map[string]any{}).must(t)
		if ids := answerIDs(t, narrowed, "screenId"); len(ids) != 1 || ids[0] != env.screenID.String() {
			t.Fatalf("scoped screens.current = %v", ids)
		}
		if ids := answerIDs(t, answer, "screenId"); !strings.Contains(strings.Join(ids, ","), outOfScope.String()) {
			t.Fatalf("unattended screens.current = %v", ids)
		}
		// Historical proof stays installation-wide for the same operator, as
		// the Studio route is.
		history := callActivity(t, d, services.ContextStudio, activityActor(t, scoped), "activity.read@1/proof.list", map[string]any{})
		history.must(t)
		if !strings.Contains(history.raw, outOfScope.String()) {
			t.Fatal("scoped proof history was narrowed")
		}
		// One screen at a time reaches the same screens.
		walked := 0
		cursor := ""
		for range 10 {
			page := callActivity(t, d, services.ContextSystem, nil, "activity.read@1/screens.current", map[string]any{"limit": 1, "cursor": cursor}).must(t)
			walked += len(answerIDs(t, page, "screenId"))
			next, _ := page["nextCursor"].(string)
			if next == "" {
				break
			}
			cursor = next
		}
		if int64(walked) != fleet.Measured {
			t.Fatalf("walked %d screens of %d", walked, fleet.Measured)
		}
	})
}

func TestActivityReadStudioNeedsActivityRead(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		d := activityDispatcher(env)
		none := &services.Actor{UserID: env.owner.User.ID, Role: "custom.none", Capabilities: auth.NewCapabilitySet()}
		reader := &services.Actor{UserID: env.owner.User.ID, Role: "custom.reader", Capabilities: auth.NewCapabilitySet(auth.CapActivityRead)}
		for _, operation := range []string{"activity.read@1/proof.list", "activity.read@1/proof.summary", "activity.read@1/compliance.summary", "activity.read@1/screens.current"} {
			if answer := callActivity(t, d, services.ContextStudio, none, operation, map[string]any{}); answer.failure == nil || answer.failure.Code != services.ErrCodeForbidden {
				t.Errorf("%s without activity.read = %+v", operation, answer.failure)
			}
			if answer := callActivity(t, d, services.ContextStudio, reader, operation, map[string]any{}); answer.failure != nil || answer.denial != nil {
				t.Errorf("%s with activity.read = %+v %+v", operation, answer.denial, answer.failure)
			}
			for _, invocation := range []string{services.ContextBackground, services.ContextSystem} {
				if answer := callActivity(t, d, invocation, nil, operation, map[string]any{}); answer.failure != nil || answer.denial != nil {
					t.Errorf("%s %s = %+v %+v", operation, invocation, answer.denial, answer.failure)
				}
			}
		}
	})
}
