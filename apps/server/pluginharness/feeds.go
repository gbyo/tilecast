package pluginharness

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/outbound"
	"github.com/tilecast/tilecast/apps/server/internal/outbound/outboundtest"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// Helpers for plugins that use host connections, OAuth, timers, and feeds.
// A plugin module cannot import the Server's internal packages, so the
// harness carries the fake network, the clock, and the host calls a test
// needs. No harness test reaches real DNS or the internet.

// FakeNetwork resolves chosen host names to local HTTPS test servers with
// certificates for those names.
type FakeNetwork struct {
	t       testing.TB
	network *outboundtest.Network
	next    byte
}

// NewFakeNetwork builds a fake network whose test certificate names hosts.
func NewFakeNetwork(t testing.TB, hosts ...string) *FakeNetwork {
	return &FakeNetwork{t: t, network: outboundtest.NewNetwork(t, hosts...), next: 10}
}

// Serve routes one host name to handler over HTTPS, on a public test
// address.
func (f *FakeNetwork) Serve(host string, handler http.Handler) {
	address := netip.AddrFrom4([4]byte{93, 184, 217, f.next})
	f.next++
	f.network.Resolver.Answer(host, address)
	f.network.HTTPS(address, handler)
}

func (f *FakeNetwork) engine() *outbound.Engine {
	return outbound.New(outbound.Options{Resolver: f.network.Resolver, Dialer: f.network.Dialer, RootCAs: f.network.Roots})
}

// Network routes the plugin's outbound requests through the fake network.
func Network(f *FakeNetwork) Option {
	return func(o *options) { o.outbound = f.engine() }
}

// SteppedClock is a clock a test moves by hand.
type SteppedClock struct {
	mu  sync.Mutex
	now time.Time
}

// NewClock starts a clock at at.
func NewClock(at time.Time) *SteppedClock { return &SteppedClock{now: at} }

// Now returns the clock's time.
func (c *SteppedClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance moves the clock.
func (c *SteppedClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// CreateConnection creates a connection record as the Owner and returns
// its ID. clientID and clientSecret apply to an oauth2 declaration.
func (h *Harness) CreateConnection(definition, name, clientID, clientSecret string) uuid.UUID {
	h.t.Helper()
	write := plugins.ConnectionWrite{Definition: definition, Name: &name}
	if clientID != "" {
		write.ClientID = &clientID
	}
	if clientSecret != "" {
		write.ClientSecret = &clientSecret
	}
	document, err := h.service.CreateConnection(h.Ctx, h.id, h.OwnerID, write)
	if err != nil {
		h.t.Fatalf("create connection %s: %v", definition, err)
	}
	return document.ID
}

// ConnectOAuth runs the OAuth sign-in of a connection as the Owner.
// authorize plays the browser at the provider: it receives the
// authorization URL and returns the code the provider issued.
func (h *Harness) ConnectOAuth(connection uuid.UUID, authorize func(authorizationURL *url.URL) string) error {
	h.t.Helper()
	authorization, err := h.service.StartOAuth(h.Ctx, h.id, connection, h.OwnerID)
	if err != nil {
		return err
	}
	parsed, err := url.Parse(authorization)
	if err != nil {
		return err
	}
	code := authorize(parsed)
	document, err := h.service.CompleteOAuth(h.Ctx, h.id, connection, h.OwnerID,
		plugins.OAuthCallback{State: parsed.Query().Get("state"), Code: code})
	if err != nil {
		return err
	}
	if document.OAuth == nil || document.OAuth.Status != plugins.OAuthConnected {
		return errors.New("the connection is not connected")
	}
	return nil
}

// RunTimers delivers the due timers and reports how many ran.
func (h *Harness) RunTimers() int {
	h.t.Helper()
	ran, err := h.service.RunDueTimers(h.Ctx)
	if err != nil {
		h.t.Fatal(err)
	}
	return ran
}

// RunImageImports runs the due feed image imports.
func (h *Harness) RunImageImports() int {
	h.t.Helper()
	ran, err := h.service.RunFeedImageImports(h.Ctx)
	if err != nil {
		h.t.Fatal(err)
	}
	return ran
}

// CollectFeedAssets runs the feed image discard rule.
func (h *Harness) CollectFeedAssets() int {
	h.t.Helper()
	discarded, err := h.service.CollectFeedAssets(h.Ctx)
	if err != nil {
		h.t.Fatal(err)
	}
	return discarded
}

// FeedDataset is one dataset as a test reads it.
type FeedDataset = plugins.FeedDatasetDocument

// FeedRecord is one record with upstream, override, and effective values.
type FeedRecord = plugins.FeedRecordDocument

// FeedDatasets lists the plugin's feed datasets.
func (h *Harness) FeedDatasets() []FeedDataset {
	h.t.Helper()
	items, err := h.service.ListFeedDatasets(h.Ctx, h.id)
	if err != nil {
		h.t.Fatal(err)
	}
	return items
}

// FeedRecords reads the records of one dataset by record ID.
func (h *Harness) FeedRecords(dataset uuid.UUID) map[string]FeedRecord {
	h.t.Helper()
	document, err := h.service.FeedRecords(h.Ctx, h.id, dataset, 0, 200)
	if err != nil {
		h.t.Fatal(err)
	}
	out := map[string]FeedRecord{}
	for _, record := range document.Items {
		out[record.ID] = record
	}
	return out
}

// SetFeedOverride sets or, with nil, clears an operator override as the
// Owner.
func (h *Harness) SetFeedOverride(dataset uuid.UUID, record, field string, value any) error {
	encoded, _ := json.Marshal(value)
	_, err := h.service.SetFeedOverride(h.Ctx, h.id, dataset, record, field, encoded, h.OwnerID)
	return err
}

// KV reads one storage.kv@1 value of the plugin, or nil.
func (h *Harness) KV(key string) []byte {
	var value []byte
	_ = h.Pool.QueryRow(h.Ctx, `SELECT value FROM plugin_kv WHERE plugin_id=$1 AND key=$2`, h.id, key).Scan(&value)
	return value
}

// DataSourcePayload reads the cached payload a Data Source projects to
// Players.
func (h *Harness) DataSourcePayload(dataSource uuid.UUID) []byte {
	h.t.Helper()
	var raw []byte
	if err := h.Pool.QueryRow(h.Ctx, `SELECT cached_payload FROM data_source_refresh_states WHERE data_source_id=$1`, dataSource).Scan(&raw); err != nil {
		h.t.Fatal(err)
	}
	return raw
}
