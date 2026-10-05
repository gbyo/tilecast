package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Two synthetic Data Source providers exercise the discrimination through
// the same generic paths a real plugin uses: declaration checks at hosting,
// provider discovery at startup, and the bound Host.DataSources service for
// every row operation. Nothing here names a real plugin, and no core code
// names these synthetics.

// syntheticManifest is the smallest manifest the API accepts, parameterized
// by plugin identity.
func syntheticManifest(id, name string) []byte {
	return []byte(fmt.Sprintf(`{
  "apiVersion": 1,
  "id": %q,
  "definitionVersion": 1,
  "name": %q,
  "description": "A synthetic conformance provider.",
  "category": "Workflow",
  "icon": "puzzle",
  "maintainers": ["@tilecast-test"],
  "instanceNoun": { "singular": "item", "plural": "items" }
}`, id, name))
}

// syntheticProvider contributes one Data Source provider. Canonical routes
// stay empty, so no Studio declaration is required; the provider is still
// subject to ID shape, catalog, uniqueness, and static-collision checks.
type syntheticProvider struct {
	plugin.Bundle
	providerID string
	host       plugin.Host
}

func newSyntheticProvider(manifestID, providerID string) *syntheticProvider {
	return &syntheticProvider{
		Bundle:     plugin.NewBundle(syntheticManifest(manifestID, manifestID), nil),
		providerID: providerID,
	}
}

func (p *syntheticProvider) Init(_ context.Context, host plugin.Host) error {
	p.host = host
	return nil
}

var (
	_ plugin.Plugin             = (*syntheticProvider)(nil)
	_ plugin.Initializer        = (*syntheticProvider)(nil)
	_ plugin.DataSourceProvider = (*syntheticProvider)(nil)
	_ plugin.Plugin             = (*syntheticPlain)(nil)
	_ plugin.Initializer        = (*syntheticPlain)(nil)
)

func (p *syntheticProvider) ProviderID() string { return p.providerID }

func (p *syntheticProvider) Traits() plugin.DataSourceTraits {
	return plugin.DataSourceTraits{RecordBased: true, ProducesFields: true}
}

func (p *syntheticProvider) FieldsFromConfig(_ json.RawMessage) []plugin.DataSourceField {
	return nil
}

func (p *syntheticProvider) ManagedExternally() bool { return true }

func (p *syntheticProvider) HiddenFromGallery() bool { return true }

func (p *syntheticProvider) Catalog() (string, string, string) {
	return "Synthetic", "Testing", "A synthetic conformance provider."
}

func (p *syntheticProvider) CanonicalEditor() string { return "" }

func (p *syntheticProvider) CanonicalCreator() string { return "" }

func (p *syntheticProvider) NormalizeConfiguration(input json.RawMessage) (json.RawMessage, error) {
	if len(input) == 0 {
		return json.RawMessage(`{}`), nil
	}
	return input, nil
}

func (p *syntheticProvider) ExternalMessage(_ string) string {
	return "unknown synthetic action"
}

// syntheticPlain contributes no Data Source provider. Its Host.DataSources
// service must refuse every provider-scoped call.
type syntheticPlain struct {
	plugin.Bundle
	host plugin.Host
}

func newSyntheticPlain(manifestID string) *syntheticPlain {
	return &syntheticPlain{Bundle: plugin.NewBundle(syntheticManifest(manifestID, manifestID), nil)}
}

func (p *syntheticPlain) Init(_ context.Context, host plugin.Host) error {
	p.host = host
	return nil
}

func TestDataSourceProvidersDiscovery(t *testing.T) {
	beta := newSyntheticProvider("synthetic_beta", "beta")
	alpha := newSyntheticProvider("synthetic_alpha", "alpha")
	service := NewService(nil, nil, WithPlugins(beta, alpha))

	providers, err := service.DataSourceProviders()
	if err != nil {
		t.Fatalf("DataSourceProviders() = %v", err)
	}
	if len(providers) != 2 || providers[0].ProviderID() != "alpha" || providers[1].ProviderID() != "beta" {
		ids := []string{}
		for _, provider := range providers {
			ids = append(ids, provider.ProviderID())
		}
		t.Fatalf("providers in deterministic order = %v", ids)
	}
}

