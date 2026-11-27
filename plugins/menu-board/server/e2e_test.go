package server_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	menuboard "github.com/tilecast/tilecast/plugins/menu-board"
	"github.com/tilecast/tilecast/plugins/menu-board/server"
)

// Square Menu Board end to end against mock Square OAuth, Catalog, and image
// storage on the harness's fake network. Nothing here reaches Square.

const (
	squareAccess  = "EAAAmock-access-5d21"
	squareRefresh = "EQAAmock-refresh-0c4e"
	imageHost     = "items-images-production.s3.us-west-2.amazonaws.com"
)

type mockSquare struct {
	mu         sync.Mutex
	challenges map[string]string
	pages      map[string]string
	imageAuth  []string
	versions   []string
}

func (m *mockSquare) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/oauth2/token":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		m.mu.Lock()
		challenge := m.challenges[body["code"]]
		m.mu.Unlock()
		sum := sha256.Sum256([]byte(body["code_verifier"]))
		if r.Header.Get("Content-Type") != "application/json" || body["client_id"] != "sq0idp-mock" || body["client_secret"] != "sq0csp-mock" ||
			base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		fmt.Fprintf(w, `{"access_token":%q,"token_type":"bearer","expires_at":"2026-12-23T00:00:00Z","refresh_token":%q}`, squareAccess, squareRefresh)
	case "/v2/catalog/list":
		m.mu.Lock()
		m.versions = append(m.versions, r.Header.Get("Square-Version"))
		body, ok := m.pages[r.URL.Query().Get("cursor")]
		m.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+squareAccess || !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, body)
	default:
		http.NotFound(w, r)
	}
}

func (m *mockSquare) setPages(first, second string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pages = map[string]string{"": first, "next": second}
}

func catalog(name string, image bool) (string, string) {
	images := `"image_ids":["img-latte"],`
	if !image {
		images = ""
	}
	first := fmt.Sprintf(`{"cursor":"next","objects":[{"type":"CATEGORY","id":"cat-coffee","category_data":{"name":"Coffee"}},
	 {"type":"IMAGE","id":"img-latte","image_data":{"url":"https://%s/files/latte.png"}},
	 {"type":"ITEM","id":"item-latte","item_data":{"name":%q,%s"categories":[{"id":"cat-coffee","ordinal":1}],
	  "variations":[{"type":"ITEM_VARIATION","id":"var-latte","item_variation_data":{"name":"Regular","price_money":{"amount":450,"currency":"USD"}}}]}}]}`, imageHost, name, images)
	second := `{"objects":[{"type":"ITEM","id":"item-tea","item_data":{"name":"Tea","categories":[{"id":"cat-coffee","ordinal":1}],
	 "variations":[{"type":"ITEM_VARIATION","id":"var-tea","item_variation_data":{"name":"Regular","price_money":{"amount":300,"currency":"USD"},
	 "location_overrides":[{"location_id":"LOC1","sold_out":true}]}}]}}]}`
	return first, second
}

func pngImage() []byte {
	picture := image.NewRGBA(image.Rect(0, 0, 8, 8))
	picture.Set(1, 1, color.RGBA{200, 100, 0, 255})
	var out bytes.Buffer
	_ = png.Encode(&out, picture)
	return out.Bytes()
}

