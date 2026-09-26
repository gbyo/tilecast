// Package sampleplugin is a test-only plugin that implements every Plugin API
// v1 contribution point. It is never bundled with a release: the host's
// tests load it to prove that a plugin nobody special-cased works through
// the generic paths alone. Its state lives in memory, so it needs no tables;
// installation, audit, and manifest revisions go through the real host.
package sampleplugin

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ID is the sample plugin's identifier.
const ID = "sample_tally"

const manifest = `{
  "apiVersion": 1,
  "id": "sample_tally",
  "definitionVersion": 2,
  "name": "Sample Tally",
  "description": "A test plugin that counts items and shows them on screens.",
  "category": "Display",
  "icon": "hash",
  "maintainers": ["@gbyo", "@someone-without-access"],
  "instanceNoun": { "singular": "item", "plural": "items" },
  "uses": ["Player manifest plugin state"],
  "capabilities": {
    "playerManifest": true,
    "backgroundWorkers": true,
    "heartbeat": ["sampleTally"]
  },
  "server": { "entrypoint": "./plugin.go" },
  "api": { "basePaths": ["/plugins/sample-tally"], "openapi": "./api/openapi.yaml" },
  "studio": { "route": "/plugins/sample-tally", "entrypoint": "./studio/index.tsx" },
  "runtime": { "entrypoint": "./runtime/index.ts", "manifestTypes": ["sample_tally"], "surfaces": ["corner.top-left"], "tier": "ambient" },
  "docs": { "reference": "packages/plugin-sdk/go/plugintest/sampleplugin" }
}`

// Item is one tally item.
type Item struct {
	ID    uuid.UUID `json:"id"`
	Label string    `json:"label"`
	// AssetID is an optional image the item draws on screens.
	AssetID *uuid.UUID `json:"assetId,omitempty"`
}

// Config is the Player manifest projection of an item.
type Config struct {
	Label     string     `json:"label"`
	AssetID   *uuid.UUID `json:"assetId,omitempty"`
	VariantID *uuid.UUID `json:"variantId,omitempty"`
}

// ResolveAssets implements plugin.AssetResolver: an item whose image is
// unavailable is dropped.
func (c *Config) ResolveAssets(ctx context.Context, assets plugin.Assets) (bool, error) {
	if c.AssetID == nil {
		return true, nil
	}
	image, ok, err := assets.Image(ctx, *c.AssetID)
	if err != nil || !ok {
		return false, err
	}
	c.VariantID = &image.VariantID
	return true, nil
}

// Plugin is the sample plugin. Its counters are exported for assertions.
type Plugin struct {
	plugin.Bundle
	host plugin.Host

	mu    sync.Mutex
	items map[uuid.UUID]Item

	WorkerRuns      atomic.Int32
	MaintenanceRuns atomic.Int32
	Heartbeats      atomic.Int32
}

var (
	_ plugin.Initializer         = (*Plugin)(nil)
	_ plugin.StatusReporter      = (*Plugin)(nil)
	_ plugin.RemovalGuard        = (*Plugin)(nil)
	_ plugin.RouteProvider       = (*Plugin)(nil)
	_ plugin.ManifestProjector   = (*Plugin)(nil)
	_ plugin.AssetDependent      = (*Plugin)(nil)
	_ plugin.WorkerProvider      = (*Plugin)(nil)
	_ plugin.MaintenanceProvider = (*Plugin)(nil)
	_ plugin.HeartbeatConsumer   = (*Plugin)(nil)
)

func New() *Plugin {
	return &Plugin{Bundle: plugin.NewBundle([]byte(manifest), nil), items: map[uuid.UUID]Item{}}
}

func (p *Plugin) Init(_ context.Context, host plugin.Host) error {
	p.host = host
	return nil
}

// Seed adds items directly, as data left in a database would be, without the
// installation check or a manifest revision.
func (p *Plugin) Seed(labels ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, label := range labels {
		id := uuid.New()
		p.items[id] = Item{ID: id, Label: label}
	}
}

// Items returns the items in a stable order.
func (p *Plugin) Items() []Item {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Item, 0, len(p.items))
	for _, item := range p.items {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID.String() < out[j].ID.String() })
	return out
}

func (p *Plugin) Status(context.Context) (plugin.Status, error) {
	count := len(p.Items())
	status := plugin.Status{Configured: count > 0, Active: count > 0, InstanceCount: count}
	if count > 3 {
		status.Attention = append(status.Attention, plugin.Attention{Code: "too_many_items", Message: "More than three items are hard to read."})
	}
	return status, nil
}

func (p *Plugin) RemovalBlockers(context.Context, pgx.Tx) ([]plugin.Blocker, error) {
	return []plugin.Blocker{
		{Kind: "sample_item", Count: len(p.Items()), Singular: "item", Plural: "items", Resolution: plugin.ResolveDelete},
	}, nil
}

