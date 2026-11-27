package server_test

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	countdownbar "github.com/tilecast/tilecast/plugins/countdown-bar"
)

// The schema version before Countdown Bar moved to Plugin Manifest API 3.
const legacySchema = 138

// legacyProjection is the Player projection the API v2 Countdown Bar served
// before the move, copied from its server/plugin.go: the same query and the
// same fields. It is the golden reference for the upgrade.
func legacyProjection(t *testing.T, ctx context.Context, pool *pgxpool.Pool, screenID uuid.UUID) []map[string]any {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT DISTINCT i.id,i.name,i.message,i.schedule_type,to_char(i.target_time,'HH24:MI'),i.days_of_week,
		i.one_time_at,i.timezone,i.lead_time_seconds,i.completion_text,i.show_confetti,i.display_mode,i.height_px,i.progress_fill,i.content_padding,i.text_scale,
		i.urgency_enabled,i.starting_soon_seconds,i.urgent_seconds,i.pulse_seconds,i.priority,i.font_id
		FROM countdown_bar_instances i
		WHERE i.enabled AND (
			i.target_scope='all'
			OR (i.target_scope='screens' AND EXISTS(SELECT 1 FROM countdown_bar_targets t WHERE t.instance_id=i.id AND t.target_type='screens' AND t.target_id=$1))
			OR (i.target_scope='locations' AND EXISTS(SELECT 1 FROM countdown_bar_targets t JOIN screens sc ON sc.id=$1 AND sc.location_id=t.target_id WHERE t.instance_id=i.id AND t.target_type='locations'))
			OR (i.target_scope='sync_groups' AND EXISTS(SELECT 1 FROM countdown_bar_targets t JOIN screen_group_memberships m ON m.screen_id=$1 AND m.screen_group_id=t.target_id WHERE t.instance_id=i.id AND t.target_type='sync_groups'))
		)
		ORDER BY i.priority DESC,i.id`, screenID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var name, message, scheduleType, timezone, completion, displayMode, progressFill string
		var targetTime *string
		var days []int
		var oneTimeAt *time.Time
		var lead, height, padding, scale, soon, urgent, pulse, priority int
		var confetti, urgency bool
		var font *uuid.UUID
		if err := rows.Scan(&id, &name, &message, &scheduleType, &targetTime, &days, &oneTimeAt, &timezone, &lead, &completion,
			&confetti, &displayMode, &height, &progressFill, &padding, &scale, &urgency, &soon, &urgent, &pulse, &priority, &font); err != nil {
			t.Fatal(err)
		}
		entry := map[string]any{"id": id.String(), "name": name, "message": message, "scheduleType": scheduleType, "timezone": timezone,
			"leadTimeSeconds": float64(lead), "showConfetti": confetti, "displayMode": displayMode, "heightPx": float64(height),
			"progressFill": progressFill, "contentPadding": float64(padding), "textScale": float64(scale), "urgencyEnabled": urgency,
			"startingSoonSeconds": float64(soon), "urgentSeconds": float64(urgent), "pulseSeconds": float64(pulse), "priority": float64(priority)}
		if targetTime != nil {
			entry["targetTime"] = *targetTime
		}
		if len(days) > 0 {
			entry["daysOfWeek"] = days
		}
		if oneTimeAt != nil {
			entry["oneTimeAt"] = *oneTimeAt
		}
		if completion != "" {
			entry["completionText"] = completion
		}
		if font != nil {
			entry["fontId"] = font.String()
		}
		out = append(out, canonicalEntry(entry))
	}
	return out
}

// canonicalEntry compares semantically: instants in UTC and days as a
// sorted set, the forms the new projection normalizes to.
func canonicalEntry(entry map[string]any) map[string]any {
	encoded, _ := json.Marshal(entry)
	out := map[string]any{}
	_ = json.Unmarshal(encoded, &out)
	if value, ok := out["oneTimeAt"].(string); ok {
		parsed, _ := time.Parse(time.RFC3339Nano, value)
		out["oneTimeAt"] = parsed.UTC().Format(time.RFC3339)
	}
	if days, ok := out["daysOfWeek"].([]any); ok {
		sort.Slice(days, func(i, j int) bool { return days[i].(float64) < days[j].(float64) })
	}
	return out
}

func TestUpgradeKeepsEveryBarOnTheSameScreens(t *testing.T) {
	type fixture struct {
		screens map[string]uuid.UUID
		font    uuid.UUID
		ids     map[string]uuid.UUID
	}
	var seeded fixture
	golden := map[string][]map[string]any{}
	goldenState := map[string][]map[string]any{}
	h := pluginharness.New(t, countdownbar.New(), pluginharness.UpgradeFrom(legacySchema, func(ctx context.Context, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
		exec := func(query string, args ...any) {
			t.Helper()
			if _, err := pool.Exec(ctx, query, args...); err != nil {
				t.Fatalf("%s: %v", strings.Fields(query)[0:3], err)
			}
		}
		org, owner, location, group := uuid.New(), uuid.New(), uuid.New(), uuid.New()
		exec(`TRUNCATE organization_settings,users,plugin_installations CASCADE`)
		exec(`INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Upgraded',$1)`, org)
		exec(`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','upgrade-owner','unused','owner',TRUE)`, owner)
		exec(`INSERT INTO user_content_access(user_id,library_mode,tag_mode) VALUES($1,'all','all')`, owner)
		exec(`INSERT INTO user_screen_access(user_id,mode) VALUES($1,'all')`, owner)
		exec(`INSERT INTO plugin_installations(organization_id,plugin_id,installed_by) VALUES($1,'countdown_bar',$2)`, org, owner)
		exec(`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Cafeteria')`, location, org)
		seeded.screens = map[string]uuid.UUID{}
		for _, name := range []string{"cafeteria", "lobby", "gym"} {
			id := uuid.New()
			var at *uuid.UUID
			if name == "cafeteria" {
				at = &location
			}
			exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,location_id,platform,device_manufacturer,device_model,
				android_version,player_version,screen_width,screen_height,density,locale,timezone)
				VALUES($1,$2,$3,$4,$5,'linux','Test','Display','Test','1',1920,1080,1,'en-US','UTC')`, id, org, uuid.NewString(), name, at)
			exec(`INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, id)
			seeded.screens[name] = id
		}
		exec(`INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Gym group',$3)`, group, org, owner)
		exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, group, seeded.screens["gym"], owner)
		seeded.font = uuid.New()
		exec(`INSERT INTO font_families(id,organization_id,family,source,created_by) VALUES($1,$2,'Lobster','upload',$3)`, seeded.font, org, owner)
		seeded.ids = map[string]uuid.UUID{}
		insert := func(key, scope, schedule string, enabled bool, priority int, extra string, targets ...uuid.UUID) {
			id := uuid.New()
			seeded.ids[key] = id
			weekly := schedule == "weekly"
			var targetTime, oneTime any
			days := []int{}
			if weekly {
				targetTime, days = "12:30", []int{5, 1, 3}
			} else {
				oneTime = time.Date(2027, 1, 15, 14, 45, 0, 0, time.FixedZone("CST", -6*3600))
			}
			exec(`INSERT INTO countdown_bar_instances(id,organization_id,name,message,schedule_type,target_time,days_of_week,one_time_at,timezone,
				lead_time_seconds,completion_text,display_mode,height_px,enabled,priority,target_scope,created_by)
				VALUES($1,$2,$3,'Ends in',$4,$5::time,$6,$7,'America/Chicago',900,'',$8,72,$9,$10,$11,$12)`,
				id, org, key, schedule, targetTime, days, oneTime, "overlay", enabled, priority, scope, owner)
			if extra != "" {
				exec(`UPDATE countdown_bar_instances SET `+extra+` WHERE id=$1`, id)
			}
			for _, target := range targets {
				exec(`INSERT INTO countdown_bar_targets(instance_id,target_type,target_id) VALUES($1,$2,$3)`, id, scope, target)
			}
		}
		insert("weekly-everywhere", "all", "weekly", true, 0, "")
		insert("one-time-location", "locations", "one_time", true, 50,
			`completion_text='Done',show_confetti=TRUE,display_mode='push',progress_fill='drain',content_padding=0,text_scale=180,
			 urgency_enabled=TRUE,starting_soon_seconds=600,urgent_seconds=120,pulse_seconds=20`, location)
		insert("weekly-screen-font", "screens", "weekly", true, -20, `font_id='`+seeded.font.String()+`'`, seeded.screens["lobby"])
		insert("weekly-group", "sync_groups", "weekly", true, 5, "", group)
		insert("disabled", "all", "weekly", false, 900, "")
		exec(`INSERT INTO font_references(plugin_id,owner_id,font_id,label) VALUES('countdown_bar',$1,$2,'weekly-screen-font')`, seeded.ids["weekly-screen-font"], seeded.font)
		for name, screen := range seeded.screens {
			golden[name] = legacyProjection(t, ctx, pool, screen)
			goldenState[name] = legacyProjection(t, ctx, pool, screen)
			for _, entry := range golden[name] {
				delete(entry, "fontId") // Plugin API 1 entries never carried the font.
			}
		}
		return org, owner
	}))

	for name, screen := range seeded.screens {
		var gotLegacy []map[string]any
		for _, entry := range h.Manifest(screen) {
			config, _ := json.Marshal(entry.Config)
			var decoded map[string]any
			_ = json.Unmarshal(config, &decoded)
			decoded["id"] = entry.ID.String()
			gotLegacy = append(gotLegacy, canonicalEntry(decoded))
		}
		if !reflect.DeepEqual(gotLegacy, golden[name]) {
			t.Errorf("%s: Plugin API 1 entries changed\n got: %v\nwant: %v", name, gotLegacy, golden[name])
		}
		var gotState []map[string]any
		for _, state := range h.PlayerState(screen) {
			var decoded map[string]any
			_ = json.Unmarshal(state.State, &decoded)
			decoded["id"] = state.ID.String()
			gotState = append(gotState, canonicalEntry(decoded))
		}
		if !reflect.DeepEqual(gotState, goldenState[name]) {
			t.Errorf("%s: Plugin API 2 state changed\n got: %v\nwant: %v", name, gotState, goldenState[name])
		}
	}
	if len(golden["cafeteria"]) != 2 || len(golden["lobby"]) != 2 || len(golden["gym"]) != 2 {
		t.Fatalf("the fixture does not cover each target form: %v", golden)
	}
	// The font reference and the disabled bar survive, and removal is still
	// blocked by every bar.
	if users := h.FontUsers(seeded.font); len(users) != 1 {
		t.Fatalf("font references after upgrade: %v", users)
	}
	var disabled bool
	if err := h.Pool.QueryRow(h.Ctx, `SELECT NOT enabled FROM plugin_instances WHERE id=$1`, seeded.ids["disabled"]).Scan(&disabled); err != nil || !disabled {
		t.Fatalf("the disabled bar: %v %v", disabled, err)
	}
	if err := h.Remove(); err == nil {
		t.Fatal("removal allowed with upgraded bars")
	}
	if status := h.Status(); status.InstanceCount != 5 {
		t.Fatalf("status after upgrade = %+v", status)
	}
}
