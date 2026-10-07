package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/catalog"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// marketplaceTestClient drives the plugin-store routes with owner and viewer
// sessions. It mirrors the store test setup; marketplace tests additionally
// wire a catalog service and a marketplace-backed plugin service.
type marketplaceTestClient struct {
	call func(role, method, path string, csrf bool, body string) (int, map[string]any)
}

func newMarketplaceTestClient(t *testing.T, env activityTestEnvironment, configure func()) marketplaceTestClient {
	t.Helper()
	ctx := context.Background()
	authService := auth.NewService(env.pool, time.Hour)
	env.server.auth = authService
	env.server.cookieName = "tilecast_session"
	configure()
	router := httptest.NewServer(env.server.routes())
	t.Cleanup(router.Close)

	sessions := map[string]auth.Session{}
	for _, role := range []string{"owner", "viewer"} {
		hash, err := auth.HashPassword("correct horse battery staple")
		if err != nil {
			t.Fatal(err)
		}
		username := "marketplace-" + role
		if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`,
			uuid.New(), role, username, hash, role); err != nil {
			t.Fatal(err)
		}
		result, err := authService.Login(ctx, auth.LoginInput{Username: username, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
		if err != nil || result.Session == nil {
			t.Fatalf("login %s: %v", role, err)
		}
		sessions[role] = *result.Session
	}

	call := func(role, method, path string, csrf bool, body string) (int, map[string]any) {
		t.Helper()
		request, err := http.NewRequest(method, router.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		session := sessions[role]
		request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
		if csrf {
			request.Header.Set("X-CSRF-Token", session.CSRFToken)
		}
		response, err := router.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		decoded := map[string]any{}
		_ = json.Unmarshal(raw, &decoded)
		return response.StatusCode, decoded
	}
	return marketplaceTestClient{call: call}
}

func marketplaceStoreItems(t *testing.T, body map[string]any) []any {
	t.Helper()
	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("store response has no data: %v", body)
	}
	items, ok := data["items"].([]any)
	if !ok {
		t.Fatalf("store data has no items: %v", data)
	}
	return items
}

func findStoreItem(t *testing.T, items []any, packageID string) map[string]any {
	t.Helper()
	for _, raw := range items {
		entry := raw.(map[string]any)
		if entry["packageId"] == packageID {
			return entry
		}
	}
	t.Fatalf("store has no entry for %s", packageID)
	return nil
}

const marketplaceTestDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// TestPluginStoreMarketplaceMerge joins cached marketplace listings into the
// normalized store beside the release-owned entries, with installation state
// read from installed_packages.
func TestPluginStoreMarketplaceMerge(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		var organizationID uuid.UUID
		if err := env.pool.QueryRow(ctx, `SELECT id FROM organization_settings LIMIT 1`).Scan(&organizationID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO installed_packages(organization_id,package_id,package_version,digest,source_kind,source_reference,registry_reference,trust_state,manifest)
			VALUES($1,'acme.weather','0.9.0',$2,'marketplace','https://example.com/acme/weather:1.0.0@`+marketplaceTestDigest+`','registry.example.com/acme/weather','verified','{}')`,
			organizationID, marketplaceTestDigest); err != nil {
			t.Fatal(err)
		}

		fetchedAt := time.Now().UTC().Truncate(time.Second)
		source := func(context.Context) (plugins.MarketplaceSnapshot, error) {
			return plugins.MarketplaceSnapshot{
				Listings: []catalog.Listing{
					{
						PackageID: "acme.countdown-pro", Version: "2.0.0", Name: "Countdown Pro",
						Description: "A bigger countdown.", Publisher: catalog.Publisher{ID: "acme", Name: "Acme"},
						License: "AGPL-3.0-only", TilecastRange: ">=0.0.0",
						OCI: "registry.example.com/acme/countdown-pro", Digest: marketplaceTestDigest,
						Repository: "https://github.com/acme/tilecast-countdown-pro",
						Categories: []string{"display"}, Featured: true,
					},
					{
						PackageID: "acme.weather", Version: "1.0.0", Name: "Weather",
						Description: "Current conditions.", Publisher: catalog.Publisher{ID: "acme", Name: "Acme"},
						License: "AGPL-3.0-only", TilecastRange: ">=0.0.0",
						OCI: "registry.example.com/acme/weather", Digest: marketplaceTestDigest,
						Repository: "https://github.com/acme/tilecast-weather",
					},
				},
				Status: plugins.MarketplaceStatus{LastFetchedAt: &fetchedAt},
			}, nil
		}
		client := newMarketplaceTestClient(t, env, func() {
			env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithMarketplaceSource(source))
		})

		status, body := client.call("viewer", http.MethodGet, "/api/v1/plugin-store", false, "")
		if status != http.StatusOK {
			t.Fatalf("viewer store status = %d", status)
		}
		items := marketplaceStoreItems(t, body)
		if len(items) != 5 {
			t.Fatalf("store items = %d, want 3 included + 2 marketplace", len(items))
		}

		fresh := findStoreItem(t, items, "acme.countdown-pro")
		if kind := fresh["source"].(map[string]any)["kind"]; kind != "marketplace" {
			t.Fatalf("marketplace entry kind = %v", kind)
		}
		if catalogID := fresh["source"].(map[string]any)["catalogId"]; catalogID != "tilecast-marketplace" {
			t.Fatalf("marketplace entry catalogId = %v", catalogID)
		}
		if _, ok := fresh["plugin"]; ok {
			t.Fatal("marketplace entry carries plugin detail")
		}
		listing := fresh["marketplace"].(map[string]any)
		if listing["version"] != "2.0.0" || listing["publisherName"] != "Acme" || listing["digest"] != marketplaceTestDigest {
			t.Fatalf("marketplace detail = %v", listing)
		}
		if listing["installed"] != false {
			t.Fatalf("uninstalled marketplace entry installed = %v", listing["installed"])
		}
		if featured, _ := listing["featured"].(bool); !featured {
			t.Fatalf("marketplace entry featured = %v, want true", listing["featured"])
		}
		if categories, _ := listing["categories"].([]any); len(categories) != 1 || categories[0] != "display" {
			t.Fatalf("marketplace entry categories = %v", listing["categories"])
		}
		// Development builds report 0.0.0-dev, which is not a release
		// triple, so compatibility fails closed in tests.
		if listing["compatible"] != false {
			t.Fatalf("marketplace entry compatible = %v on a dev build", listing["compatible"])
		}

		weather := findStoreItem(t, items, "acme.weather")
		weatherListing := weather["marketplace"].(map[string]any)
		if weatherListing["installed"] != true {
			t.Fatalf("installed marketplace entry installed = %v", weatherListing["installed"])
		}
		if weatherListing["installedVersion"] != "0.9.0" {
			t.Fatalf("installedVersion = %v, want 0.9.0", weatherListing["installedVersion"])
		}
		if weatherListing["updateAvailable"] != true {
			t.Fatalf("updateAvailable = %v, want true for 0.9.0 behind 1.0.0", weatherListing["updateAvailable"])
		}

		marketplace := body["data"].(map[string]any)["marketplace"].(map[string]any)
		if _, ok := marketplace["configured"]; ok {
			t.Fatalf("marketplace status carries configured: %v", marketplace)
		}
		if marketplace["stale"] != false {
			t.Fatalf("marketplace status = %v", marketplace)
		}
		if _, ok := marketplace["lastFetchedAt"]; !ok {
			t.Fatal("marketplace status omits lastFetchedAt")
		}

		// One marketplace entry through the detail route.
		if status, body = client.call("viewer", http.MethodGet, "/api/v1/plugin-store/acme.weather", false, ""); status != http.StatusOK {
			t.Fatalf("viewer marketplace entry status = %d", status)
		} else if detail := body["data"].(map[string]any)["marketplace"].(map[string]any); detail["installedVersion"] != "0.9.0" {
			t.Fatalf("marketplace entry detail = %v", detail)
		}
	})
}