func TestDataSourceProvidersRejectDuplicates(t *testing.T) {
	service := NewService(nil, nil, WithPlugins(
		newSyntheticProvider("synthetic_one", "same"),
		newSyntheticProvider("synthetic_two", "same"),
	))
	if _, err := service.DataSourceProviders(); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate providers = %v, want a duplicate error", err)
	}
}

func TestDataSourceProvidersRejectMalformed(t *testing.T) {
	// A malformed provider ID fails hosting loudly through the declaration
	// checks, before discovery ever runs. DataSourceProviders repeats the
	// shape check as defense-in-depth for any provider hosted without them.
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("malformed provider hosted without failing")
		}
		if message, ok := recovered.(error); !ok || !strings.Contains(message.Error(), "malformed") {
			t.Fatalf("malformed provider panic = %v, want a malformed error", recovered)
		}
	}()
	NewService(nil, nil, WithPlugins(
		newSyntheticProvider("synthetic_bad", "Bad Provider!"),
	))
}

func TestDataSourceProvidersRejectStaticCollisions(t *testing.T) {
	service := NewService(nil, nil, WithPlugins(
		newSyntheticProvider("synthetic_collision", "cap_alerts"),
	))
	if _, err := service.DataSourceProviders(); err == nil || !strings.Contains(err.Error(), "collides") {
		t.Fatalf("colliding provider = %v, want a collision error", err)
	}
}

func TestBoundDataSourcesDiscriminate(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		alpha := newSyntheticProvider("synthetic_alpha", "alpha")
		gamma := newSyntheticProvider("synthetic_gamma", "gamma")
		plain := newSyntheticPlain("synthetic_plain")
		service := NewService(env.pool, nil, WithPlugins(alpha, gamma, plain))

		alphaHost, ok := service.Host("synthetic_alpha")
		if !ok {
			t.Fatal("alpha host not found")
		}
		gammaHost, ok := service.Host("synthetic_gamma")
		if !ok {
			t.Fatal("gamma host not found")
		}
		plainHost, ok := service.Host("synthetic_plain")
		if !ok {
			t.Fatal("plain host not found")
		}

		tx, err := env.pool.Begin(env.ctx)
		if err != nil {
			t.Fatal(err)
		}

		// The host stamps the bound provider: the create input carries no
		// provider identity of its own.
		created, err := alphaHost.DataSources.CreateInTx(env.ctx, tx, plugin.DataSourceCreate{
			Name: "Alpha", CreatedBy: env.userID, Configuration: json.RawMessage(`{}`),
		})
		if err != nil {
			_ = tx.Rollback(env.ctx)
			t.Fatalf("alpha create = %v", err)
		}
		if created.Provider != "alpha" {
			_ = tx.Rollback(env.ctx)
			t.Fatalf("created provider = %q, want alpha", created.Provider)
		}
		// Commit before reading back: the pool reads through a separate
		// connection that cannot see this transaction's rows.
		if err := tx.Commit(env.ctx); err != nil {
			t.Fatal(err)
		}

		// Another provider's rows read as absent through the generic paths.
		if _, err := gammaHost.DataSources.Get(env.ctx, created.ID); !errors.Is(err, plugin.ErrNotFound) {
			t.Fatalf("gamma get of alpha row = %v, want ErrNotFound", err)
		}
		live, err := gammaHost.DataSources.ListLive(env.ctx)
		if err != nil || len(live) != 0 {
			t.Fatalf("gamma list = %v, %v, want empty", live, err)
		}
		countTx, err := env.pool.Begin(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer countTx.Rollback(env.ctx) //nolint:errcheck
		if count, err := gammaHost.DataSources.CountLiveInTx(env.ctx, countTx); err != nil || count != 0 {
			t.Fatalf("gamma count = %d, %v, want zero", count, err)
		}

		// The owner's own rows stay fully visible.
		if _, err := alphaHost.DataSources.Get(env.ctx, created.ID); err != nil {
			t.Fatalf("alpha get of own row = %v", err)
		}
		if count, err := alphaHost.DataSources.CountLive(env.ctx); err != nil || count != 1 {
			t.Fatalf("alpha count = %d, %v, want one", count, err)
		}

		// A plugin that contributes no provider cannot use the service at
		// all: every provider-scoped call is refused, never silently scoped
		// to someone else's rows.
		if _, err := plainHost.DataSources.CreateInTx(env.ctx, tx, plugin.DataSourceCreate{Name: "Plain"}); err == nil ||
			!strings.Contains(err.Error(), "does not contribute") {
			t.Fatalf("plain create = %v, want a refusal", err)
		}
		if _, err := plainHost.DataSources.Get(env.ctx, created.ID); err == nil ||
			!strings.Contains(err.Error(), "does not contribute") {
			t.Fatalf("plain get = %v, want a refusal", err)
		}
		if _, err := plainHost.DataSources.ListLive(env.ctx); err == nil ||
			!strings.Contains(err.Error(), "does not contribute") {
			t.Fatalf("plain list = %v, want a refusal", err)
		}
		claimTx, err := env.pool.Begin(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer claimTx.Rollback(env.ctx) //nolint:errcheck
		if _, err := plainHost.DataSources.ClaimDueInTx(env.ctx, claimTx, 10); err == nil ||
			!strings.Contains(err.Error(), "does not contribute") {
			t.Fatalf("plain claim = %v, want a refusal", err)
		}
		if _, err := plainHost.DataSources.CountLive(env.ctx); err == nil ||
			!strings.Contains(err.Error(), "does not contribute") {
			t.Fatalf("plain count = %v, want a refusal", err)
		}
	})
}

