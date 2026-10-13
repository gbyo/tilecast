package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// rbacEnvironment is a real router over a real database: sessions, bearer
// grants, the media service with local storage, and the playlist service
// wired as the media invalidator, the way the production process wires them.
type rbacEnvironment struct {
	t        *testing.T
	pool     *pgxpool.Pool
	server   *server
	router   *httptest.Server
	auth     *auth.Service
	media    *media.Service
	ownerID  uuid.UUID
	owner    *rbacClient
	password string
}

type rbacClient struct {
	env    *rbacEnvironment
	token  string
	csrf   string
	bearer string
}

type rbacResponse struct {
	status int
	body   map[string]any
	raw    string
}

func (r rbacResponse) data() map[string]any {
	value, _ := r.body["data"].(map[string]any)
	return value
}

func (r rbacResponse) code() string {
	envelope, _ := r.body["error"].(map[string]any)
	value, _ := envelope["code"].(string)
	return value
}

func withRBACEnvironment(t *testing.T, run func(*rbacEnvironment)) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings, users, content_folders, content_tags, content_collections, assets, upload_sessions, playlists CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM roles WHERE NOT builtin`); err != nil {
		t.Fatal(err)
	}
	storage, err := media.NewLocalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	authService := auth.NewService(pool, time.Hour)
	mediaService := media.NewService(pool, storage, media.Config{MaxUploadBytes: 50 << 20})
	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "")
	playlistService := playlists.NewService(pool, deviceService)
	mediaService.SetAssetInvalidator(playlistService)
	s := &server{
		db: pool, auth: authService, oauth: oauth.NewService(pool), media: mediaService,
		playlists: playlistService, devices: deviceService,
		settings:  settings.NewService(pool, nil, settings.HardLimits{}),
		campaigns: campaigns.NewService(pool, nil),
		plugins:   plugins.NewService(pool, nil),
		logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		cookieName:        "tilecast_session",
		authLimiter:       newRateLimiter(1000, time.Minute),
		pairingLimiter:    newRateLimiter(1000, time.Minute),
		codeLimiter:       newRateLimiter(1000, time.Minute),
		operationsLimiter: newRateLimiter(1000, time.Minute),
		installLimiter:    newRateLimiter(1000, time.Minute),
	}
	s.approvals = approvals.NewService(pool, s.settings)
	s.approvals.SetProvider(approvals.TypePlaylist, playlistService)
	mediaService.SetUploadAuthorizer(s.authorizeUploadDestination)
	router := httptest.NewServer(s.routes())
	defer router.Close()

	password := "correct horse battery staple"
	session, err := authService.Setup(ctx, auth.SetupInput{OrganizationName: "Lincoln Elementary", OwnerName: "Principal Ortiz", Username: "owner", Password: password})
	if err != nil {
		t.Fatal(err)
	}
	env := &rbacEnvironment{t: t, pool: pool, server: s, router: router, auth: authService, media: mediaService, ownerID: session.User.ID, password: password}
	env.owner = &rbacClient{env: env, token: session.Token, csrf: session.CSRFToken}
	run(env)
}

// login signs a user in with a password, the way Studio does.
func (env *rbacEnvironment) login(username string) *rbacClient {
	env.t.Helper()
	result, err := env.auth.Login(context.Background(), auth.LoginInput{Username: username, Password: env.password}, auth.MFAPolicyNone)
	if err != nil || result.Session == nil {
		env.t.Fatalf("login %s: %v", username, err)
	}
	return &rbacClient{env: env, token: result.Session.Token, csrf: result.Session.CSRFToken}
}

func (c *rbacClient) do(method, path string, body any, headers map[string]string) rbacResponse {
	c.env.t.Helper()
	var reader io.Reader
	switch value := body.(type) {
	case nil:
	case []byte:
		reader = bytes.NewReader(value)
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			c.env.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, c.env.router.URL+path, reader)
	if err != nil {
		c.env.t.Fatal(err)
	}
	if c.bearer != "" {
		request.Header.Set("Authorization", "Bearer "+c.bearer)
	} else {
		request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: c.token})
		if method != http.MethodGet && method != http.MethodHead {
			request.Header.Set("X-CSRF-Token", c.csrf)
		}
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := c.env.router.Client().Do(request)
	if err != nil {
		c.env.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	decoded := map[string]any{}
	_ = json.Unmarshal(raw, &decoded)
	return rbacResponse{status: response.StatusCode, body: decoded, raw: string(raw)}
}

func (c *rbacClient) get(path string) rbacResponse { return c.do(http.MethodGet, path, nil, nil) }
func (c *rbacClient) post(path string, body any) rbacResponse {
	return c.do(http.MethodPost, path, body, nil)
}
func (c *rbacClient) put(path string, body any) rbacResponse {
	return c.do(http.MethodPut, path, body, nil)
}
func (c *rbacClient) patch(path string, body any) rbacResponse {
	return c.do(http.MethodPatch, path, body, nil)
}
func (c *rbacClient) delete(path string) rbacResponse { return c.do(http.MethodDelete, path, nil, nil) }

// must fails the test unless the response has the wanted status.
func (env *rbacEnvironment) must(label string, response rbacResponse, want int) rbacResponse {
	env.t.Helper()
	if response.status != want {
		env.t.Fatalf("%s = %d, want %d: %s", label, response.status, want, response.raw)
	}
	return response
}

func (env *rbacEnvironment) id(response rbacResponse) string {
	env.t.Helper()
	value, _ := response.data()["id"].(string)
	if value == "" {
		env.t.Fatalf("response has no id: %s", response.raw)
	}
	return value
}

func testPNG(t *testing.T, shade uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		for y := 0; y < 4; y++ {
			img.Set(x, y, color.RGBA{R: shade, G: 80, B: 120, A: 255})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// startUpload creates a session and sends every byte, leaving it ready to
// complete.
func (c *rbacClient) startUpload(name string, folder *string, content []byte) (rbacResponse, string) {
	c.env.t.Helper()
	body := map[string]any{"filename": name, "mimeType": "image/png", "sizeBytes": len(content)}
	if folder != nil {
		body["folderId"] = *folder
	}
	created := c.post("/api/v1/uploads", body)
	if created.status != http.StatusCreated {
		return created, ""
	}
	id := created.data()["id"].(string)
	appended := c.do(http.MethodPatch, "/api/v1/uploads/"+id, content, map[string]string{
		"Upload-Offset": "0", "Content-Type": "application/offset+octet-stream",
	})
	if appended.status != http.StatusNoContent {
		c.env.t.Fatalf("append upload = %d: %s", appended.status, appended.raw)
	}
	return created, id
}

// upload sends a whole file and completes it, returning the created asset.
func (c *rbacClient) upload(name string, folder *string, content []byte) rbacResponse {
	c.env.t.Helper()
	created, id := c.startUpload(name, folder, content)
	if id == "" {
		return created
	}
	return c.post("/api/v1/uploads/"+id+"/complete", nil)
}

func assetNames(response rbacResponse) []string {
	items, _ := response.data()["items"].([]any)
	names := []string{}
	for _, item := range items {
		names = append(names, item.(map[string]any)["name"].(string))
	}
	sort.Strings(names)
	return names
}

func listNames(response rbacResponse) []string {
	items, _ := response.body["data"].([]any)
	names := []string{}
	for _, item := range items {
		names = append(names, item.(map[string]any)["name"].(string))
	}
	sort.Strings(names)
	return names
}

func strPtr(value string) *string { return &value }

// TestClassroomMediaScenario is the end-to-end school case: an Owner defines
// a Classroom Media role, gives a teacher one folder and one tag, and an
// Owner-managed tag playlist picks up what the teacher tags. The teacher
// never holds playlist or screen access.
func TestClassroomMediaScenario(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		ctx := context.Background()
		owner := env.owner

		// Library structure, made by the Owner.
		room313 := env.id(env.must("create Room 313", owner.post("/api/v1/content-folders", map[string]any{"name": "Room 313"}), http.StatusCreated))
		announcements := env.id(env.must("create Announcements", owner.post("/api/v1/content-folders", map[string]any{"name": "Announcements", "parentId": room313}), http.StatusCreated))
		room200 := env.id(env.must("create Room 200", owner.post("/api/v1/content-folders", map[string]any{"name": "Room 200"}), http.StatusCreated))
		signage := env.id(env.must("create signage tag", owner.post("/api/v1/content-tags", map[string]any{"name": "Room 313 Signage"}), http.StatusCreated))
		staffOnly := env.id(env.must("create staff tag", owner.post("/api/v1/content-tags", map[string]any{"name": "Staff Only"}), http.StatusCreated))
		boardMeeting := env.id(env.must("create collection", owner.post("/api/v1/content-collections", map[string]any{"name": "Board Meeting"}), http.StatusCreated))

		secret := env.id(env.must("owner upload Room 200", owner.upload("Room 200 secret.png", &room200, testPNG(t, 10)), http.StatusOK))
		rootAsset := env.id(env.must("owner upload root", owner.upload("Unfiled flyer.png", nil, testPNG(t, 20)), http.StatusOK))
		classAsset := env.id(env.must("owner upload Room 313", owner.upload("Field trip.png", &room313, testPNG(t, 30)), http.StatusOK))
		env.must("owner tag secret", owner.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{secret}, "addTagIds": []string{staffOnly}, "addCollectionIds": []string{boardMeeting}}), http.StatusOK)

		// An Owner-managed tag playlist, assigned to a screen.
		playlist := env.id(env.must("create playlist", owner.post("/api/v1/playlists", map[string]any{"name": "Room 313 Loop"}), http.StatusCreated))
		ruled := env.must("tag rule", owner.put("/api/v1/playlists/"+playlist+"/tag-rule", map[string]any{"enabled": true, "match": "any", "imageDurationMs": 10000, "tagIds": []string{signage}}), http.StatusOK)
		env.must("publish playlist", owner.post("/api/v1/playlists/"+playlist+"/publish", map[string]any{"expectedDraftRevision": ruled.data()["draftRevision"]}), http.StatusCreated)
		screenID := uuid.New()
		var organizationID uuid.UUID
		if err := env.pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&organizationID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Room 313 TV','android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','America/New_York')`, screenID, organizationID, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id) VALUES($1,$2,$3)`, uuid.New(), screenID, playlist); err != nil {
			t.Fatal(err)
		}

		// The custom role carries only Media capabilities.
		role := env.must("create role", owner.post("/api/v1/roles", map[string]any{
			"name": "Classroom Media", "description": "Teachers manage their own room's media.",
			"capabilities": []string{"media.read", "media.upload", "media.edit", "media.archive", "media.delete", "media.tags.assign"},
		}), http.StatusCreated)
		roleKey := role.data()["key"].(string)
		if roleKey != "custom.classroom-media" || role.data()["builtin"] != false {
			t.Fatalf("role = %v", role.data())
		}
		env.must("create teacher", owner.post("/api/v1/users", map[string]any{
			"name": "Ms. Rivera", "username": "rivera", "password": env.password, "role": roleKey,
			"contentAccess": map[string]any{"libraryMode": "restricted", "tagMode": "restricted", "folderIds": []string{room313}, "tagIds": []string{signage}},
		}), http.StatusCreated)
		teacher := env.login("rivera")

		// Effective capabilities come from the server.
		status := teacher.get("/api/v1/auth/status")
		capabilities, _ := status.data()["capabilities"].([]any)
		if len(capabilities) != 6 {
			t.Fatalf("teacher capabilities = %v", capabilities)
		}
		access := env.must("my access", teacher.get("/api/v1/me/access"), http.StatusOK).data()
		content := access["content"].(map[string]any)
		writable, _ := content["writableFolderIds"].([]any)
		if content["libraryMode"] != "restricted" || len(writable) != 2 {
			t.Fatalf("teacher content access = %v", content)
		}

		// Only the granted subtree is visible, from every Media surface.
		if names := listNames(env.must("teacher folders", teacher.get("/api/v1/content-folders"), http.StatusOK)); strings.Join(names, ",") != "Announcements,Room 313" {
			t.Fatalf("teacher folders = %v", names)
		}
		for _, folder := range teacher.get("/api/v1/content-folders").body["data"].([]any) {
			entry := folder.(map[string]any)
			if entry["name"] == "Room 313" && entry["parentId"] != nil {
				t.Fatalf("granted folder exposes an inaccessible parent: %v", entry)
			}
		}
		if names := assetNames(teacher.get("/api/v1/assets")); strings.Join(names, ",") != "Field trip" {
			t.Fatalf("teacher library = %v", names)
		}
		if total := teacher.get("/api/v1/assets").data()["total"]; total != float64(1) {
			t.Fatalf("teacher total = %v", total)
		}
		for _, query := range []string{"?search=secret", "?folderId=" + room200, "?tagId=" + staffOnly, "?collectionId=" + boardMeeting, "?archived=true", "?type=media&search=Unfiled"} {
			if names := assetNames(teacher.get("/api/v1/assets" + query)); len(names) != 0 {
				t.Fatalf("teacher %s leaked %v", query, names)
			}
		}
		tags := listNames(env.must("teacher tags", teacher.get("/api/v1/content-tags"), http.StatusOK))
		if strings.Join(tags, ",") != "Room 313 Signage" {
			t.Fatalf("teacher tags = %v", tags)
		}
		if collections := listNames(teacher.get("/api/v1/content-collections")); len(collections) != 0 {
			t.Fatalf("teacher collections = %v", collections)
		}
		for _, path := range []string{"/api/v1/assets/" + secret, "/api/v1/assets/" + secret + "/thumbnail", "/api/v1/assets/" + secret + "/preview", "/api/v1/assets/" + rootAsset} {
			env.must("teacher direct "+path, teacher.get(path), http.StatusNotFound)
		}
		detail := env.must("teacher detail", teacher.get("/api/v1/assets/"+classAsset), http.StatusOK).data()
		if detail["name"] != "Field trip" {
			t.Fatalf("detail = %v", detail)
		}

		// Unrelated workspaces stay closed, whatever Studio shows.
		for _, path := range []string{"/api/v1/playlists", "/api/v1/screens", "/api/v1/layouts", "/api/v1/plugins", "/api/v1/users", "/api/v1/schedules", "/api/v1/data-sources", "/api/v1/campaigns", "/api/v1/roles"} {
			if response := teacher.get(path); response.status != http.StatusForbidden || response.code() != "insufficient_role" {
				t.Fatalf("teacher %s = %d %s", path, response.status, response.raw)
			}
		}
		env.must("teacher own preferences", teacher.get("/api/v1/me/preferences"), http.StatusOK)
		env.must("teacher settings document", teacher.get("/api/v1/settings"), http.StatusOK)

		// Uploads land directly in an authorized folder and never at the root.
		if response := teacher.upload("No folder.png", nil, testPNG(t, 40)); response.status != http.StatusUnprocessableEntity || response.code() != "upload_folder_required" {
			t.Fatalf("teacher root upload = %d %s", response.status, response.raw)
		}
		if response := teacher.upload("Wrong room.png", &room200, testPNG(t, 41)); response.status != http.StatusNotFound {
			t.Fatalf("teacher Room 200 upload = %d %s", response.status, response.raw)
		}
		uploaded := env.must("teacher upload", teacher.upload("Spelling bee.png", &announcements, testPNG(t, 42)), http.StatusOK).data()
		poster := uploaded["id"].(string)
		if uploaded["folderId"] != announcements {
			t.Fatalf("uploaded asset folder = %v, want %s", uploaded["folderId"], announcements)
		}
		var rootCount int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM assets WHERE created_by=(SELECT id FROM users WHERE username='rivera') AND folder_id IS NULL`).Scan(&rootCount); err != nil || rootCount != 0 {
			t.Fatalf("teacher assets at root = %d err=%v", rootCount, err)
		}

		// Editing, archiving, and deleting follow role and scope.
		env.must("teacher rename", teacher.patch("/api/v1/assets/"+poster, map[string]any{"name": "Spelling bee finals"}), http.StatusOK)
		env.must("teacher rename other room", teacher.patch("/api/v1/assets/"+secret, map[string]any{"name": "mine now"}), http.StatusNotFound)
		env.must("teacher delete other room", teacher.delete("/api/v1/assets/"+secret), http.StatusNotFound)
		env.must("teacher archive other room", teacher.post("/api/v1/assets/archive", map[string]any{"assetIds": []string{secret}}), http.StatusNotFound)
		env.must("teacher retry other room", teacher.post("/api/v1/assets/"+secret+"/retry", nil), http.StatusNotFound)
		env.must("teacher move", teacher.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{poster}, "setFolder": true, "folderId": room313}), http.StatusForbidden)

		// Tags: only the granted tag, and never tag management.
		manifestVersion := func() int64 {
			var version int64
			_ = env.pool.QueryRow(ctx, `SELECT COALESCE((SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1),0)`, screenID).Scan(&version)
			return version
		}
		before := manifestVersion()
		env.must("teacher apply signage", teacher.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{poster}, "addTagIds": []string{signage}}), http.StatusOK)
		if after := manifestVersion(); after <= before {
			t.Fatalf("tagging did not invalidate the tag playlist's screen: %d -> %d", before, after)
		}
		if response := teacher.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{poster}, "addTagIds": []string{staffOnly}}); response.status != http.StatusForbidden || response.code() != "tag_not_assignable" {
			t.Fatalf("teacher apply Staff Only = %d %s", response.status, response.raw)
		}
		env.must("teacher add collection", teacher.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{poster}, "addCollectionIds": []string{boardMeeting}}), http.StatusForbidden)
		env.must("teacher create tag", teacher.post("/api/v1/content-tags", map[string]any{"name": "Mine"}), http.StatusForbidden)
		env.must("teacher rename tag", teacher.patch("/api/v1/content-tags/"+signage, map[string]any{"name": "Renamed"}), http.StatusForbidden)
		env.must("teacher delete tag", teacher.delete("/api/v1/content-tags/"+signage), http.StatusForbidden)
		env.must("teacher create folder", teacher.post("/api/v1/content-folders", map[string]any{"name": "Mine", "parentId": room313}), http.StatusForbidden)

		// The Owner's tag playlist now plays the teacher's poster once it is
		// processed, without the teacher holding any playlist capability.
		for _, step := range []string{"processing", "ready"} {
			if _, err := env.pool.Exec(ctx, `UPDATE assets SET processing_status=$2,width=4,height=4 WHERE id=$1`, poster, step); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := env.pool.Exec(ctx, `UPDATE asset_variants SET player_compatible=TRUE WHERE asset_id=$1`, poster); err != nil {
			t.Fatal(err)
		}
		loop := env.must("owner playlist", owner.get("/api/v1/playlists/"+playlist), http.StatusOK).data()
		found := false
		for _, item := range loop["items"].([]any) {
			if item.(map[string]any)["assetId"] == poster {
				found = true
			}
		}
		if !found {
			t.Fatalf("tag playlist items = %v, want the teacher's poster", loop["items"])
		}

		// A bulk request naming one inaccessible asset changes nothing.
		env.must("teacher remove signage", teacher.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{poster}, "removeTagIds": []string{signage}}), http.StatusOK)
		if response := teacher.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{poster, secret}, "addTagIds": []string{signage}}); response.status != http.StatusNotFound {
			t.Fatalf("mixed bulk = %d %s", response.status, response.raw)
		}
		var tagged int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM content_asset_tags WHERE tag_id=$1`, signage).Scan(&tagged); err != nil || tagged != 0 {
			t.Fatalf("mixed bulk changed %d assets err=%v", tagged, err)
		}
		if response := teacher.post("/api/v1/assets/archive", map[string]any{"assetIds": []string{poster, secret}}); response.status != http.StatusNotFound {
			t.Fatalf("mixed archive = %d %s", response.status, response.raw)
		}
		var archived int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM assets WHERE archived_at IS NOT NULL`).Scan(&archived); err != nil || archived != 0 {
			t.Fatalf("mixed archive archived %d err=%v", archived, err)
		}

		env.must("teacher archive", teacher.post("/api/v1/assets/archive", map[string]any{"assetIds": []string{poster}}), http.StatusOK)
		if names := assetNames(teacher.get("/api/v1/assets?archived=true")); strings.Join(names, ",") != "Spelling bee finals" {
			t.Fatalf("teacher archive view = %v", names)
		}
		env.must("teacher restore", teacher.post("/api/v1/assets/restore", map[string]any{"assetIds": []string{poster}}), http.StatusOK)

		// A personal access token is bound by the same role and scope.
		pat := env.must("teacher PAT", teacher.post("/api/v1/me/security/pats", map[string]any{"name": "laptop", "scopes": []string{"admin"}, "expiresInDays": 7}), http.StatusCreated)
		bearer := &rbacClient{env: env, bearer: pat.data()["token"].(string)}
		if names := assetNames(env.must("bearer library", bearer.get("/api/v1/assets"), http.StatusOK)); strings.Join(names, ",") != "Field trip,Spelling bee finals" {
			t.Fatalf("bearer library = %v", names)
		}
		env.must("bearer other room", bearer.get("/api/v1/assets/"+secret), http.StatusNotFound)
		env.must("bearer playlists", bearer.get("/api/v1/playlists"), http.StatusForbidden)
		env.must("bearer users", bearer.get("/api/v1/users"), http.StatusForbidden)
		if response := bearer.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{poster}, "addTagIds": []string{staffOnly}}); response.status != http.StatusForbidden {
			t.Fatalf("bearer Staff Only = %d %s", response.status, response.raw)
		}
		if response := bearer.post("/api/v1/uploads", map[string]any{"filename": "x.png", "mimeType": "image/png", "sizeBytes": 10, "folderId": room200}); response.status != http.StatusNotFound {
			t.Fatalf("bearer Room 200 upload = %d %s", response.status, response.raw)
		}

		env.must("teacher delete", teacher.delete("/api/v1/assets/"+poster), http.StatusNoContent)

		// A role change applies to the next request of an existing session
		// and an existing token: no new sign-in.
		env.must("narrow role", owner.patch("/api/v1/roles/"+roleKey, map[string]any{
			"name": "Classroom Media", "capabilities": []string{"media.read", "media.edit"},
		}), http.StatusOK)
		env.must("teacher upload after narrowing", teacher.post("/api/v1/uploads", map[string]any{"filename": "x.png", "mimeType": "image/png", "sizeBytes": 10, "folderId": room313}), http.StatusForbidden)
		env.must("bearer upload after narrowing", bearer.post("/api/v1/uploads", map[string]any{"filename": "x.png", "mimeType": "image/png", "sizeBytes": 10, "folderId": room313}), http.StatusForbidden)
	})
}