func TestMenuBoardEndToEnd(t *testing.T) {
	square := &mockSquare{challenges: map[string]string{}}
	square.setPages(catalog("Latte", true))
	network := pluginharness.NewFakeNetwork(t, "connect.squareup.com", imageHost)
	network.Serve("connect.squareup.com", square)
	picture := pngImage()
	network.Serve(imageHost, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		square.mu.Lock()
		square.imageAuth = append(square.imageAuth, r.Header.Get("Authorization"))
		square.mu.Unlock()
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(picture)
	}))
	clock := pluginharness.NewClock(time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC))
	plugin := menuboard.New().(*server.Plugin)
	plugin.Now = clock.Now
	h := pluginharness.New(t, plugin, pluginharness.Network(network), pluginharness.Clock(clock))
	h.Install()

	connection := h.CreateConnection("square", "Cafe Square", "sq0idp-mock", "sq0csp-mock")
	if err := h.ConnectOAuth(connection, func(authorization *url.URL) string {
		query := authorization.Query()
		if authorization.Host != "connect.squareup.com" || query.Get("scope") != "ITEMS_READ" || query.Get("session") != "false" {
			t.Fatalf("authorization = %s", authorization)
		}
		square.mu.Lock()
		defer square.mu.Unlock()
		square.challenges["sq-code"] = query.Get("code_challenge")
		return "sq-code"
	}); err != nil {
		t.Fatalf("connect = %v", err)
	}
	images := h.CreateConnection("square_images", "Square images", "", "")
	created := h.Serve("owner", http.MethodPost, "/plugins/menu-board/menus", fmt.Sprintf(
		`{"name":"Cafe","enabled":true,"connection":%q,"imagesConnection":%q,"locationId":"LOC1","sample":false}`, connection, images))
	if created.Status != http.StatusCreated {
		t.Fatalf("create menu = %d %v", created.Status, created.Body)
	}
	menu := created.Data()["id"].(string)
	sync := func() {
		clock.Advance(11 * time.Minute)
		h.RunTimers()
		h.RunTimers()
	}
	clock.Advance(3 * time.Second)
	h.RunTimers()
	h.RunTimers()
	datasets := h.FeedDatasets()
	if len(datasets) != 1 || datasets[0].Provider != "menu_board.items" || datasets[0].Records != 2 {
		t.Fatalf("datasets = %+v", datasets)
	}
	dataset := datasets[0].ID
	// The picture arrives after the publication, through the images
	// connection, without a Square credential.
	if h.FeedRecords(dataset)["var-latte"].Effective["photo"] != "" || h.RunImageImports() != 1 {
		t.Fatal("the image import did not run after the publication")
	}
	records := h.FeedRecords(dataset)
	latte, tea := records["var-latte"], records["var-tea"]
	if latte.Effective["price"] != "4.5" || latte.Effective["category"] != "Coffee" || latte.Effective["photo"] == "" || tea.Effective["available"] != "false" {
		t.Fatalf("records = %+v %+v", latte, tea)
	}
	square.mu.Lock()
	auth, versions := strings.Join(square.imageAuth, ""), strings.Join(square.versions, ",")
	square.mu.Unlock()
	if auth != "" || versions != server.SquareVersion+","+server.SquareVersion {
		t.Fatalf("image auth %q, versions %q", auth, versions)
	}
	asset := uuid.MustParse(latte.Effective["photo"])
	if _, err := h.Media.GetAsset(h.Ctx, asset); err == nil {
		t.Fatal("a feed picture is in the Media library")
	}
	if state := string(h.KV("menu:" + menu)); !strings.Contains(state, `"pages":2`) || strings.Contains(state, "Latte") {
		t.Fatalf("stored state = %s", state)
	}
	// Overrides: the price stays Square's; a display name survives an
	// unchanged upstream and goes when Square renames the item.
	if err := h.SetFeedOverride(dataset, "var-latte", "price", 1); err == nil {
		t.Fatal("a price override was accepted")
	}
	if err := h.SetFeedOverride(dataset, "var-latte", "name", "House latte"); err != nil {
		t.Fatal(err)
	}
	if err := h.SetFeedOverride(dataset, "var-latte", "shortLabel", "Latte!"); err != nil {
		t.Fatal(err)
	}
	sync()
	if record := h.FeedRecords(dataset)["var-latte"]; record.Effective["name"] != "House latte" || record.Effective["shortLabel"] != "Latte!" {
		t.Fatalf("after an unchanged read = %+v", record)
	}
	square.setPages(catalog("Caffe latte", true))
	sync()
	record := h.FeedRecords(dataset)["var-latte"]
	if record.Effective["name"] != "Caffe latte" || record.Removed["name"].Reason != "upstream_changed" || record.Effective["shortLabel"] != "Latte!" {
		t.Fatalf("after a rename = %+v", record)
	}
	// The picture leaves the item: its reference goes, and so does the grant.
	square.setPages(catalog("Caffe latte", false))
	sync()
	if record := h.FeedRecords(dataset)["var-latte"]; record.Effective["photo"] != "" {
		t.Fatalf("after the picture left = %+v", record)
	}
	var references int
	_ = h.Pool.QueryRow(h.Ctx, `SELECT count(*) FROM plugin_feed_assets WHERE asset_id=$1`, asset).Scan(&references)
	if references != 0 {
		t.Fatal("the picture is still referenced")
	}
	if _, err := h.Media.Delivery(h.Ctx, asset, uuid.New()); err == nil {
		t.Fatal("a Player can still fetch the picture")
	}
	// The first pass marks the picture orphaned; it is discarded 24 hours
	// later.
	if h.CollectFeedAssets() != 0 {
		t.Fatal("a picture was discarded at once")
	}
	clock.Advance(25 * time.Hour)
	if h.CollectFeedAssets() != 1 {
		t.Fatal("the orphaned picture was not discarded after 24 hours")
	}
	// No Square token reaches a screen, the stored state, or the feed.
	screen := h.Screen("Cafe menu board")
	for _, dump := range []any{h.Manifest(screen), h.PlayerState(screen), string(h.KV("menu:" + menu)), string(h.DataSourcePayload(dataset))} {
		encoded, _ := json.Marshal(dump)
		if strings.Contains(string(encoded), squareAccess) || strings.Contains(string(encoded), squareRefresh) {
			t.Fatalf("a token reached %s", encoded)
		}
	}
}
