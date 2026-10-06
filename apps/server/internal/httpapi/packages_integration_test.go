package httpapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/pipeline"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

// TestPackagesAPI drives the package lifecycle routes through the
// production router: reads answer every signed-in role, mutations need
// Owner or Administrator with a CSRF token, and pipeline failures map to
// their documented error codes without touching the network.
func TestPackagesAPI(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		installService := installer.NewService(env.pool, version.Display())
		// No network options: GitHub, registry, attestation, and catalog
		// stay nil, so resolution answers upstream_unavailable and
		// marketplace installs answer marketplace_not_configured.
		pipelineService := pipeline.NewService(env.pool, installService, t.TempDir(), version.Display())
		client := newMarketplaceTestClient(t, env, func() {
			env.server.installer = installService
			env.server.packages = pipelineService
		})

		errorCode := func(body map[string]any) string {
			err, _ := body["error"].(map[string]any)
			code, _ := err["code"].(string)
			return code
		}

		// An empty installation reports an empty list to every role.
		for _, role := range []string{"owner", "viewer"} {
			status, body := client.call(role, http.MethodGet, "/api/v1/packages", false, "")
			if status != http.StatusOK {
				t.Fatalf("%s packages status = %d", role, status)
			}
			items, _ := body["data"].([]any)
			if items == nil || len(items) != 0 {
				t.Fatalf("%s packages data = %v, want empty list", role, body["data"])
			}
		}

		// Unknown packages answer 404 on every route.
		if status, body := client.call("viewer", http.MethodGet, "/api/v1/packages/no.such", false, ""); status != http.StatusNotFound || errorCode(body) != "package_not_installed" {
			t.Fatalf("get unknown = %d %v, want 404 package_not_installed", status, body)
		}
		if status, body := client.call("owner", http.MethodPost, "/api/v1/packages/no.such/update-check", true, ""); status != http.StatusNotFound || errorCode(body) != "package_not_installed" {
			t.Fatalf("update-check unknown = %d %v, want 404 package_not_installed", status, body)
		}
		if status, body := client.call("owner", http.MethodPost, "/api/v1/packages/no.such/update", true, `{"digest":"sha256:abc"}`); status != http.StatusNotFound || errorCode(body) != "package_not_installed" {
			t.Fatalf("update unknown = %d %v, want 404 package_not_installed", status, body)
		}
		if status, body := client.call("owner", http.MethodPost, "/api/v1/packages/no.such/rollback", true, ""); status != http.StatusNotFound || errorCode(body) != "package_not_installed" {
			t.Fatalf("rollback unknown = %d %v, want 404 package_not_installed", status, body)
		}
		if status, body := client.call("owner", http.MethodDelete, "/api/v1/packages/no.such", true, ""); status != http.StatusNotFound || errorCode(body) != "package_not_installed" {
			t.Fatalf("remove unknown = %d %v, want 404 package_not_installed", status, body)
		}

		// Updates need a digest.
		if status, body := client.call("owner", http.MethodPost, "/api/v1/packages/no.such/update", true, `{}`); status != http.StatusBadRequest || errorCode(body) != "invalid_request" {
			t.Fatalf("update without digest = %d %v, want 400 invalid_request", status, body)
		}

		// Resolution validates the repository before any network use.
		if status, body := client.call("owner", http.MethodPost, "/api/v1/plugin-store/resolve-github", true, `{"repository":"not a url"}`); status != http.StatusBadRequest || errorCode(body) != "invalid_repository" {
			t.Fatalf("resolve garbage = %d %v, want 400 invalid_repository", status, body)
		}
		// A well-formed URL with no network clients answers 502.
		if status, body := client.call("owner", http.MethodPost, "/api/v1/plugin-store/resolve-github", true, `{"repository":"https://github.com/acme/tilecast-custom"}`); status != http.StatusBadGateway || errorCode(body) != "upstream_unavailable" {
			t.Fatalf("resolve unconfigured = %d %v, want 502 upstream_unavailable", status, body)
		}

		// Mutations need Owner or Administrator with a CSRF token.
		if status, _ := client.call("viewer", http.MethodPost, "/api/v1/plugin-store/acme.custom/install", true, ""); status != http.StatusForbidden {
			t.Fatalf("viewer install status = %d, want 403", status)
		}
		if status, _ := client.call("owner", http.MethodPost, "/api/v1/plugin-store/acme.custom/install", false, ""); status != http.StatusForbidden {
			t.Fatalf("install without CSRF status = %d, want 403", status)
		}
		if status, _ := client.call("viewer", http.MethodDelete, "/api/v1/packages/acme.custom", true, ""); status != http.StatusForbidden {
			t.Fatalf("viewer remove status = %d, want 403", status)
		}

		// Without a marketplace catalog, a bodiless install answers 409.
		// Both an empty body and an explicit empty object take the
		// marketplace path.
		for _, bodyText := range []string{"", "{}"} {
			status, body := client.call("owner", http.MethodPost, "/api/v1/plugin-store/acme.market/install", true, bodyText)
			if status != http.StatusConflict || errorCode(body) != "marketplace_not_configured" {
				t.Fatalf("marketplace install body %q = %d %v, want 409 marketplace_not_configured", bodyText, status, body)
			}
		}
	})
}