// TestContentAccessRevocationAndUploadRevalidation covers grants removed while
// an account is working: the next request loses the folder, an upload that
// has not finished cannot complete into it, and its creator can still cancel
// the abandoned session.
func TestContentAccessRevocationAndUploadRevalidation(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		ctx := context.Background()
		owner := env.owner
		room313 := env.id(env.must("folder", owner.post("/api/v1/content-folders", map[string]any{"name": "Room 313"}), http.StatusCreated))
		art := env.id(env.must("folder", owner.post("/api/v1/content-folders", map[string]any{"name": "Art"}), http.StatusCreated))
		signage := env.id(env.must("tag", owner.post("/api/v1/content-tags", map[string]any{"name": "Signage"}), http.StatusCreated))
		created := env.must("create teacher", owner.post("/api/v1/users", map[string]any{
			"name": "Mr. Chen", "username": "chen", "password": env.password, "role": "contributor",
			"contentAccess": map[string]any{"libraryMode": "restricted", "tagMode": "restricted", "folderIds": []string{room313, art}, "tagIds": []string{signage}},
		}), http.StatusCreated)
		teacherID := env.id(created)
		teacher := env.login("chen")
		env.must("upload", teacher.upload("Art show.png", &art, testPNG(t, 1)), http.StatusOK)
		env.must("upload", teacher.upload("Room news.png", &room313, testPNG(t, 2)), http.StatusOK)

		// Removing a folder grant removes the folder on the next request.
		env.must("revoke Art", owner.put("/api/v1/users/"+teacherID+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "restricted", "folderIds": []string{room313}, "tagIds": []string{signage}}), http.StatusOK)
		if names := assetNames(teacher.get("/api/v1/assets")); strings.Join(names, ",") != "Room news" {
			t.Fatalf("after revoking Art = %v", names)
		}
		env.must("upload to revoked folder", teacher.post("/api/v1/uploads", map[string]any{"filename": "x.png", "mimeType": "image/png", "sizeBytes": 10, "folderId": art}), http.StatusNotFound)

		// Removing a tag grant stops tagging on the next request.
		news := teacher.get("/api/v1/assets").data()["items"].([]any)[0].(map[string]any)["id"].(string)
		env.must("revoke tag", owner.put("/api/v1/users/"+teacherID+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "restricted", "folderIds": []string{room313}}), http.StatusOK)
		env.must("tag after revoke", teacher.post("/api/v1/assets/bulk-organize", map[string]any{"assetIds": []string{news}, "addTagIds": []string{signage}}), http.StatusForbidden)

		// A grant revoked before completion stops the upload, which stays
		// open for its creator to cancel.
		_, pending := teacher.startUpload("Late.png", &room313, testPNG(t, 3))
		env.must("revoke Room 313", owner.put("/api/v1/users/"+teacherID+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "restricted", "folderIds": []string{}}), http.StatusOK)
		if response := teacher.post("/api/v1/uploads/"+pending+"/complete", nil); response.status != http.StatusForbidden || response.code() != "upload_destination_forbidden" {
			t.Fatalf("complete after revoke = %d %s", response.status, response.raw)
		}
		env.must("cancel abandoned upload", teacher.delete("/api/v1/uploads/"+pending), http.StatusNoContent)

		// A grant revoked after finalization has started is caught inside
		// the registering transaction: the upload fails and no asset exists.
		env.must("restore Room 313", owner.put("/api/v1/users/"+teacherID+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "restricted", "folderIds": []string{room313}}), http.StatusOK)
		_, racing := teacher.startUpload("Racing.png", &room313, testPNG(t, 4))
		env.media.SetFinalizationHooks(media.FinalizationHooks{BeforeIdentityPersist: func() error {
			_, err := env.pool.Exec(ctx, `DELETE FROM user_content_folder_grants WHERE user_id=$1`, teacherID)
			return err
		}})
		if response := teacher.post("/api/v1/uploads/"+racing+"/complete", nil); response.status != http.StatusForbidden {
			t.Fatalf("complete with mid-finalization revoke = %d %s", response.status, response.raw)
		}
		env.media.SetFinalizationHooks(media.FinalizationHooks{})
		var status, failure string
		if err := env.pool.QueryRow(ctx, `SELECT status,COALESCE(failure_code,'') FROM upload_sessions WHERE id=$1`, racing).Scan(&status, &failure); err != nil || status != "failed" || failure != "upload_destination_forbidden" {
			t.Fatalf("racing upload = %s/%s err=%v", status, failure, err)
		}
		var named int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM assets WHERE name='Racing'`).Scan(&named); err != nil || named != 0 {
			t.Fatalf("racing upload created %d assets err=%v", named, err)
		}
	})
}

// TestBuiltinRolesKeepTheirAuthority hits a representative route of each
// area as every built-in role and checks the result matches what each role
// could do before capabilities existed.
func TestBuiltinRolesKeepTheirAuthority(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		clients := map[string]*rbacClient{"owner": env.owner}
		for _, role := range []string{"administrator", "editor", "contributor", "viewer"} {
			env.must("create "+role, env.owner.post("/api/v1/users", map[string]any{"name": "User " + role, "username": role, "password": env.password, "role": role}), http.StatusCreated)
			clients[role] = env.login(role)
		}
		// allowed lists, per probe, the roles main allowed. A probe passes the
		// authorization boundary when it gets anything but 401/403.
		probes := []struct {
			label   string
			method  string
			path    string
			body    any
			allowed []string
		}{
			{"list media", http.MethodGet, "/api/v1/assets", nil, []string{"owner", "administrator", "editor", "contributor", "viewer"}},
			{"create upload", http.MethodPost, "/api/v1/uploads", map[string]any{"filename": "a.png", "mimeType": "image/png", "sizeBytes": 10}, []string{"owner", "administrator", "editor", "contributor"}},
			{"create folder", http.MethodPost, "/api/v1/content-folders", map[string]any{"name": "F " + strconv.FormatInt(time.Now().UnixNano(), 10)}, []string{"owner", "administrator", "editor", "contributor"}},
			{"archive", http.MethodPost, "/api/v1/assets/archive", map[string]any{"assetIds": []string{uuid.NewString()}}, []string{"owner", "administrator", "editor"}},
			{"create playlist", http.MethodPost, "/api/v1/playlists", map[string]any{"name": "P"}, []string{"owner", "administrator", "editor", "contributor"}},
			{"list screens", http.MethodGet, "/api/v1/screens", nil, []string{"owner", "administrator", "editor", "contributor", "viewer"}},
			{"pending pairings", http.MethodGet, "/api/v1/screens/pairing/pending", nil, []string{"owner", "administrator"}},
			{"list users", http.MethodGet, "/api/v1/users", nil, []string{"owner", "administrator"}},
			{"list roles", http.MethodGet, "/api/v1/roles", nil, []string{"owner", "administrator"}},
			{"system status", http.MethodGet, "/api/v1/system/status", nil, []string{"owner", "administrator"}},
			{"settings export", http.MethodGet, "/api/v1/system/settings/export", nil, []string{"owner"}},
			{"list plugins", http.MethodGet, "/api/v1/plugins", nil, []string{"owner", "administrator", "editor", "contributor", "viewer"}},
			{"settings document", http.MethodGet, "/api/v1/settings", nil, []string{"owner", "administrator", "editor", "contributor", "viewer"}},
		}
		for _, probe := range probes {
			for role, client := range clients {
				response := client.do(probe.method, probe.path, probe.body, nil)
				allowed := false
				for _, candidate := range probe.allowed {
					if candidate == role {
						allowed = true
					}
				}
				denied := response.status == http.StatusForbidden && response.code() == "insufficient_role"
				if allowed == denied {
					t.Errorf("%s as %s = %d %s (allowed=%v)", probe.label, role, response.status, response.raw, allowed)
				}
			}
		}
		// Every pre-existing account kept the whole library.
		var restricted int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM users u LEFT JOIN user_content_access a ON a.user_id=u.id WHERE a.library_mode IS DISTINCT FROM 'all'`).Scan(&restricted); err != nil || restricted != 0 {
			t.Fatalf("%d accounts lost the whole library err=%v", restricted, err)
		}
	})
}

