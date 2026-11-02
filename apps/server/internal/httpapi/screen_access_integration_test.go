package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// fleetFixture is one installation with screens inside and outside a
// restricted operator's reach, and one of every container kind.
//
// The restricted operators hold the West location and the Direct group.
//
//	West   location: sWest, sWest2 (in gWest), sMixedWest (in gMixed)
//	East   location: sEast (in gEast), sMixedEast (in gMixed)
//	North  location: sGrouped (in gDirect, reachable only through the group grant)
//	gEmpty: no members, no grant
type fleetFixture struct {
	org                                   uuid.UUID
	west, east, north                     uuid.UUID
	sWest, sWest2, sEast, sGrouped        uuid.UUID
	sMixedWest, sMixedEast                uuid.UUID
	gDirect, gWest, gEast, gEmpty, gMixed uuid.UUID
	playlist                              uuid.UUID
	schIn, schGroup, schMixed, schNone    uuid.UUID
	tIn, tOut                             uuid.UUID
	oIn, oOut                             uuid.UUID
	aIn, aOut                             uuid.UUID
	dIn, dOut, dMixed                     uuid.UUID
	pairNew, pairRepair, pairReplace      devices.PairingCreated
	adminAll, adminWest, viewerWest       *rbacClient
	adminAllID, adminWestID, viewerWestID uuid.UUID
	noPolicy, operator                    *rbacClient
	noPolicyID, operatorID                uuid.UUID
}