// TestPluginStoreCustomJoin seeds a custom repository binding and expects
// the store to serve it as a custom entry with its repository provenance.
func TestPluginStoreCustomJoin(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		var organizationID uuid.UUID
		if err := env.pool.QueryRow(ctx, `SELECT id FROM organization_settings LIMIT 1`).Scan(&organizationID); err != nil {
			t.Fatal(err)
		}
		manifest := `{"packageId":"acme.custom","packageVersion":"1.2.0","name":"Custom","description":"A custom package.","publisher":{"id":"acme","name":"Acme"},"license":"AGPL-3.0-only","tilecast":{"version":">=0.0.0"}}`
		if _, err := env.pool.Exec(ctx, `INSERT INTO custom_package_sources(organization_id,package_id,repository_owner,repository_name,repository_url,manifest,resolved_digest)
			VALUES($1,'acme.custom','acme','tilecast-custom','https://github.com/acme/tilecast-custom',$2,$3)`,
			organizationID, manifest, marketplaceTestDigest); err != nil {
			t.Fatal(err)
		}

		installService := installer.NewService(env.pool, version.Display())
		pipelineService := pipeline.NewService(env.pool, installService, t.TempDir(), version.Display())
		client := newMarketplaceTestClient(t, env, func() {
			env.server.installer = installService
			env.server.packages = pipelineService
			env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithCustomSource(func(ctx context.Context) ([]plugins.CustomSnapshot, error) {
				sources, err := pipelineService.ListCustomSources(ctx)
				if err != nil {
					return nil, err
				}
				out := make([]plugins.CustomSnapshot, 0, len(sources))
				for _, source := range sources {
					out = append(out, plugins.CustomSnapshot{
						PackageID:     source.PackageID,
						Manifest:      source.Manifest,
						RepositoryURL: source.RepositoryURL,
						Digest:        source.ResolvedDigest,
					})
				}
				return out, nil
			}))
		})

		status, body := client.call("viewer", http.MethodGet, "/api/v1/plugin-store", false, "")
		if status != http.StatusOK {
			t.Fatalf("store status = %d", status)
		}
		items, _ := body["data"].(map[string]any)["items"].([]any)
		var found map[string]any
		for _, raw := range items {
			entry, _ := raw.(map[string]any)
			if entry["packageId"] == "acme.custom" {
				found = entry
			}
		}
		if found == nil {
			t.Fatalf("store has no entry for acme.custom: %v", body["data"])
		}
		source, _ := found["source"].(map[string]any)
		if source["kind"] != "custom" || source["repository"] != "https://github.com/acme/tilecast-custom" {
			t.Fatalf("custom source = %v", source)
		}
		custom, _ := found["custom"].(map[string]any)
		if custom["version"] != "1.2.0" || custom["name"] != "Custom" || custom["digest"] != marketplaceTestDigest {
			t.Fatalf("custom detail = %v", custom)
		}
		if custom["installed"] != false {
			t.Fatalf("custom installed = %v, want false", custom["installed"])
		}
		if _, present := found["plugin"]; present {
			t.Fatal("custom entry carries a plugin detail")
		}
		if _, present := found["marketplace"]; present {
			t.Fatal("custom entry carries a marketplace detail")
		}

		status, body = client.call("viewer", http.MethodGet, "/api/v1/plugin-store/acme.custom", false, "")
		if status != http.StatusOK {
			t.Fatalf("custom entry status = %d", status)
		}
		entry, _ := body["data"].(map[string]any)
		if entry["packageId"] != "acme.custom" || entry["custom"] == nil {
			t.Fatalf("custom entry = %v", body["data"])
		}
	})
}