// TestPrivilegeEscalationIsRefused covers delegation: nobody hands out more
// than they hold, Administrators cannot mint Administrators by another name,
// accounts cannot widen themselves, and the last Owner stays.
func TestPrivilegeEscalationIsRefused(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		owner := env.owner
		room := env.id(env.must("folder", owner.post("/api/v1/content-folders", map[string]any{"name": "Room 1"}), http.StatusCreated))
		other := env.id(env.must("folder", owner.post("/api/v1/content-folders", map[string]any{"name": "Room 2"}), http.StatusCreated))
		adminID := env.id(env.must("create admin", owner.post("/api/v1/users", map[string]any{"name": "Admin", "username": "admin", "password": env.password, "role": "administrator"}), http.StatusCreated))
		admin := env.login("admin")

		// An Administrator may build a role from what it holds, but not one
		// that manages people or roles, and nobody may claim Owner-reserved
		// capabilities.
		if response := admin.post("/api/v1/roles", map[string]any{"name": "Helpdesk", "capabilities": []string{"users.manage"}}); response.status != http.StatusForbidden || response.code() != "role_delegation" {
			t.Fatalf("admin users.manage role = %d %s", response.status, response.raw)
		}
		if response := owner.post("/api/v1/roles", map[string]any{"name": "Backups", "capabilities": []string{"system.backups"}}); response.status != http.StatusUnprocessableEntity {
			t.Fatalf("reserved capability role = %d %s", response.status, response.raw)
		}
		if response := owner.post("/api/v1/roles", map[string]any{"name": "Broken", "capabilities": []string{"media.upload"}}); response.status != http.StatusUnprocessableEntity {
			t.Fatalf("role missing a requirement = %d %s", response.status, response.raw)
		}
		if response := owner.post("/api/v1/roles", map[string]any{"name": "Made up", "capabilities": []string{"everything.everywhere"}}); response.status != http.StatusUnprocessableEntity {
			t.Fatalf("unknown capability = %d %s", response.status, response.raw)
		}
		media := env.must("admin media role", admin.post("/api/v1/roles", map[string]any{"name": "Media Desk", "capabilities": []string{"media.read", "media.upload"}}), http.StatusCreated)
		mediaRole := media.data()["key"].(string)
		env.must("admin edit builtin", admin.patch("/api/v1/roles/editor", map[string]any{"name": "Editor", "capabilities": []string{"media.read"}}), http.StatusConflict)
		env.must("admin delete builtin", admin.delete("/api/v1/roles/viewer"), http.StatusConflict)

		// An Owner-made people manager can manage only roles within its own
		// authority, and cannot touch the role that makes it a manager.
		people := env.must("people role", owner.post("/api/v1/roles", map[string]any{"name": "People Desk", "capabilities": []string{"users.manage", "media.read", "media.upload"}}), http.StatusCreated)
		peopleRole := people.data()["key"].(string)
		env.must("admin edit people role", admin.patch("/api/v1/roles/"+peopleRole, map[string]any{"name": "People Desk", "capabilities": []string{"media.read"}}), http.StatusForbidden)
		env.must("admin delete people role", admin.delete("/api/v1/roles/"+peopleRole), http.StatusForbidden)
		managerID := env.id(env.must("create manager", owner.post("/api/v1/users", map[string]any{"name": "Manager", "username": "manager", "password": env.password, "role": peopleRole}), http.StatusCreated))
		manager := env.login("manager")
		env.must("manager assigns editor", manager.post("/api/v1/users", map[string]any{"name": "Ed One", "username": "ed1", "password": env.password, "role": "editor"}), http.StatusForbidden)
		env.must("manager assigns own role", manager.post("/api/v1/users", map[string]any{"name": "M2", "username": "mgr2", "password": env.password, "role": peopleRole}), http.StatusForbidden)
		env.must("manager assigns media role", manager.post("/api/v1/users", map[string]any{"name": "Desk", "username": "desk", "password": env.password, "role": mediaRole}), http.StatusCreated)
		env.must("manager edits admin", manager.patch("/api/v1/users/"+adminID, map[string]any{"name": "Admin", "username": "admin", "role": "viewer"}), http.StatusForbidden)

		// Administrators keep the old hierarchy over built-in identities.
		env.must("admin creates administrator", admin.post("/api/v1/users", map[string]any{"name": "A2", "username": "admin2", "password": env.password, "role": "administrator"}), http.StatusForbidden)
		env.must("admin creates owner", admin.post("/api/v1/users", map[string]any{"name": "O2", "username": "owner2", "password": env.password, "role": "owner"}), http.StatusForbidden)
		env.must("admin creates editor", admin.post("/api/v1/users", map[string]any{"name": "E2", "username": "editor2", "password": env.password, "role": "editor"}), http.StatusCreated)

		// Nobody widens themselves.
		env.must("admin own role", admin.patch("/api/v1/users/"+adminID, map[string]any{"name": "Admin", "username": "admin", "role": "owner"}), http.StatusForbidden)
		env.must("admin own content", admin.put("/api/v1/users/"+adminID+"/content-access", map[string]any{"libraryMode": "all", "tagMode": "all"}), http.StatusForbidden)
		env.must("admin own screens", admin.put("/api/v1/users/"+adminID+"/screen-scopes", map[string]any{"scopes": []any{}}), http.StatusForbidden)
		env.must("manager own content", manager.put("/api/v1/users/"+managerID+"/content-access", map[string]any{"libraryMode": "all", "tagMode": "all"}), http.StatusForbidden)

		// A restricted administrator can grant only inside its own access.
		env.must("restrict admin", owner.put("/api/v1/users/"+adminID+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "all", "folderIds": []string{room}}), http.StatusOK)
		deskID := env.id(env.must("desk user", owner.post("/api/v1/users", map[string]any{"name": "Desk 2", "username": "desk2", "password": env.password, "role": mediaRole}), http.StatusCreated))
		if response := admin.put("/api/v1/users/"+deskID+"/content-access", map[string]any{"libraryMode": "all", "tagMode": "all"}); response.status != http.StatusForbidden || response.code() != "content_access_delegation" {
			t.Fatalf("restricted admin grants all = %d %s", response.status, response.raw)
		}
		env.must("restricted admin grants other room", admin.put("/api/v1/users/"+deskID+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "all", "folderIds": []string{other}}), http.StatusForbidden)
		env.must("restricted admin grants own room", admin.put("/api/v1/users/"+deskID+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "all", "folderIds": []string{room}}), http.StatusOK)

		// A restricted account creates others restricted by default.
		created := env.must("restricted admin creates", admin.post("/api/v1/users", map[string]any{"name": "Default", "username": "default", "password": env.password, "role": "viewer"}), http.StatusCreated)
		policy := env.must("default policy", owner.get("/api/v1/users/"+env.id(created)+"/content-access"), http.StatusOK).data()["policy"].(map[string]any)
		if policy["libraryMode"] != "restricted" || len(policy["folders"].([]any)) != 0 {
			t.Fatalf("restricted creator default = %v", policy)
		}

		// The Owner is never restricted and the last Owner stays.
		env.must("restrict owner", owner.put("/api/v1/users/"+env.ownerID.String()+"/content-access", map[string]any{"libraryMode": "restricted", "tagMode": "restricted"}), http.StatusForbidden)
		if response := owner.patch("/api/v1/users/"+env.ownerID.String(), map[string]any{"name": "Principal Ortiz", "username": "owner", "role": "administrator"}); response.status != http.StatusConflict || response.code() != "last_owner_required" {
			t.Fatalf("last owner demotion = %d %s", response.status, response.raw)
		}
		// A role in use cannot be deleted.
		env.must("delete assigned role", owner.delete("/api/v1/roles/"+mediaRole), http.StatusConflict)
	})
}