func newFleetFixture(t *testing.T, env *rbacEnvironment) *fleetFixture {
	t.Helper()
	ctx := context.Background()
	f := &fleetFixture{}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := env.pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	if err := env.pool.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&f.org); err != nil {
		t.Fatal(err)
	}
	location := func(name string) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,$3)`, id, f.org, name)
		return id
	}
	f.west, f.east, f.north = location("West"), location("East"), location("North")
	installations := map[uuid.UUID]string{}
	screen := func(name string, location uuid.UUID) uuid.UUID {
		id := uuid.New()
		installations[id] = uuid.NewString()
		exec(`INSERT INTO screens(id,organization_id,location_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
			VALUES($1,$2,$3,$4,$5,'linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, id, f.org, location, installations[id], name)
		// A live screen has an active credential; the lists hide the rest.
		exec(`INSERT INTO device_credentials(id,screen_id,public_id,secret_hash) VALUES($1,$2,$3,$4)`, uuid.New(), id, uuid.NewString(), make([]byte, 32))
		return id
	}
	f.sWest, f.sWest2, f.sMixedWest = screen("West Lobby", f.west), screen("West Hall", f.west), screen("West Gym", f.west)
	f.sEast, f.sMixedEast = screen("East Lobby", f.east), screen("East Gym", f.east)
	f.sGrouped = screen("North Office", f.north)
	group := func(name string, members ...uuid.UUID) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO screen_groups(id,organization_id,name,description,created_by) VALUES($1,$2,$3,'',$4)`, id, f.org, name, env.ownerID)
		for _, member := range members {
			exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, id, member, env.ownerID)
		}
		return id
	}
	f.gDirect, f.gWest, f.gEast = group("Direct", f.sGrouped), group("West Group", f.sWest2), group("East Group", f.sEast)
	f.gEmpty, f.gMixed = group("Empty"), group("Mixed", f.sMixedWest, f.sMixedEast)

	f.playlist = uuid.MustParse(env.id(env.must("playlist", env.owner.post("/api/v1/playlists", map[string]any{"name": "Announcements"}), http.StatusCreated)))
	schedule := func(name string, screens []uuid.UUID, groups []uuid.UUID) uuid.UUID {
		id := uuid.New()
		start := time.Now().UTC().Add(24 * time.Hour)
		exec(`INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,one_time_start,one_time_end) VALUES($1,$2,$3,$4,'one_time','UTC',$5,$6)`, id, f.org, name, f.playlist, start, start.Add(time.Hour))
		for _, target := range screens {
			exec(`INSERT INTO schedule_targets(schedule_id,target_type,screen_id) VALUES($1,'screen',$2)`, id, target)
		}
		for _, target := range groups {
			exec(`INSERT INTO schedule_targets(schedule_id,target_type,screen_group_id) VALUES($1,'group',$2)`, id, target)
		}
		return id
	}
	f.schIn = schedule("West only", []uuid.UUID{f.sWest}, nil)
	f.schGroup = schedule("West group", nil, []uuid.UUID{f.gWest})
	f.schMixed = schedule("Both wings", []uuid.UUID{f.sWest, f.sEast}, nil)
	f.schNone = schedule("No targets", nil, nil)

	takeover := func(name string, screens ...uuid.UUID) uuid.UUID {
		id := uuid.New()
		now := time.Now().UTC()
		exec(`INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_at,expires_at,activated_by,created_at) VALUES($1,$2,$3,$4,'active',$5,$6,$7,$5)`, id, f.org, name, f.playlist, now, now.Add(time.Hour), env.ownerID)
		for _, target := range screens {
			exec(`INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state) VALUES($1,$2,1,'pending')`, id, target)
		}
		return id
	}
	f.tIn, f.tOut = takeover("West drill", f.sWest), takeover("East drill", f.sEast)

	override := func(target uuid.UUID) uuid.UUID {
		id := uuid.New()
		now := time.Now().UTC()
		exec(`INSERT INTO presentation_overrides(id,organization_id,target_type,target_id,content_type,content_id,duration_seconds,started_at,expires_at) VALUES($1,$2,'screen',$3,'playlist',$4,600,$5,$6)`, id, f.org, target, f.playlist, now, now.Add(10*time.Minute))
		return id
	}
	f.oIn, f.oOut = override(f.sWest), override(f.sEast)

	airplay := func(target uuid.UUID) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO external_presentation_sessions(id,organization_id,provider,status,target_type,target_id,gateway_screen_id,receiver_name,pin,device_id,expires_at,transport,video_port,audio_port,video_profile,audio_mode)
			VALUES($1,$2,'airplay','preparing','screen',$3,$3,'Room','4821','02:11:22:33:44:55',$4,'unicast',42000,42002,'720p30','none')`, id, f.org, target, time.Now().UTC().Add(time.Hour))
		exec(`INSERT INTO external_presentation_screen_states(session_id,screen_id,role,state) VALUES($1,$2,'single','preparing')`, id, target)
		return id
	}
	f.aIn, f.aOut = airplay(f.sWest), airplay(f.sEast)

	release := uuid.New()
	exec(`INSERT INTO player_releases(id,source,channel,version_code,version_name,application_id,minimum_sdk,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_signature,cache_status,verification_status,imported_by) VALUES($1,'upload','stable',11,'0.11.0','org.tilecast.player',23,'',now(),'tilecast-player.apk',1024,$2,$3,'{}'::jsonb,'signature','cached','verified',$4)`,
		release, strings.Repeat("d", 64), strings.Repeat("e", 64), env.ownerID)
	deployment := func(screens ...uuid.UUID) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO update_deployments(id,release_id,name,mode,created_by,status,started_at) VALUES($1,$2,'Update','install_now',$3,'active',now())`, id, release, env.ownerID)
		for _, target := range screens {
			exec(`INSERT INTO screen_update_states(deployment_id,screen_id,expected_version_code,state) VALUES($1,$2,11,'pending')`, id, target)
		}
		return id
	}
	f.dIn, f.dOut, f.dMixed = deployment(f.sWest), deployment(f.sEast), deployment(f.sWest2, f.sEast)

	identity, err := env.devices.Identity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pair := func(installation string) devices.PairingCreated {
		created, err := env.devices.CreatePairing(ctx, identity.InstallationID, devices.DeviceMetadata{
			PlayerInstallationID: installation, Platform: "linux", Manufacturer: "Test", Model: "Box",
			AndroidVersion: "none", PlayerVersion: "1.0", ScreenWidth: 1920, ScreenHeight: 1080, Density: 1,
			Locale: "en-US", Timezone: "UTC",
		})
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	f.pairNew, f.pairRepair, f.pairReplace = pair(uuid.NewString()), pair(installations[f.sWest]), pair(uuid.NewString())

	restricted := map[string]any{"mode": "restricted", "scopes": []map[string]any{{"type": "location", "id": f.west}, {"type": "group", "id": f.gDirect}}}
	create := func(username, role string, screenAccess any) (uuid.UUID, *rbacClient) {
		body := map[string]any{"name": "User " + username, "username": username, "password": env.password, "role": role}
		if screenAccess != nil {
			body["screenAccess"] = screenAccess
		}
		id := uuid.MustParse(env.id(env.must("create "+username, env.owner.post("/api/v1/users", body), http.StatusCreated)))
		return id, env.login(username)
	}
	f.adminAllID, f.adminAll = create("admin-all", "administrator", map[string]any{"mode": "all"})
	f.adminWestID, f.adminWest = create("admin-west", "administrator", restricted)
	f.viewerWestID, f.viewerWest = create("viewer-west", "viewer", restricted)
	f.noPolicyID, f.noPolicy = create("no-policy", "administrator", map[string]any{"mode": "all"})
	exec(`DELETE FROM user_screen_access WHERE user_id=$1`, f.noPolicyID)
	env.must("operator role", env.owner.post("/api/v1/roles", map[string]any{"name": "Screen Operators", "capabilities": []string{"screen.read", "screen.manage", "screen.assign"}}), http.StatusCreated)
	f.operatorID, f.operator = create("operator", "custom.screen-operators", map[string]any{"mode": "all"})
	return f
}

func idsOf(t *testing.T, response rbacResponse) []string {
	t.Helper()
	items, _ := response.data()["items"].([]any)
	out := []string{}
	for _, item := range items {
		if entry, ok := item.(map[string]any); ok {
			if id, ok := entry["id"].(string); ok {
				out = append(out, id)
			}
		}
	}
	sort.Strings(out)
	return out
}

func sortedIDs(ids ...uuid.UUID) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, id.String())
	}
	sort.Strings(out)
	return out
}

func sameIDs(left, right []string) bool {
	return strings.Join(left, ",") == strings.Join(right, ",")
}

// TestScreenAccessMatrix drives the dashboard API as each kind of actor
// against screens and containers inside and outside its reach.
func TestScreenAccessMatrix(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		ctx := context.Background()
		f := newFleetFixture(t, env)
		reachable := sortedIDs(f.sWest, f.sWest2, f.sMixedWest, f.sGrouped)
		everything := sortedIDs(f.sWest, f.sWest2, f.sMixedWest, f.sGrouped, f.sEast, f.sMixedEast)
		count := func(query string, args ...any) int {
			t.Helper()
			var n int
			if err := env.pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
				t.Fatal(err)
			}
			return n
		}

		t.Run("screen lists match direct decisions", func(t *testing.T) {
			for label, client := range map[string]*rbacClient{"owner": env.owner, "admin-all": f.adminAll, "operator": f.operator} {
				if got := idsOf(t, env.must(label+" screens", client.get("/api/v1/screens"), http.StatusOK)); !sameIDs(got, everything) {
					t.Errorf("%s sees %v, want the whole fleet", label, got)
				}
			}
			if got := idsOf(t, env.must("restricted screens", f.adminWest.get("/api/v1/screens"), http.StatusOK)); !sameIDs(got, reachable) {
				t.Errorf("restricted operator sees %v, want %v", got, reachable)
			}
			if got := idsOf(t, env.must("no policy screens", f.noPolicy.get("/api/v1/screens"), http.StatusOK)); len(got) != 0 {
				t.Errorf("account without a policy sees %v", got)
			}
			// Every listed screen reads directly, and every other one is 404.
			for _, id := range everything {
				status := f.adminWest.get("/api/v1/screens/" + id).status
				listed := strings.Contains(strings.Join(reachable, ","), id)
				if listed && status != http.StatusOK || !listed && status != http.StatusNotFound {
					t.Errorf("restricted read of %s = %d (listed=%v)", id, status, listed)
				}
			}
			env.must("no policy direct read", f.noPolicy.get("/api/v1/screens/"+f.sWest.String()), http.StatusNotFound)
			// Content Health lists unassigned screens with the same rule.
			unassigned := []string{}
			for _, item := range env.must("content health", f.adminWest.get("/api/v1/content-health"), http.StatusOK).data()["unassignedScreens"].([]any) {
				unassigned = append(unassigned, item.(map[string]any)["id"].(string))
			}
			sort.Strings(unassigned)
			for _, id := range unassigned {
				if !strings.Contains(strings.Join(reachable, ","), id) {
					t.Errorf("content health shows unreachable screen %s", id)
				}
			}
			if len(unassigned) == 0 {
				t.Error("content health hides the operator's own unassigned screens")
			}
		})

		t.Run("screen mutations", func(t *testing.T) {
			env.must("out of reach rename", f.adminWest.patch("/api/v1/screens/"+f.sEast.String(), map[string]any{"name": "Renamed", "locationId": f.east}), http.StatusNotFound)
			if count(`SELECT count(*) FROM screens WHERE id=$1 AND name='East Lobby'`, f.sEast) != 1 {
				t.Error("a refused rename changed the screen")
			}
			// Moving a screen to a location the operator does not hold, or to
			// no location, would hand it to someone else.
			env.must("move out", f.adminWest.patch("/api/v1/screens/"+f.sWest.String(), map[string]any{"name": "West Lobby", "locationId": f.east}), http.StatusNotFound)
			if response := f.adminWest.patch("/api/v1/screens/"+f.sWest.String(), map[string]any{"name": "West Lobby"}); response.status != http.StatusUnprocessableEntity || response.code() != "screen_location_required" {
				t.Errorf("clear location = %d %s", response.status, response.raw)
			}
			if count(`SELECT count(*) FROM screens WHERE id=$1 AND location_id=$2`, f.sWest, f.west) != 1 {
				t.Error("a refused move changed the location")
			}
			env.must("in place rename", f.adminWest.patch("/api/v1/screens/"+f.sWest.String(), map[string]any{"name": "West Lobby 2", "locationId": f.west}), http.StatusOK)
			// A group grant reaches the screen, but its location is not
			// the operator's to change.
			env.must("group-reached rename keeps location", f.adminWest.patch("/api/v1/screens/"+f.sGrouped.String(), map[string]any{"name": "North Office", "locationId": f.north}), http.StatusOK)
			if response := f.viewerWest.patch("/api/v1/screens/"+f.sWest.String(), map[string]any{"name": "Viewer", "locationId": f.west}); response.status != http.StatusForbidden || response.code() != "insufficient_role" {
				t.Errorf("viewer rename = %d %s", response.status, response.raw)
			}
			// Assignment rewrites every Display Group peer, so a screen with
			// an out-of-reach peer is refused.
			if response := f.adminWest.put("/api/v1/screens/"+f.sMixedWest.String()+"/playlist-assignment", map[string]any{"playlistId": f.playlist}); response.status != http.StatusForbidden || response.code() != "out_of_scope" {
				t.Errorf("assignment through a mixed group = %d %s", response.status, response.raw)
			}
			if count(`SELECT count(*) FROM screen_group_playlist_assignments WHERE screen_group_id=$1`, f.gMixed) != 0 {
				t.Error("a refused assignment reached the mixed group")
			}
		})

		t.Run("bulk selections are all or nothing", func(t *testing.T) {
			before := count(`SELECT count(*) FROM bulk_operations`)
			body := map[string]any{"action": "set_enabled", "enabled": false, "screenIds": []uuid.UUID{f.sWest, f.sEast}, "expectedChangeCount": 2}
			if response := f.adminWest.post("/api/v1/screens/bulk/apply", body); response.status != http.StatusForbidden || response.code() != "out_of_scope" {
				t.Errorf("mixed bulk apply = %d %s", response.status, response.raw)
			}
			if count(`SELECT count(*) FROM bulk_operations`) != before || count(`SELECT count(*) FROM screens WHERE id=ANY($1) AND NOT enabled`, []uuid.UUID{f.sWest, f.sEast}) != 0 {
				t.Error("a refused bulk change changed state")
			}
			if response := f.adminWest.post("/api/v1/screens/bulk/preview", map[string]any{"action": "set_enabled", "enabled": false, "screenIds": []uuid.UUID{}}); response.status != http.StatusForbidden {
				t.Errorf("empty restricted bulk preview = %d %s", response.status, response.raw)
			}
		})

		t.Run("display groups", func(t *testing.T) {
			want := sortedIDs(f.gDirect, f.gWest)
			if got := idsOf(t, env.must("restricted groups", f.adminWest.get("/api/v1/screen-groups"), http.StatusOK)); !sameIDs(got, want) {
				t.Errorf("restricted groups = %v, want %v", got, want)
			}
			for id, status := range map[uuid.UUID]int{f.gDirect: 200, f.gWest: 200, f.gEast: 404, f.gEmpty: 404, f.gMixed: 404} {
				if got := f.adminWest.get("/api/v1/screen-groups/" + id.String()).status; got != status {
					t.Errorf("group %s = %d, want %d", id, got, status)
				}
			}
			// An empty group must not be reachable by vacuous truth.
			env.must("empty group delete", f.adminWest.delete("/api/v1/screen-groups/"+f.gEmpty.String()), http.StatusNotFound)
			if count(`SELECT count(*) FROM screen_groups WHERE id=$1 AND deleted_at IS NULL`, f.gEmpty) != 1 {
				t.Error("a refused delete removed the empty group")
			}
			// Membership must not make an out-of-reach screen reachable.
			env.must("add east member", f.adminWest.post("/api/v1/screen-groups/"+f.gWest.String()+"/screens", map[string]any{"screenId": f.sEast}), http.StatusForbidden)
			env.must("remove mixed member", f.adminWest.delete("/api/v1/screen-groups/"+f.gMixed.String()+"/screens/"+f.sMixedEast.String()), http.StatusNotFound)
			if count(`SELECT count(*) FROM screen_group_memberships WHERE screen_group_id=$1`, f.gWest) != 1 || count(`SELECT count(*) FROM screen_group_memberships WHERE screen_group_id=$1`, f.gMixed) != 2 {
				t.Error("a refused membership change changed membership")
			}
			env.must("gateway out of reach", f.adminWest.patch("/api/v1/screen-groups/"+f.gWest.String(), map[string]any{"name": "West Group", "description": "", "presentationGatewayScreenId": f.sEast}), http.StatusNotFound)
			// A restricted operator creates a group only with reachable
			// first members, in one transaction.
			groups := count(`SELECT count(*) FROM screen_groups`)
			env.must("empty create", f.adminWest.post("/api/v1/screen-groups", map[string]any{"name": "Nothing", "description": ""}), http.StatusForbidden)
			env.must("out of reach create", f.adminWest.post("/api/v1/screen-groups", map[string]any{"name": "Grab", "description": "", "screenIds": []uuid.UUID{f.sEast}}), http.StatusForbidden)
			if count(`SELECT count(*) FROM screen_groups`) != groups {
				t.Error("a refused create left a group behind")
			}
			created := env.id(env.must("anchored create", f.adminWest.post("/api/v1/screen-groups", map[string]any{"name": "Front desk", "description": "", "screenIds": []uuid.UUID{f.sWest}}), http.StatusCreated))
			env.must("created group reads", f.adminWest.get("/api/v1/screen-groups/"+created), http.StatusOK)
			// Whole-fleet operators keep creating empty groups.
			env.must("whole fleet empty create", f.adminAll.post("/api/v1/screen-groups", map[string]any{"name": "Later", "description": ""}), http.StatusCreated)
		})

		t.Run("schedules", func(t *testing.T) {
			want := sortedIDs(f.schIn, f.schGroup)
			if got := idsOf(t, env.must("restricted schedules", f.adminWest.get("/api/v1/schedules"), http.StatusOK)); !sameIDs(got, want) {
				t.Errorf("restricted schedules = %v, want %v", got, want)
			}
			for id, status := range map[uuid.UUID]int{f.schIn: 200, f.schGroup: 200, f.schMixed: 404, f.schNone: 404} {
				if got := f.adminWest.get("/api/v1/schedules/" + id.String()).status; got != status {
					t.Errorf("schedule %s = %d, want %d", id, got, status)
				}
			}
			env.must("disable targetless", f.adminWest.post("/api/v1/schedules/"+f.schNone.String()+"/disable", nil), http.StatusNotFound)
			env.must("delete mixed", f.adminWest.delete("/api/v1/schedules/"+f.schMixed.String()), http.StatusNotFound)
			if count(`SELECT count(*) FROM schedules WHERE id=ANY($1) AND deleted_at IS NULL`, []uuid.UUID{f.schNone, f.schMixed}) != 2 {
				t.Error("a refused schedule change changed state")
			}
			start := time.Now().UTC().Add(48 * time.Hour)
			schedule := map[string]any{"name": "Grab", "playlistId": f.playlist, "type": "one_time", "timezone": "UTC", "oneTimeStart": start, "oneTimeEnd": start.Add(time.Hour), "enabled": true}
			before := count(`SELECT count(*) FROM schedules`)
			schedule["targets"] = []map[string]any{{"type": "screen", "id": f.sEast}}
			env.must("out of reach schedule", f.adminWest.post("/api/v1/schedules", schedule), http.StatusForbidden)
			schedule["targets"] = []map[string]any{}
			env.must("targetless schedule", f.adminWest.post("/api/v1/schedules", schedule), http.StatusForbidden)
			if count(`SELECT count(*) FROM schedules`) != before {
				t.Error("a refused schedule was stored")
			}
		})

		t.Run("takeovers, Quick Present, and AirPlay", func(t *testing.T) {
			if got := idsOf(t, env.must("restricted takeovers", f.adminWest.get("/api/v1/takeovers"), http.StatusOK)); !sameIDs(got, sortedIDs(f.tIn)) {
				t.Errorf("restricted takeovers = %v", got)
			}
			env.must("out of reach takeover", f.adminWest.get("/api/v1/takeovers/"+f.tOut.String()), http.StatusNotFound)
			env.must("cancel out of reach takeover", f.adminWest.post("/api/v1/takeovers/"+f.tOut.String()+"/cancel", map[string]any{}), http.StatusNotFound)
			if count(`SELECT count(*) FROM takeovers WHERE id=$1 AND status='active'`, f.tOut) != 1 {
				t.Error("a refused cancel ended the takeover")
			}
			if got := idsOf(t, env.must("restricted overrides", f.adminWest.get("/api/v1/presentation-overrides"), http.StatusOK)); !sameIDs(got, sortedIDs(f.oIn)) {
				t.Errorf("restricted Quick Presents = %v", got)
			}
			env.must("stop out of reach Quick Present", f.adminWest.post("/api/v1/presentation-overrides/"+f.oOut.String()+"/stop", nil), http.StatusNotFound)
			if count(`SELECT count(*) FROM presentation_overrides WHERE id=$1 AND stopped_at IS NULL`, f.oOut) != 1 {
				t.Error("a refused stop ended the Quick Present")
			}
			env.must("out of reach AirPlay", f.adminWest.get("/api/v1/airplay/sessions/"+f.aOut.String()), http.StatusNotFound)
			env.must("stop out of reach AirPlay", f.adminWest.post("/api/v1/airplay/sessions/"+f.aOut.String()+"/stop", map[string]any{}), http.StatusNotFound)
			if count(`SELECT count(*) FROM external_presentation_sessions WHERE id=$1 AND status='preparing'`, f.aOut) != 1 {
				t.Error("a refused stop ended the AirPlay session")
			}
		})

		t.Run("update deployments", func(t *testing.T) {
			env.must("out of reach deployment", f.adminWest.get("/api/v1/update-deployments/"+f.dOut.String()), http.StatusNotFound)
			mixed := env.must("mixed deployment", f.adminWest.get("/api/v1/update-deployments/"+f.dMixed.String()), http.StatusOK)
			if raw := mixed.raw; strings.Contains(raw, f.sEast.String()) || !strings.Contains(raw, f.sWest2.String()) {
				t.Errorf("mixed deployment rows are not narrowed: %s", raw)
			}
			if response := f.adminWest.post("/api/v1/update-deployments/"+f.dMixed.String()+"/cancel", nil); response.status != http.StatusForbidden || response.code() != "out_of_scope" {
				t.Errorf("mixed cancel = %d %s", response.status, response.raw)
			}
			if count(`SELECT count(*) FROM update_deployments WHERE id=$1 AND status='active'`, f.dMixed) != 1 {
				t.Error("a refused cancel cancelled the deployment")
			}
			env.must("in reach cancel", f.adminWest.post("/api/v1/update-deployments/"+f.dIn.String()+"/cancel", nil), http.StatusOK)
		})

		t.Run("organization structure needs its own capability and the whole fleet", func(t *testing.T) {
			// screen.manage alone reaches neither Locations nor Presentation
			// Networks, even for a whole-fleet custom role.
			if response := f.operator.patch("/api/v1/locations/"+f.west.String(), map[string]any{"name": "Renamed"}); response.status != http.StatusForbidden || response.code() != "insufficient_role" {
				t.Errorf("operator location rename = %d %s", response.status, response.raw)
			}
			if response := f.operator.post("/api/v1/presentation-networks", map[string]any{}); response.status != http.StatusForbidden || response.code() != "insufficient_role" {
				t.Errorf("operator network create = %d %s", response.status, response.raw)
			}
			// A restricted Administrator holds the capability but not the
			// fleet, even for a location granted to it.
			for _, request := range []rbacResponse{
				f.adminWest.patch("/api/v1/locations/"+f.west.String(), map[string]any{"name": "Renamed"}),
				f.adminWest.delete("/api/v1/locations/" + f.east.String()),
				f.adminWest.post("/api/v1/locations", map[string]any{"name": "New"}),
				f.adminWest.post("/api/v1/presentation-networks", map[string]any{}),
				f.adminWest.put("/api/v1/presentation-networks/"+uuid.NewString()+"/screens", map[string]any{"screenIds": []uuid.UUID{}}),
			} {
				if request.status != http.StatusForbidden || request.code() != "screen_access_restricted" {
					t.Errorf("restricted structure change = %d %s", request.status, request.raw)
				}
			}
			if count(`SELECT count(*) FROM locations WHERE name IN ('West','East','North')`) != 3 {
				t.Error("a refused location change changed a location")
			}
			env.must("whole fleet admin rename", f.adminAll.patch("/api/v1/locations/"+f.north.String(), map[string]any{"name": "North"}), http.StatusOK)
			// Reads are narrowed to the locations relevant to the operator.
			names := []string{}
			for _, item := range env.must("restricted locations", f.adminWest.get("/api/v1/locations"), http.StatusOK).data()["items"].([]any) {
				names = append(names, item.(map[string]any)["name"].(string))
			}
			sort.Strings(names)
			if strings.Join(names, ",") != "North,West" {
				t.Errorf("restricted locations = %v, want North,West", names)
			}
		})

		t.Run("pairing", func(t *testing.T) {
			pending := idsOf(t, env.must("restricted pending", f.adminWest.get("/api/v1/screens/pairing/pending"), http.StatusOK))
			if !sameIDs(pending, sortedIDs(f.pairRepair.ID)) {
				t.Errorf("restricted pending = %v, want only the repair session", pending)
			}
			if all := idsOf(t, env.must("owner pending", env.owner.get("/api/v1/screens/pairing/pending"), http.StatusOK)); len(all) != 3 {
				t.Errorf("owner pending = %v", all)
			}
			env.must("resolve new code", f.adminWest.post("/api/v1/screens/pairing/resolve", map[string]any{"code": f.pairNew.Code}), http.StatusOK)
			// A new screen needs a destination the operator administers.
			approve := "/api/v1/screens/pairing/" + f.pairNew.ID.String() + "/approve"
			if response := f.adminWest.post(approve, map[string]any{"name": "New Kiosk"}); response.status != http.StatusUnprocessableEntity || response.code() != "screen_location_required" {
				t.Errorf("approve without location = %d %s", response.status, response.raw)
			}
			env.must("approve into East", f.adminWest.post(approve, map[string]any{"name": "New Kiosk", "locationId": f.east}), http.StatusNotFound)
			env.must("approve into group-only North", f.adminWest.post(approve, map[string]any{"name": "New Kiosk", "locationId": f.north}), http.StatusNotFound)
			if count(`SELECT count(*) FROM device_pairing_sessions WHERE id=$1 AND status='pending'`, f.pairNew.ID) != 1 || count(`SELECT count(*) FROM screens WHERE name='New Kiosk'`) != 0 {
				t.Error("a refused approval changed state")
			}
			// Hardware replacement must not reach an out-of-reach screen by id.
			replace := "/api/v1/screens/pairing/" + f.pairReplace.ID.String() + "/approve"
			env.must("replace East", f.adminWest.post(replace, map[string]any{"replaceHardware": true, "replacementScreenId": f.sEast}), http.StatusNotFound)
			if count(`SELECT count(*) FROM device_pairing_sessions WHERE id=$1 AND status='pending'`, f.pairReplace.ID) != 1 {
				t.Error("a refused replacement changed the session")
			}
			// Rejecting new hardware has no anchor; rejecting a repair does.
			env.must("reject new hardware", f.adminWest.post("/api/v1/screens/pairing/"+f.pairReplace.ID.String()+"/reject", map[string]any{}), http.StatusNotFound)
			env.must("approve into West", f.adminWest.post(approve, map[string]any{"name": "New Kiosk", "locationId": f.west}), http.StatusOK)
			env.must("repair own screen", f.adminWest.post("/api/v1/screens/pairing/"+f.pairRepair.ID.String()+"/approve", map[string]any{"name": "ignored", "replaceExistingCredential": true}), http.StatusOK)
			env.must("whole fleet reject", f.adminAll.post("/api/v1/screens/pairing/"+f.pairReplace.ID.String()+"/reject", map[string]any{}), http.StatusNoContent)
		})

		t.Run("account creation is atomic and fails closed", func(t *testing.T) {
			// An API caller that omits screen access creates an account
			// that reaches nothing.
			id := env.id(env.must("legacy create", env.owner.post("/api/v1/users", map[string]any{"name": "Legacy", "username": "legacy", "password": env.password, "role": "administrator"}), http.StatusCreated))
			var mode string
			if err := env.pool.QueryRow(ctx, `SELECT mode FROM user_screen_access WHERE user_id=$1`, id).Scan(&mode); err != nil || mode != "restricted" {
				t.Fatalf("omitted screen access stored %q, %v", mode, err)
			}
			if got := idsOf(t, env.login("legacy").get("/api/v1/screens")); len(got) != 0 {
				t.Errorf("default account sees %v", got)
			}
			// Delegation is checked before anything is written.
			users := count(`SELECT count(*) FROM users`)
			env.must("restricted grants all", f.adminWest.post("/api/v1/users", map[string]any{"name": "Wide", "username": "wide", "password": env.password, "role": "viewer", "screenAccess": map[string]any{"mode": "all"}}), http.StatusForbidden)
			env.must("restricted grants member-only group", f.adminWest.post("/api/v1/users", map[string]any{"name": "Wide", "username": "wide", "password": env.password, "role": "viewer", "screenAccess": map[string]any{"mode": "restricted", "scopes": []map[string]any{{"type": "group", "id": f.gWest}}}}), http.StatusForbidden)
			if count(`SELECT count(*) FROM users`) != users {
				t.Error("a refused creation left an account behind")
			}
			env.must("restricted grants own location", f.adminWest.post("/api/v1/users", map[string]any{"name": "Narrow", "username": "narrow", "password": env.password, "role": "viewer", "screenAccess": map[string]any{"mode": "restricted", "scopes": []map[string]any{{"type": "location", "id": f.west}}}}), http.StatusCreated)
			// Every account has an explicit policy from the moment it exists.
			if missing := count(`SELECT count(*) FROM users u WHERE NOT EXISTS(SELECT 1 FROM user_screen_access a WHERE a.user_id=u.id) AND u.id<>$1`, f.noPolicyID); missing != 0 {
				t.Errorf("%d accounts have no screen access policy", missing)
			}
			if response := env.owner.put("/api/v1/users/"+f.viewerWestID.String()+"/screen-scopes", map[string]any{"scopes": []any{}}); response.status != http.StatusUnprocessableEntity || response.code() != "screen_access_mode_required" {
				t.Errorf("mode-less update = %d %s", response.status, response.raw)
			}
			access := env.must("me access", f.adminWest.get("/api/v1/me/access"), http.StatusOK).data()["screens"].(map[string]any)
			if access["mode"] != "restricted" || len(access["locationIds"].([]any)) != 1 || len(access["groupIds"].([]any)) != 1 {
				t.Errorf("me/access screens = %v", access)
			}
			if access := env.must("no policy me access", f.noPolicy.get("/api/v1/me/access"), http.StatusOK).data()["screens"].(map[string]any); access["mode"] != "restricted" {
				t.Errorf("missing policy reads as %v", access)
			}
		})

		t.Run("revocation applies to the next request", func(t *testing.T) {
			bearer := &rbacClient{env: env, bearer: env.must("PAT", f.adminAll.post("/api/v1/me/security/pats", map[string]any{"name": "laptop", "scopes": []string{"admin"}, "expiresInDays": 7}), http.StatusCreated).data()["token"].(string)}
			env.must("bearer before", bearer.get("/api/v1/screens/"+f.sEast.String()), http.StatusOK)
			env.must("session before", f.adminAll.get("/api/v1/screens/"+f.sEast.String()), http.StatusOK)
			env.must("restrict", env.owner.put("/api/v1/users/"+f.adminAllID.String()+"/screen-scopes", map[string]any{"mode": "restricted", "scopes": []map[string]any{{"type": "location", "id": f.west}}}), http.StatusOK)
			env.must("bearer after", bearer.get("/api/v1/screens/"+f.sEast.String()), http.StatusNotFound)
			env.must("session after", f.adminAll.get("/api/v1/screens/"+f.sEast.String()), http.StatusNotFound)
			env.must("bearer in reach", bearer.get("/api/v1/screens/"+f.sWest.String()), http.StatusOK)
			env.must("restore", env.owner.put("/api/v1/users/"+f.adminAllID.String()+"/screen-scopes", map[string]any{"mode": "all"}), http.StatusOK)
			env.must("bearer restored", bearer.get("/api/v1/screens/"+f.sEast.String()), http.StatusOK)
			// Deleting the policy row fails closed on the next request.
			if _, err := env.pool.Exec(ctx, `DELETE FROM user_screen_access WHERE user_id=$1`, f.adminAllID); err != nil {
				t.Fatal(err)
			}
			env.must("bearer without policy", bearer.get("/api/v1/screens/"+f.sWest.String()), http.StatusNotFound)
			env.must("restore again", env.owner.put("/api/v1/users/"+f.adminAllID.String()+"/screen-scopes", map[string]any{"mode": "all"}), http.StatusOK)
		})

		t.Run("package services decide like the dashboard", func(t *testing.T) {
			pluginService := plugins.NewService(env.pool, env.devices, plugins.WithScreens(env.devices), plugins.WithTakeovers(env.server.takeovers))
			dispatcher := services.NewDispatcher(services.Dependencies{
				DB: env.pool, Devices: env.devices, Playlists: env.server.playlists,
				Scheduling: env.server.scheduling, Takeovers: env.server.takeovers,
				Shared: pluginService.Shared(), Limits: services.Limits{MaxTakeoverTargets: 250},
			})
			administrator, _ := auth.BuiltinCapabilities(auth.RoleAdministrator)
			studio := func(userID uuid.UUID, grant, operation string, input any) (map[string]any, *services.CallError) {
				raw, _ := json.Marshal(input)
				data, denial, failure := dispatcher.Call(ctx, services.Call{
					PackageID: "acme.parity", Context: services.ContextStudio,
					Actor:  &services.Actor{UserID: userID, Role: auth.RoleAdministrator, Capabilities: administrator},
					Grants: []packagemanifest.ServiceGrant{{ID: grant, Version: 1}}, Operation: operation, Input: raw,
				})
				if denial != nil {
					t.Fatalf("%s denied: %+v", operation, denial)
				}
				encoded, _ := json.Marshal(data)
				out := map[string]any{}
				_ = json.Unmarshal(encoded, &out)
				return out, failure
			}
			notFound := func(label string, failure *services.CallError) {
				t.Helper()
				if failure == nil || failure.Code != services.ErrCodeNotFound {
					t.Errorf("%s = %+v, want not_found like the dashboard's 404", label, failure)
				}
			}
			_, failure := studio(f.adminWestID, "screens.read", "screens.read@1/get", map[string]any{"id": f.sEast})
			notFound("screen get", failure)
			_, failure = studio(f.adminWestID, "content.read", "content.read@1/groups.get", map[string]any{"id": f.gEmpty})
			notFound("empty group get", failure)
			_, failure = studio(f.adminWestID, "content.read", "content.read@1/schedules.get", map[string]any{"id": f.schNone})
			notFound("targetless schedule get", failure)
			_, failure = studio(f.adminWestID, "takeovers.manage", "takeovers.manage@1/cancel", map[string]any{"id": f.tOut})
			notFound("takeover cancel", failure)
			if count(`SELECT count(*) FROM takeovers WHERE id=$1 AND status='active'`, f.tOut) != 1 {
				t.Error("a refused package cancel ended the takeover")
			}
			commands := count(`SELECT count(*) FROM player_commands WHERE screen_id=$1`, f.sEast)
			_, failure = studio(f.adminWestID, "players.display-control", "players.display-control@1/display.power", map[string]any{"screenId": f.sEast, "input": map[string]any{"state": "off"}})
			notFound("display control", failure)
			if count(`SELECT count(*) FROM player_commands WHERE screen_id=$1`, f.sEast) != commands {
				t.Error("a refused display command was queued")
			}
			// Lists are the dashboard's lists.
			listed, failure := studio(f.adminWestID, "screens.read", "screens.read@1/list", map[string]any{"pageSize": 100})
			if failure != nil {
				t.Fatal(failure)
			}
			if got := idsOf(t, rbacResponse{body: map[string]any{"data": listed}}); !sameIDs(got, reachable) {
				t.Errorf("package screen list = %v, want %v", got, reachable)
			}
			groups, failure := studio(f.adminWestID, "content.read", "content.read@1/groups.list", map[string]any{"pageSize": 100})
			if failure != nil {
				t.Fatal(failure)
			}
			if got, want := idsOf(t, rbacResponse{body: map[string]any{"data": groups}}), idsOf(t, f.adminWest.get("/api/v1/screen-groups?pageSize=100")); !sameIDs(got, want) {
				t.Errorf("package group list = %v, dashboard %v", got, want)
			}
			// A missing policy fails closed for packages too.
			_, failure = studio(f.noPolicyID, "screens.read", "screens.read@1/get", map[string]any{"id": f.sWest})
			notFound("no policy screen get", failure)
			// Background work keeps the install-time grant: it is not any
			// user's screen access.
			data, _, failure := dispatcher.Call(ctx, services.Call{
				PackageID: "acme.parity", Context: services.ContextBackground,
				Grants: []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}, Operation: "screens.read@1/list", Input: []byte(`{"pageSize":100}`),
			})
			if failure != nil {
				t.Fatal(failure)
			}
			encoded, _ := json.Marshal(data)
			background := map[string]any{}
			_ = json.Unmarshal(encoded, &background)
			if got := idsOf(t, rbacResponse{body: map[string]any{"data": background}}); len(got) < len(everything) {
				t.Errorf("background list = %v, want the whole fleet", got)
			}
			// A Studio call never falls into the background path.
			if _, denial, _ := dispatcher.Call(ctx, services.Call{
				PackageID: "acme.parity", Context: services.ContextStudio,
				Grants: []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}, Operation: "screens.read@1/list",
			}); denial == nil {
				t.Error("a Studio call without an actor was served")
			}
		})
	})
}

// TestEveryObjectRuleDecides runs every declared object rule as a
// restricted operator against an object outside its reach and one inside,
// with a handler that records whether it ran. A rule added without a
// decision fails here.
func TestEveryObjectRuleDecides(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		f := newFleetFixture(t, env)
		administrator, _ := auth.BuiltinCapabilities(auth.RoleAdministrator)
		viewer, _ := auth.BuiltinCapabilities(auth.RoleViewer)
		restricted := auth.Principal{User: auth.User{ID: f.adminWestID, Role: auth.RoleAdministrator}, CredentialKind: auth.CredentialKindSession, Capabilities: administrator}
		whole := auth.Principal{User: auth.User{ID: f.adminAllID, Role: auth.RoleAdministrator}, CredentialKind: auth.CredentialKindSession, Capabilities: administrator}
		weak := auth.Principal{User: auth.User{ID: f.viewerWestID, Role: auth.RoleViewer}, CredentialKind: auth.CredentialKindSession, Capabilities: viewer}
		type objects struct{ outside, inside map[string]uuid.UUID }
		cases := map[objectKind]objects{
			objectScreen:               {map[string]uuid.UUID{"id": f.sEast, "screenId": f.sEast}, map[string]uuid.UUID{"id": f.sWest, "screenId": f.sWest}},
			objectScreenAssignment:     {map[string]uuid.UUID{"id": f.sMixedWest}, map[string]uuid.UUID{"id": f.sWest}},
			objectGroup:                {map[string]uuid.UUID{"id": f.gEmpty}, map[string]uuid.UUID{"id": f.gWest}},
			objectGroupMember:          {map[string]uuid.UUID{"id": f.gWest, "screenId": f.sEast}, map[string]uuid.UUID{"id": f.gWest, "screenId": f.sWest2}},
			objectSchedule:             {map[string]uuid.UUID{"id": f.schNone}, map[string]uuid.UUID{"id": f.schIn}},
			objectTakeover:             {map[string]uuid.UUID{"id": f.tOut}, map[string]uuid.UUID{"id": f.tIn}},
			objectPresentationOverride: {map[string]uuid.UUID{"id": f.oOut}, map[string]uuid.UUID{"id": f.oIn}},
			objectAirPlaySession:       {map[string]uuid.UUID{"id": f.aOut}, map[string]uuid.UUID{"id": f.aIn}},
			objectDeploymentRead:       {map[string]uuid.UUID{"id": f.dOut}, map[string]uuid.UUID{"id": f.dMixed}},
			objectDeployment:           {map[string]uuid.UUID{"id": f.dMixed}, map[string]uuid.UUID{"id": f.dIn}},
			objectPairingReject:        {map[string]uuid.UUID{"id": f.pairNew.ID}, map[string]uuid.UUID{"id": f.pairRepair.ID}},
			objectWholeFleet:           {map[string]uuid.UUID{"id": f.west}, map[string]uuid.UUID{"id": f.west}},
		}
		run := func(key string, principal auth.Principal, params map[string]uuid.UUID) (int, bool) {
			method, pattern, _ := strings.Cut(key, " ")
			reached := false
			handler := env.server.guard(method, pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reached = true
				w.WriteHeader(http.StatusTeapot)
			}))
			request := httptest.NewRequest(method, "/", nil)
			routeContext := chi.NewRouteContext()
			for name, value := range params {
				routeContext.URLParams.Add(name, value.String())
			}
			ctx := context.WithValue(request.Context(), chi.RouteCtxKey, routeContext)
			request = request.WithContext(auth.WithPrincipal(ctx, principal))
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			return recorder.Code, reached
		}
		for key, rule := range objectRules {
			if rule.kind == objectHandler {
				continue
			}
			objects, ok := cases[rule.kind]
			if !ok {
				t.Errorf("%s: no fixture for object kind %d", key, rule.kind)
				continue
			}
			if status, reached := run(key, restricted, objects.outside); reached || (status != http.StatusNotFound && status != http.StatusForbidden) {
				t.Errorf("%s outside reach = %d reached=%v, want a refusal", key, status, reached)
			}
			allowed := restricted
			if rule.kind == objectWholeFleet {
				allowed = whole
			}
			if status, reached := run(key, allowed, objects.inside); !reached {
				t.Errorf("%s inside reach = %d, want the handler", key, status)
			}
			if !weak.Can(rule.capability) {
				if status, reached := run(key, weak, objects.inside); reached || status != http.StatusForbidden {
					t.Errorf("%s without %s = %d reached=%v, want 403", key, rule.capability, status, reached)
				}
			}
		}
	})
}

// TestMissingScreenPolicyFailsClosed applies the screen-access migration to
// accounts created on the previous schema, then removes a policy row.
func TestMissingScreenPolicyFailsClosed(t *testing.T) {
	baseURL := databaseURLOrSkip(t)
	ctx := context.Background()
	databaseURL := scratchDatabase(t, ctx, baseURL)
	migrateTo(t, ctx, databaseURL, 130)
	pool := openPool(t, ctx, databaseURL)
	org, location := uuid.New(), uuid.New()
	mustExec(t, pool, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Upgrade',$1)`, org)
	mustExec(t, pool, `INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'West')`, location, org)
	accounts := map[string]uuid.UUID{}
	for _, name := range []string{"owner", "unscoped", "scoped", "scoped-owner"} {
		accounts[name] = uuid.New()
		role := "administrator"
		if strings.HasSuffix(name, "owner") {
			role = "owner"
		}
		mustExec(t, pool, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$2,'unused',$3,TRUE)`, accounts[name], name, role)
	}
	for _, name := range []string{"scoped", "scoped-owner"} {
		mustExec(t, pool, `INSERT INTO user_screen_scopes(user_id,scope_type,scope_id) VALUES($1,'location',$2)`, accounts[name], location)
	}
	pool.Close()
	migrateTo(t, ctx, databaseURL, 0)
	pool = openPool(t, ctx, databaseURL)
	z := authz.New(pool)
	for name, want := range map[string]string{"unscoped": "all", "scoped": "restricted"} {
		var mode string
		if err := pool.QueryRow(ctx, `SELECT mode FROM user_screen_access WHERE user_id=$1`, accounts[name]).Scan(&mode); err != nil || mode != want {
			t.Fatalf("%s migrated to %q (%v), want %q", name, mode, err, want)
		}
	}
	// The Owner reaches everything by rule, whatever its rows say.
	if access, err := z.Access(ctx, authz.Actor{UserID: accounts["scoped-owner"], Owner: true}); err != nil || !access.All {
		t.Fatalf("scoped Owner access = %+v %v", access, err)
	}
	// Deleting or never writing the row means no screens, not the fleet.
	mustExec(t, pool, `DELETE FROM user_screen_access WHERE user_id=$1`, accounts["unscoped"])
	access, err := z.Access(ctx, authz.Actor{UserID: accounts["unscoped"]})
	if err != nil || access.All || access.Configured {
		t.Fatalf("missing policy access = %+v %v", access, err)
	}
	screen := uuid.New()
	mustExec(t, pool, `INSERT INTO screens(id,organization_id,location_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,$4,'West Lobby','linux','T','T','none','1',1,1,1,'en','UTC')`, screen, org, location, uuid.NewString())
	actor := authz.Actor{UserID: accounts["unscoped"], Capabilities: auth.NewCapabilitySet(auth.CapScreenRead)}
	if err := z.Screen(ctx, actor, auth.CapScreenRead, screen); err == nil {
		t.Fatal("an account without a policy reached a screen")
	}
	// A restricted account keeps its grants; deleting its row removes them
	// all, even though the grant rows remain.
	scoped := authz.Actor{UserID: accounts["scoped"], Capabilities: auth.NewCapabilitySet(auth.CapScreenRead)}
	if err := z.Screen(ctx, scoped, auth.CapScreenRead, screen); err != nil {
		t.Fatalf("migrated restricted account lost its grant: %v", err)
	}
	mustExec(t, pool, `DELETE FROM user_screen_access WHERE user_id=$1`, accounts["scoped"])
	if err := z.Screen(ctx, scoped, auth.CapScreenRead, screen); err == nil {
		t.Fatal("grant rows without a policy still reached a screen")
	}
	// A corrupt mode is refused by the schema rather than read as all.
	if _, err := pool.Exec(ctx, `INSERT INTO user_screen_access(user_id,mode) VALUES($1,'everything')`, accounts["scoped"]); err == nil {
		t.Fatal("the schema accepted an unknown mode")
	}
}