func (p *Plugin) Routes(router plugin.Router) {
	router.Handle(http.MethodGet, "/plugins/sample-tally/items", plugin.AccessViewer, p.list)
	router.Handle(http.MethodPost, "/plugins/sample-tally/items", plugin.AccessManager, p.create)
	router.Handle(http.MethodDelete, "/plugins/sample-tally/items/{id}", plugin.AccessManager, p.delete)
	router.Handle(http.MethodGet, "/plugins/sample-tally/whoami", plugin.AccessSession, p.whoami)
}

func (p *Plugin) list(w http.ResponseWriter, _ *http.Request) error {
	items := p.Items()
	plugin.WriteData(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
	return nil
}

func (p *Plugin) create(w http.ResponseWriter, r *http.Request) error {
	var input struct {
		Label   string     `json:"label"`
		AssetID *uuid.UUID `json:"assetId,omitempty"`
	}
	if err := plugin.DecodeJSON(w, r, &input); err != nil {
		return err
	}
	if input.Label == "" {
		return plugin.Invalidf("label is required")
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	item := Item{ID: uuid.New(), Label: input.Label, AssetID: input.AssetID}
	after, err := p.write(r.Context(), principal.UserID, "plugin.sample_tally.created", item.ID, func() {
		p.items[item.ID] = item
	})
	if err != nil {
		return err
	}
	after()
	plugin.WriteData(w, http.StatusCreated, item)
	return nil
}

func (p *Plugin) delete(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	p.mu.Lock()
	_, found := p.items[id]
	p.mu.Unlock()
	if !found {
		return plugin.ErrNotFound
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	after, err := p.write(r.Context(), principal.UserID, "plugin.sample_tally.deleted", id, func() {
		delete(p.items, id)
	})
	if err != nil {
		return err
	}
	after()
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (p *Plugin) whoami(w http.ResponseWriter, r *http.Request) error {
	principal, ok := plugin.PrincipalFrom(r.Context())
	if !ok {
		return &plugin.APIError{Status: http.StatusInternalServerError, Code: "no_principal", Message: "No principal."}
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"role": principal.Role, "canManage": principal.CanManage()})
	return nil
}

// write follows the SDK's write pattern: lock the installation, audit, and
// invalidate manifests in one transaction, then notify after commit. Deletes
// skip the installation lock so leftover data can always be cleaned up.
func (p *Plugin) write(ctx context.Context, userID uuid.UUID, action string, id uuid.UUID, apply func()) (plugin.AfterCommit, error) {
	tx, err := p.host.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if action != "plugin.sample_tally.deleted" {
		if err = p.host.Installation.LockInTx(ctx, tx); err != nil {
			return nil, err
		}
	}
	if err = p.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{
		UserID: userID, Action: action, ResourceType: "plugin", ResourceID: id.String(),
	}); err != nil {
		return nil, err
	}
	after, err := p.host.Manifests.InvalidateResourceInTx(ctx, tx, id, action)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	p.mu.Lock()
	apply()
	p.mu.Unlock()
	return after, nil
}

func (p *Plugin) ProjectManifest(context.Context, uuid.UUID) ([]plugin.ManifestEntry, error) {
	entries := []plugin.ManifestEntry{}
	for _, item := range p.Items() {
		entries = append(entries, plugin.ManifestEntry{ID: item.ID, Type: "sample_tally", Version: 1,
			Config: &Config{Label: item.Label, AssetID: item.AssetID}})
	}
	return entries, nil
}

func (p *Plugin) ScreensUsingAsset(ctx context.Context, tx pgx.Tx, assetID uuid.UUID) ([]uuid.UUID, error) {
	for _, item := range p.Items() {
		if item.AssetID != nil && *item.AssetID == assetID {
			rows, err := tx.Query(ctx, `SELECT id FROM screens WHERE archived_at IS NULL`)
			if err != nil {
				return nil, err
			}
			return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		}
	}
	return nil, nil
}

func (p *Plugin) Workers() []plugin.Worker {
	return []plugin.Worker{{Name: "tally", Run: func(ctx context.Context) error {
		p.WorkerRuns.Add(1)
		<-ctx.Done()
		return ctx.Err()
	}}}
}

func (p *Plugin) Maintenance() []plugin.MaintenanceTask {
	return []plugin.MaintenanceTask{{Name: "compact", Run: func(context.Context) (int64, error) {
		p.MaintenanceRuns.Add(1)
		return 0, nil
	}}}
}

func (p *Plugin) HeartbeatSections() []plugin.HeartbeatSection {
	return []plugin.HeartbeatSection{{Name: "sampleTally", Handle: func(_ context.Context, _ uuid.UUID, raw json.RawMessage) (map[string]any, error) {
		var report struct {
			Seen int `json:"seen"`
		}
		if err := json.Unmarshal(raw, &report); err != nil {
			return nil, err
		}
		p.Heartbeats.Add(1)
		return map[string]any{"sampleTally": map[string]any{"acknowledged": report.Seen}}, nil
	}}}
}