// TestMissingContentPolicyFailsClosed pins the explicit model: an account
// without a policy row reaches no media, unlike the screen-scope convention
// where no rows means everything.
func TestMissingContentPolicyFailsClosed(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		ctx := context.Background()
		folder := env.id(env.must("folder", env.owner.post("/api/v1/content-folders", map[string]any{"name": "Lobby"}), http.StatusCreated))
		env.must("upload", env.owner.upload("Lobby.png", &folder, testPNG(t, 5)), http.StatusOK)
		hash, err := auth.HashPassword(env.password)
		if err != nil {
			t.Fatal(err)
		}
		// Inserted outside the API, as an import or a hand-written fixture
		// might: no content policy exists for this account.
		if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Imported','imported',$2,'editor',TRUE)`, uuid.New(), hash); err != nil {
			t.Fatal(err)
		}
		imported := env.login("imported")
		if names := assetNames(env.must("imported library", imported.get("/api/v1/assets"), http.StatusOK)); len(names) != 0 {
			t.Fatalf("account without a policy sees %v", names)
		}
		env.must("imported root upload", imported.post("/api/v1/uploads", map[string]any{"filename": "a.png", "mimeType": "image/png", "sizeBytes": 10}), http.StatusUnprocessableEntity)
		if access := imported.get("/api/v1/me/access").data()["content"].(map[string]any); access["libraryMode"] != "restricted" {
			t.Fatalf("imported access = %v", access)
		}
		// A custom role key that names nothing grants nothing.
		if _, err = env.pool.Exec(ctx, `INSERT INTO roles(key,name,builtin) VALUES('custom.empty','Empty',FALSE)`); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(ctx, `UPDATE users SET role='custom.empty' WHERE username='imported'`); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(ctx, `INSERT INTO role_capabilities(role_key,capability) VALUES('custom.empty','system.backups'),('custom.empty','not.a.capability')`); err != nil {
			t.Fatal(err)
		}
		status := imported.get("/api/v1/auth/status").data()
		if capabilities, _ := status["capabilities"].([]any); len(capabilities) != 0 {
			t.Fatalf("stored strings became authority: %v", capabilities)
		}
		env.must("empty role media", imported.get("/api/v1/assets"), http.StatusForbidden)
		env.must("empty role settings export", imported.get("/api/v1/system/settings/export"), http.StatusForbidden)
	})
}