func TestBoundPluginAssetsDiscriminate(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		alpha := newSyntheticProvider("synthetic_alpha", "alpha")
		gamma := newSyntheticProvider("synthetic_gamma", "gamma")
		service := NewService(env.pool, nil, WithPlugins(alpha, gamma))

		alphaHost, ok := service.Host("synthetic_alpha")
		if !ok {
			t.Fatal("alpha host not found")
		}
		gammaHost, ok := service.Host("synthetic_gamma")
		if !ok {
			t.Fatal("gamma host not found")
		}

		insertAsset := func(origin string, owner *string) uuid.UUID {
			t.Helper()
			id := uuid.New()
			if _, err := env.pool.Exec(env.ctx, `INSERT INTO assets
				(id,organization_id,name,type,original_filename,declared_mime_type,detected_mime_type,sha256,original_size,processing_status,origin,owning_plugin)
				VALUES($1,$2,'asset','image','asset.png','image/png','image/png','00',1,'ready',$3,$4)`,
				id, env.orgID, origin, owner); err != nil {
				t.Fatal(err)
			}
			return id
		}
		alphaAsset := insertAsset("form_attachment", &[]string{"synthetic_alpha"}[0])
		otherAsset := insertAsset("form_attachment", &[]string{"synthetic_gamma"}[0])
		libraryAsset := insertAsset("library", nil)

		tx, err := env.pool.Begin(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(env.ctx) //nolint:errcheck

		// A plugin claims its own private assets through the generic path.
		if err := alphaHost.PluginAssets.ClaimPrivateInTx(env.ctx, tx, alphaAsset); err != nil {
			t.Fatalf("alpha claim of own asset = %v", err)
		}
		// Another plugin's private assets are refused, and library assets
		// are never claimable as private attachments.
		if err := alphaHost.PluginAssets.ClaimPrivateInTx(env.ctx, tx, otherAsset); err == nil ||
			!errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("alpha claim of gamma asset = %v, want ErrInvalid", err)
		}
		if err := alphaHost.PluginAssets.ClaimPrivateInTx(env.ctx, tx, libraryAsset); err == nil ||
			!errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("alpha claim of library asset = %v, want ErrInvalid", err)
		}
		// The owner reads its own claim back.
		if err := gammaHost.PluginAssets.ClaimPrivateInTx(env.ctx, tx, otherAsset); err != nil {
			t.Fatalf("gamma claim of own asset = %v", err)
		}
	})
}