// TestPluginStoreMarketplaceError keeps serving the release-owned entries
// when the marketplace snapshot fails, with the failure on the status.
func TestPluginStoreMarketplaceError(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		source := func(context.Context) (plugins.MarketplaceSnapshot, error) {
			return plugins.MarketplaceSnapshot{}, errors.New("catalog unreachable")
		}
		client := newMarketplaceTestClient(t, env, func() {
			env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithMarketplaceSource(source))
		})

		status, body := client.call("viewer", http.MethodGet, "/api/v1/plugin-store", false, "")
		if status != http.StatusOK {
			t.Fatalf("viewer store status = %d", status)
		}
		if items := marketplaceStoreItems(t, body); len(items) != 3 {
			t.Fatalf("store items = %d, want 3 included", len(items))
		}
		marketplace := body["data"].(map[string]any)["marketplace"].(map[string]any)
		if marketplace["stale"] != true {
			t.Fatalf("marketplace status = %v", marketplace)
		}
		if marketplace["error"] != "The marketplace catalog cache could not be read." {
			t.Fatalf("marketplace error = %v", marketplace["error"])
		}
	})
}

func marketplaceTestDocument(t *testing.T) []byte {
	t.Helper()
	payload, err := json.Marshal(catalog.Document{
		FormatVersion: catalog.CatalogFormatVersion,
		Listings: []catalog.Listing{
			{
				PackageID: "acme.weather", Version: "1.0.0", Name: "Weather",
				Description: "Current conditions.", Publisher: catalog.Publisher{ID: "acme", Name: "Acme"},
				License: "AGPL-3.0-only", TilecastRange: ">=0.0.0",
				OCI: "registry.example.com/acme/weather", Digest: marketplaceTestDigest,
				Repository:    "https://github.com/acme/tilecast-weather",
				Documentation: "https://example.com/acme/weather/docs",
				Issues:        "https://github.com/acme/tilecast-weather/issues",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

// TestRefreshMarketplaceCatalog drives the refresh endpoint through the
// production router: role and CSRF guards, a refresh that lands listings
// in the store, and a failed refresh that answers 502 while the store
// keeps serving.
func TestRefreshMarketplaceCatalog(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		document := marketplaceTestDocument(t)
		// The catalog fails in place: the URL stays fixed, as in
		// production, so the cached document keeps serving.
		var failing atomic.Bool
		catalogServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if failing.Load() {
				http.Error(w, "catalog down", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(document)
		}))
		t.Cleanup(catalogServer.Close)

		marketplace := catalog.NewServiceWithURL(env.pool, catalogServer.URL)
		client := newMarketplaceTestClient(t, env, func() {
			env.server.marketplace = marketplace
			service := plugins.NewService(env.pool, nil)
			service.SetMarketplaceSource(func(ctx context.Context) (plugins.MarketplaceSnapshot, error) {
				cached, err := marketplace.Cached(ctx)
				if err != nil {
					return plugins.MarketplaceSnapshot{}, err
				}
				return plugins.MarketplaceSnapshotFrom(cached, time.Now()), nil
			})
			env.server.plugins = service
		})

		// Role and CSRF guards.
		if status, body := client.call("viewer", http.MethodPost, "/api/v1/plugin-store/marketplace/refresh", true, ""); status != http.StatusForbidden {
			t.Fatalf("viewer refresh status = %d, want 403 (%v)", status, body)
		}
		if status, body := client.call("owner", http.MethodPost, "/api/v1/plugin-store/marketplace/refresh", false, ""); status != http.StatusForbidden {
			t.Fatalf("owner refresh without CSRF status = %d, want 403 (%v)", status, body)
		}

		// A refresh lands the listing in the store.
		status, body := client.call("owner", http.MethodPost, "/api/v1/plugin-store/marketplace/refresh", true, "")
		if status != http.StatusOK {
			t.Fatalf("refresh status = %d (%v)", status, body)
		}
		refreshed := body["data"].(map[string]any)["marketplace"].(map[string]any)
		if refreshed["stale"] != false {
			t.Fatalf("refresh status = %v", refreshed)
		}
		if _, ok := refreshed["lastFetchedAt"]; !ok {
			t.Fatal("refresh status omits lastFetchedAt")
		}
		status, body = client.call("viewer", http.MethodGet, "/api/v1/plugin-store", false, "")
		if status != http.StatusOK {
			t.Fatalf("viewer store status = %d", status)
		}
		items := marketplaceStoreItems(t, body)
		if len(items) != 4 {
			t.Fatalf("store items = %d, want 3 included + 1 marketplace", len(items))
		}
		entry := findStoreItem(t, items, "acme.weather")
		if entry["marketplace"].(map[string]any)["version"] != "1.0.0" {
			t.Fatalf("refreshed entry = %v", entry["marketplace"])
		}

		// A failed refresh answers 502; the cache keeps serving.
		failing.Store(true)
		if status, body = client.call("owner", http.MethodPost, "/api/v1/plugin-store/marketplace/refresh", true, ""); status != http.StatusBadGateway {
			t.Fatalf("failed refresh status = %d, want 502 (%v)", status, body)
		} else if code := body["error"].(map[string]any)["code"]; code != "marketplace_refresh_failed" {
			t.Fatalf("failed refresh code = %v", code)
		}
		status, body = client.call("viewer", http.MethodGet, "/api/v1/plugin-store", false, "")
		if status != http.StatusOK {
			t.Fatalf("viewer store status after failed refresh = %d", status)
		}
		items = marketplaceStoreItems(t, body)
		if len(items) != 4 {
			t.Fatalf("store items after failed refresh = %d, want the cached listing kept", len(items))
		}
		cached := body["data"].(map[string]any)["marketplace"].(map[string]any)
		if cached["error"] == "" || cached["error"] == nil {
			t.Fatalf("marketplace status after failed refresh = %v, want the error recorded", cached)
		}
		if cached["stale"] != true {
			t.Fatalf("marketplace stale after failed refresh = %v, want true", cached["stale"])
		}
	})
}