// TestMigrationKeepsExistingAuthority applies the role and content-access
// migration to accounts created on the previous schema.
func TestMigrationKeepsExistingAuthority(t *testing.T) {
	baseURL := os.Getenv("TEST_DATABASE_URL")
	if baseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	databaseURL := scratchDatabase(t, ctx, baseURL)
	if err := database.MigrateTo(ctx, databaseURL, 128); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	roles := []string{"owner", "administrator", "editor", "contributor", "viewer"}
	for _, role := range roles {
		if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,'unused',$4,TRUE)`, uuid.New(), "User "+role, "legacy-"+role, role); err != nil {
			t.Fatal(err)
		}
	}
	pool.Close()
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err = database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, role := range roles {
		var stored, library, tags string
		if err = pool.QueryRow(ctx, `SELECT u.role,a.library_mode,a.tag_mode FROM users u JOIN user_content_access a ON a.user_id=u.id WHERE u.username=$1`, "legacy-"+role).Scan(&stored, &library, &tags); err != nil {
			t.Fatalf("%s after migration: %v", role, err)
		}
		if stored != role || library != "all" || tags != "all" {
			t.Fatalf("%s migrated to role=%s library=%s tags=%s", role, stored, library, tags)
		}
		var builtin bool
		if err = pool.QueryRow(ctx, `SELECT builtin FROM roles WHERE key=$1`, role).Scan(&builtin); err != nil || !builtin {
			t.Fatalf("built-in role %s missing: %v", role, err)
		}
	}
	if _, err = pool.Exec(ctx, `UPDATE users SET role='superuser' WHERE username='legacy-viewer'`); err == nil {
		t.Fatal("a role outside the roles table was accepted")
	}
}

func scratchDatabase(t *testing.T, ctx context.Context, baseURL string) string {
	t.Helper()
	admin, err := pgxpool.New(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	name := "tilecast_rbac_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
	if _, err = admin.Exec(ctx, `CREATE DATABASE `+name); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DROP DATABASE IF EXISTS `+name+` WITH (FORCE)`)
		admin.Close()
	})
	parsed, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	return parsed.String()
}

// TestRestrictedAuthorCannotReferenceOtherFolders covers the authoring side
// door: an account with playlist editing but restricted content access
// cannot place an item from another folder by naming its id.
func TestRestrictedAuthorCannotReferenceOtherFolders(t *testing.T) {
	withRBACEnvironment(t, func(env *rbacEnvironment) {
		owner := env.owner
		mine := env.id(env.must("folder", owner.post("/api/v1/content-folders", map[string]any{"name": "Library Branch"}), http.StatusCreated))
		theirs := env.id(env.must("folder", owner.post("/api/v1/content-folders", map[string]any{"name": "Main Branch"}), http.StatusCreated))
		ownAsset := env.id(env.must("upload", owner.upload("Story time.png", &mine, testPNG(t, 7)), http.StatusOK))
		otherAsset := env.id(env.must("upload", owner.upload("Board notes.png", &theirs, testPNG(t, 8)), http.StatusOK))
		env.must("create author", owner.post("/api/v1/users", map[string]any{
			"name": "Branch Author", "username": "branch", "password": env.password, "role": "contributor",
			"contentAccess": map[string]any{"libraryMode": "restricted", "tagMode": "all", "folderIds": []string{mine}},
		}), http.StatusCreated)
		author := env.login("branch")
		playlist := env.id(env.must("author playlist", author.post("/api/v1/playlists", map[string]any{"name": "Branch loop"}), http.StatusCreated))
		env.must("add other folder", author.post("/api/v1/playlists/"+playlist+"/items", map[string]any{"assetId": otherAsset}), http.StatusNotFound)
		if response := author.post("/api/v1/playlists/"+playlist+"/items", map[string]any{"assetId": ownAsset}); response.status == http.StatusNotFound || response.status == http.StatusForbidden {
			t.Fatalf("add own folder = %d %s", response.status, response.raw)
		}
	})
}
