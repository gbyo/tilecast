package plugins

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/apps/server/internal/durable"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/outbound"
	"github.com/tilecast/tilecast/apps/server/internal/outbound/outboundtest"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplefeeds"
)

// Feeds end to end: publication, overrides, the Data Source projection,
// Content Health, and remote images over a fake network with a stepped
// clock. No test reaches real DNS or the internet.

var feedImageAddress = netip.MustParseAddr("93.184.216.50")

type imageServer struct {
	mu      sync.Mutex
	bodies  map[string][]byte
	types   map[string]string
	fetches map[string]int
}

func (s *imageServer) set(path string, body []byte, contentType string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bodies[path], s.types[path] = body, contentType
}

func (s *imageServer) count(path string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fetches[path]
}

func (s *imageServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.fetches[r.URL.Path]++
	body, ok := s.bodies[r.URL.Path]
	contentType := s.types[r.URL.Path]
	s.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(body)
}

type feedEnvironment struct {
	installationEnvironment
	service *Service
	media   *media.Service
	clock   *steppedClock
	images  *imageServer
	board   uuid.UUID
	conn    uuid.UUID
}

func pngBytes(t *testing.T, shade uint8) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		for y := 0; y < 4; y++ {
			picture.Set(x, y, color.RGBA{shade, 10, 20, 255})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, picture); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// pngBomb is a small PNG whose header claims 20000 x 20000 pixels.
func pngBomb(t *testing.T) []byte {
	data := pngBytes(t, 1)
	binary.BigEndian.PutUint32(data[16:20], 20000)
	binary.BigEndian.PutUint32(data[20:24], 20000)
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
	return data
}

func withFeeds(t *testing.T, run func(feedEnvironment)) {
	t.Helper()
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, err := env.pool.Exec(env.ctx, `TRUNCATE plugin_feed_datasets, plugin_feed_blobs CASCADE`); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(env.ctx, `TRUNCATE plugin_secret_deks CASCADE`); err != nil {
			t.Fatal(err)
		}
		ring, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "kek.json"))
		if err != nil {
			t.Fatal(err)
		}
		storage, err := media.NewLocalStorage(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		library := media.NewService(env.pool, storage, media.Config{})
		network := outboundtest.NewNetwork(t, "images.example.com", "other.example.com")
		network.Resolver.Answer("images.example.com", feedImageAddress)
		images := &imageServer{bodies: map[string][]byte{}, types: map[string]string{}, fetches: map[string]int{}}
		network.HTTPS(feedImageAddress, images)
		engine := outbound.New(outbound.Options{Resolver: network.Resolver, Dialer: network.Dialer, RootCAs: network.Roots})
		clock := &steppedClock{now: time.Now().UTC().Truncate(time.Second)}
		service := NewService(env.pool, nil, WithPlugins(samplefeeds.New()), WithClock(clock), WithOutbound(engine),
			WithAttachments(library), WithSecrets(pluginsecrets.NewStore(env.pool, ring, nil)))
		if _, _, err := service.Install(env.ctx, samplefeeds.ID, env.userID); err != nil {
			t.Fatal(err)
		}
		if err := library.SetDataSourceProviders(service.feedProviders()...); err != nil {
			t.Fatal(err)
		}
		board, err := service.CreateInstance(env.ctx, samplefeeds.ID, "board", env.userID, instanceWrite{Name: str("Lobby board"), Configuration: map[string]any{"title": "Lobby"}})
		if err != nil {
			t.Fatal(err)
		}
		connection, err := service.CreateConnection(env.ctx, samplefeeds.ID, env.userID, ConnectionWrite{Definition: "images", Name: str("Images")})
		if err != nil {
			t.Fatal(err)
		}
		run(feedEnvironment{installationEnvironment: env, service: service, media: library, clock: clock, images: images, board: board.ID, conn: connection.ID})
	})
}

func item(id, name string, extra map[string]any) FeedRecordInput {
	values := map[string]any{"name": name}
	for key, value := range extra {
		values[key] = value
	}
	return FeedRecordInput{ID: id, Values: values}
}

func (e feedEnvironment) publish(t *testing.T, replaces int64, records ...FeedRecordInput) FeedPublished {
	t.Helper()
	published, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, FeedPublication{Feed: "items", Instance: e.board, Replaces: replaces,
		Records: records, Connections: map[string]uuid.UUID{"images": e.conn}})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	return published
}

func (e feedEnvironment) records(t *testing.T, dataset uuid.UUID) map[string]FeedRecordDocument {
	t.Helper()
	document, err := e.service.FeedRecords(e.ctx, samplefeeds.ID, dataset, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]FeedRecordDocument{}
	for _, record := range document.Items {
		out[record.ID] = record
	}
	return out
}

func (e feedEnvironment) payload(t *testing.T, dataset uuid.UUID) plugin.TypedDatasetPayload {
	t.Helper()
	var raw []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT cached_payload FROM data_source_refresh_states WHERE data_source_id=$1`, dataset).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var payload plugin.TypedDatasetPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func (e feedEnvironment) override(t *testing.T, dataset uuid.UUID, record, field string, value any) error {
	t.Helper()
	encoded, _ := json.Marshal(value)
	_, err := e.service.SetFeedOverride(e.ctx, samplefeeds.ID, dataset, record, field, encoded, e.userID)
	return err
}

func (e feedEnvironment) runImports(t *testing.T) int {
	t.Helper()
	ran, err := e.service.RunFeedImageImports(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	return ran
}

func TestFeedPublicationBoundsAndRevisions(t *testing.T) {
	withFeeds(t, func(e feedEnvironment) {
		// An empty first publication creates the dataset and its Data Source.
		empty, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, FeedPublication{Feed: "notices", Records: []FeedRecordInput{}})
		if err != nil || empty.Revision != 1 || empty.Records != 0 {
			t.Fatalf("empty = %+v %v", empty, err)
		}
		var provider, name string
		if err := e.pool.QueryRow(e.ctx, `SELECT provider,name FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, empty.Dataset).Scan(&provider, &name); err != nil ||
			provider != "sample_feeds.notices" || name != "Sample Feeds: Notices" {
			t.Fatalf("data source = %s %s %v", provider, name, err)
		}
		// The revision a publication replaces must be the current one.
		notice := func(replaces int64, text string) error {
			_, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, FeedPublication{Feed: "notices", Replaces: replaces,
				Records: []FeedRecordInput{{ID: "n1", Values: map[string]any{"text": text}}}})
			return err
		}
		var conflict *FeedConflictError
		if err := notice(0, "x"); !errors.As(err, &conflict) || conflict.Current != 1 {
			t.Fatalf("stale replaces = %v", err)
		}
		if revision, _ := e.service.FeedRevision(e.ctx, samplefeeds.ID, "notices", uuid.Nil); revision != 1 {
			t.Fatalf("revision = %d", revision)
		}
		// Two publications against revision 1: one wins, and nothing is
		// overwritten silently.
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i := range errs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				errs[i] = notice(1, fmt.Sprintf("writer %d", i))
			}(i)
		}
		wg.Wait()
		if (errs[0] == nil) == (errs[1] == nil) || (!errors.As(errs[0], &conflict) && !errors.As(errs[1], &conflict)) {
			t.Fatalf("racing publications = %v", errs)
		}
		// Record IDs: 80 characters are a record ID, 81 are not.
		current, _ := e.service.FeedRevision(e.ctx, samplefeeds.ID, "notices", uuid.Nil)
		if current != 2 {
			t.Fatalf("after the race the revision is %d", current)
		}
		long := FeedPublication{Feed: "notices", Replaces: current, Records: []FeedRecordInput{{ID: strings.Repeat("r", 80)}}}
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, long); err != nil {
			t.Fatalf("80-character ID = %v", err)
		}
		long.Replaces++
		long.Records[0].ID = strings.Repeat("r", 81)
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, long); !errors.Is(err, ErrFeedInvalid) {
			t.Fatalf("81-character ID = %v", err)
		}
		long.Records = []FeedRecordInput{{ID: "a"}, {ID: "a"}}
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, long); !errors.Is(err, ErrFeedInvalid) {
			t.Fatalf("duplicate ID = %v", err)
		}
		// 2,000 records are a publication; 2,001 are not.
		many := make([]FeedRecordInput, 2001)
		for i := range many {
			many[i] = FeedRecordInput{ID: fmt.Sprintf("r%04d", i)}
		}
		long.Records = many[:2000]
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, long); err != nil {
			t.Fatalf("2000 records = %v", err)
		}
		long.Replaces++
		long.Records = many
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, long); !errors.Is(err, ErrFeedInvalid) {
			t.Fatalf("2001 records = %v", err)
		}
		// 512 KiB counts canonical JSON: surrounding white space that the
		// schema trims does not count, the stored text does.
		text := strings.Repeat("t", 4000)
		fits := make([]FeedRecordInput, 0)
		for i := 0; i < 125; i++ {
			fits = append(fits, FeedRecordInput{ID: fmt.Sprintf("n%03d", i), Values: map[string]any{"text": "   " + text + strings.Repeat(" ", 400) + "   "}})
		}
		long.Records = fits
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, long); err != nil {
			t.Fatalf("a publication under 512 KiB once canonical = %v", err)
		}
		long.Replaces++
		for i := 0; i < 8; i++ {
			fits = append(fits, FeedRecordInput{ID: fmt.Sprintf("over%d", i), Values: map[string]any{"text": text}})
		}
		long.Records = fits
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, long); !errors.Is(err, ErrFeedTooLarge) {
			t.Fatalf("over 512 KiB = %v", err)
		}
		// Schema: unknown fields and wrong types are refused; validUntil is
		// in the future and becomes the Data Document expiry.
		bad := FeedPublication{Feed: "notices", Replaces: long.Replaces, Records: []FeedRecordInput{{ID: "x", Values: map[string]any{"color": "red"}}}}
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, bad); !errors.Is(err, ErrFeedInvalid) {
			t.Fatalf("unknown field = %v", err)
		}
		past := e.clock.Now().Add(-time.Minute)
		bad.Records, bad.ValidUntil = []FeedRecordInput{}, &past
		if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, bad); !errors.Is(err, ErrFeedInvalid) {
			t.Fatalf("validUntil in the past = %v", err)
		}
		until := e.clock.Now().Add(time.Hour)
		bad.ValidUntil = &until
		published, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, bad)
		if err != nil {
			t.Fatal(err)
		}
		payload := e.payload(t, published.Dataset)
		var expires time.Time
		_ = e.pool.QueryRow(e.ctx, `SELECT cache_expires_at FROM data_source_refresh_states WHERE data_source_id=$1`, published.Dataset).Scan(&expires)
		if payload.Datasets[0].StaleAt == nil || !payload.Datasets[0].StaleAt.Equal(until) || !expires.Equal(until) {
			t.Fatalf("validUntil = %v, expires %v", payload.Datasets[0].StaleAt, expires)
		}
	})
}

func TestFeedDatasetsBelongToTheirInstance(t *testing.T) {
	withFeeds(t, func(e feedEnvironment) {
		other, err := e.service.CreateInstance(e.ctx, samplefeeds.ID, "other", e.userID, instanceWrite{Name: str("Other"), Configuration: map[string]any{"title": "x"}})
		if err != nil {
			t.Fatal(err)
		}
		for name, publication := range map[string]FeedPublication{
			"no instance":      {Feed: "items", Records: []FeedRecordInput{}},
			"another kind":     {Feed: "items", Instance: other.ID, Records: []FeedRecordInput{}},
			"missing instance": {Feed: "items", Instance: uuid.New(), Records: []FeedRecordInput{}},
			"org with one":     {Feed: "notices", Instance: e.board, Records: []FeedRecordInput{}},
			"undeclared feed":  {Feed: "orders", Records: []FeedRecordInput{}},
		} {
			if _, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, publication); !errors.Is(err, ErrFeedInvalid) {
				t.Errorf("%s = %v", name, err)
			}
		}
		second, err := e.service.CreateInstance(e.ctx, samplefeeds.ID, "board", e.userID, instanceWrite{Name: str("Hall board"), Configuration: map[string]any{"title": "Hall"}})
		if err != nil {
			t.Fatal(err)
		}
		first := e.publish(t, 0, item("a", "Tea", nil))
		hall, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, FeedPublication{Feed: "items", Instance: second.ID, Records: []FeedRecordInput{item("b", "Coffee", nil)}})
		if err != nil || hall.Dataset == first.Dataset || hall.Revision != 1 {
			t.Fatalf("second dataset = %+v %v", hall, err)
		}
		// Plugins cannot touch another plugin's datasets.
		if _, err := e.service.FeedRecords(e.ctx, "sample_signs", first.Dataset, 0, 10); err == nil {
			t.Fatal("another plugin read the dataset")
		}
		// Deleting an instance whose dataset a Widget shows is blocked;
		// without the Widget the dataset and its Data Source go too.
		widget := uuid.New()
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)
			SELECT $1,id,'Menu widget','widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$2 FROM organization_settings WHERE singleton`, widget, e.userID); err != nil {
			t.Fatal(err)
		}
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO widgets(asset_id,provider,configuration) VALUES($1,'list',jsonb_build_object('dataSourceId',$2::text))`, widget, first.Dataset); err != nil {
			t.Fatal(err)
		}
		if err := e.service.DeleteInstance(e.ctx, samplefeeds.ID, "board", e.board, e.userID); apiCode(err) != "plugin_instance_in_use" {
			t.Fatalf("delete with a Widget = %v", err)
		}
		if _, err := e.pool.Exec(e.ctx, `DELETE FROM widgets WHERE asset_id=$1`, widget); err != nil {
			t.Fatal(err)
		}
		if err := e.service.DeleteInstance(e.ctx, samplefeeds.ID, "board", e.board, e.userID); err != nil {
			t.Fatalf("delete = %v", err)
		}
		var deleted bool
		if err := e.pool.QueryRow(e.ctx, `SELECT deleted_at IS NOT NULL FROM data_sources WHERE id=$1`, first.Dataset).Scan(&deleted); err != nil || !deleted {
			t.Fatalf("the dataset's Data Source stayed: %v", err)
		}
	})
}

func TestFeedOverridePolicies(t *testing.T) {
	withFeeds(t, func(e feedEnvironment) {
		first := e.publish(t, 0, item("a", "Tea", map[string]any{"short": "T", "price": 3, "contact": "ann@example.org"}), item("b", "Cake", nil))
		dataset := first.Dataset
		// upstream is never editable, and an image is upstream.
		for _, field := range []string{"price", "photo", "available"} {
			if err := e.override(t, dataset, "a", field, 1); apiCode(err) != "invalid_plugin_feed" {
				t.Fatalf("override %s = %v", field, err)
			}
		}
		if err := e.override(t, dataset, "missing", "short", "X"); apiCode(err) != "plugin_feed_record_not_found" {
			t.Fatalf("missing record = %v", err)
		}
		if err := e.override(t, dataset, "a", "short", strings.Repeat("x", 41)); apiCode(err) != "invalid_plugin_feed" {
			t.Fatalf("an override longer than the field = %v", err)
		}
		for _, change := range []struct {
			field string
			value any
		}{{"short", "Tea!"}, {"name", "Green tea"}, {"contact", "front desk"}} {
			if err := e.override(t, dataset, "a", change.field, change.value); err != nil {
				t.Fatalf("override %s = %v", change.field, err)
			}
		}
		records := e.records(t, dataset)
		a := records["a"]
		if a.Upstream["name"] != "Tea" || a.Overrides["name"] != "Green tea" || a.Effective["name"] != "Green tea" || a.Effective["short"] != "Tea!" {
			t.Fatalf("record a = %+v", a)
		}
		if payload := e.payload(t, dataset); payload.Datasets[0].Records[0].Values["name"] != "Green tea" {
			t.Fatalf("projection = %+v", payload.Datasets[0].Records[0])
		}
		// The same upstream again: every override survives. local survives
		// an upstream change too.
		second := e.publish(t, first.Revision, item("a", "Tea", map[string]any{"short": "Tea short", "price": 4, "contact": "ann@example.org"}), item("b", "Cake", nil))
		a = e.records(t, dataset)["a"]
		if a.Overrides["name"] != "Green tea" || a.Overrides["short"] != "Tea!" || a.Effective["price"] != "4" {
			t.Fatalf("after an unchanged upstream name = %+v", a)
		}
		// local_until_changed compares the old upstream with the new
		// upstream, never with the effective value: an upstream that now
		// equals the override still changed, so the override goes.
		third := e.publish(t, second.Revision, item("a", "Green tea", map[string]any{"short": "Tea short", "contact": "ann@example.org"}), item("b", "Cake", nil))
		a = e.records(t, dataset)["a"]
		if _, kept := a.Overrides["name"]; kept || a.Removed["name"].Reason != "upstream_changed" || a.Overrides["short"] != "Tea!" {
			t.Fatalf("after an upstream change = %+v", a)
		}
		// A record that leaves the publication takes its overrides.
		if err := e.override(t, dataset, "b", "short", "C"); err != nil {
			t.Fatal(err)
		}
		e.publish(t, third.Revision, item("a", "Green tea", map[string]any{"contact": "ann@example.org"}))
		var left int
		_ = e.pool.QueryRow(e.ctx, `SELECT count(*) FROM plugin_feed_overrides WHERE dataset_id=$1 AND record_id='b'`, dataset).Scan(&left)
		if left != 0 {
			t.Fatal("a removed record kept its override")
		}
		// The audit names plugin, feed, dataset, record, field, and reason,
		// never a value and never a personal value.
		var reasons []string
		rows, err := e.pool.Query(e.ctx, `SELECT metadata->>'reason' FROM audit_logs WHERE action='plugin.feed.override_removed' ORDER BY created_at`)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var reason string
			_ = rows.Scan(&reason)
			reasons = append(reasons, reason)
		}
		rows.Close()
		if strings.Join(reasons, ",") != "upstream_changed,record_removed" {
			t.Fatalf("audit reasons = %v", reasons)
		}
		var dump string
		_ = e.pool.QueryRow(e.ctx, `SELECT string_agg(metadata::text,'') FROM audit_logs WHERE action LIKE 'plugin.feed.%'`).Scan(&dump)
		for _, value := range []string{"Green tea", "Tea!", "front desk", "ann@example.org", "Cake"} {
			if strings.Contains(dump, value) {
				t.Fatalf("an audit row holds %q", value)
			}
		}
		if !strings.Contains(dump, `"field": "name"`) || !strings.Contains(dump, `"feed": "items@1"`) {
			t.Fatalf("audit metadata = %s", dump)
		}
		// Clearing an override goes back to upstream.
		if err := e.override(t, dataset, "a", "short", nil); err != nil {
			t.Fatal(err)
		}
		if _, kept := e.records(t, dataset)["a"].Overrides["short"]; kept {
			t.Fatal("a cleared override stayed")
		}
	})
}

func TestFeedPersonalDataRetention(t *testing.T) {
	withFeeds(t, func(e feedEnvironment) {
		first := e.publish(t, 0, item("a", "Tea", map[string]any{"contact": "ann@example.org"}))
		if err := e.override(t, first.Dataset, "a", "contact", "desk"); err != nil {
			t.Fatal(err)
		}
		e.clock.Set(e.clock.Now().Add(25 * time.Hour))
		for _, table := range []string{"plugin_feed_records", "plugin_feed_overrides"} {
			if _, err := e.pool.Exec(e.ctx, `UPDATE `+table+` SET updated_at=$1`, e.clock.Now().Add(-25*time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := e.service.purgeFeedPersonalData(e.ctx, e.clock.Now()); err != nil {
			t.Fatal(err)
		}
		a := e.records(t, first.Dataset)["a"]
		if _, kept := a.Upstream["contact"]; kept || a.Effective["contact"] != "" || a.Upstream["name"] != "Tea" {
			t.Fatalf("after retention = %+v", a)
		}
		if _, kept := a.Overrides["contact"]; kept {
			t.Fatal("retention kept a personal override")
		}
	})
}

type staticSettings struct{}

func (staticSettings) Organization(context.Context) (settings.Document, error) {
	return settings.Document{Values: map[string]any{}}, nil
}

func TestFeedIsAnOrdinaryDataSourceWithContentHealth(t *testing.T) {
	withFeeds(t, func(e feedEnvironment) {
		first := e.publish(t, 0, item("a", "Tea", map[string]any{"price": 2.5, "available": true}))
		providers, err := e.service.DataSourceProviders()
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, provider := range providers {
			ids = append(ids, provider.ProviderID())
		}
		if strings.Join(ids, ",") != "sample_feeds.items,sample_feeds.notices" {
			t.Fatalf("providers = %v", ids)
		}
		detail, err := e.media.GetDataSourceDetail(e.ctx, first.Dataset)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(detail)
		for _, want := range []string{`"provider":"sample_feeds.items"`, `"key":"price"`, `"type":"asset"`} {
			if !strings.Contains(string(encoded), want) {
				t.Fatalf("detail misses %s: %s", want, encoded)
			}
		}
		payload := e.payload(t, first.Dataset)
		dataset := payload.Datasets[0]
		if dataset.ID != "items" || dataset.Kind != "records" || len(dataset.Fields) != 7 || dataset.Records[0].Values["price"] != "2.5" ||
			dataset.Records[0].Values["available"] != "true" || dataset.Records[0].Values["photo"] != "" {
			t.Fatalf("payload = %+v", dataset)
		}
		// Generic paths refuse to edit a feed Data Source.
		if _, err := e.media.UpdateDataSource(e.ctx, first.Dataset, e.userID, media.DataSourceInput{Name: "x", Provider: "sample_feeds.items", Configuration: json.RawMessage(`{}`)}); err == nil {
			t.Fatal("the generic editor changed a feed Data Source")
		}
		// Stale after twice the expected interval while a Widget uses it.
		widget := uuid.New()
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)
			SELECT $1,id,'Menu widget','widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$2 FROM organization_settings WHERE singleton`, widget, e.userID); err != nil {
			t.Fatal(err)
		}
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO widgets(asset_id,provider,configuration) VALUES($1,'list',jsonb_build_object('dataSourceId',$2::text))`, widget, first.Dataset); err != nil {
			t.Fatal(err)
		}
		health := contenthealth.NewService(e.pool, staticSettings{})
		recorded := &recordedSink{}
		health.SetEvents(recorded)
		status := func() string {
			var state string
			err := e.pool.QueryRow(e.ctx, `SELECT status FROM incidents WHERE dedupe_key='data_source:source:'||$1::text ORDER BY opened_at DESC LIMIT 1`, first.Dataset).Scan(&state)
			if err != nil {
				return "none"
			}
			return state
		}
		if err := health.Sweep(e.ctx); err != nil || status() != "none" {
			t.Fatalf("fresh feed = %s %v", status(), err)
		}
		if _, err := e.pool.Exec(e.ctx, `UPDATE plugin_feed_datasets SET published_at=now()-interval '11 minutes' WHERE id=$1`, first.Dataset); err != nil {
			t.Fatal(err)
		}
		if err := health.Sweep(e.ctx); err != nil || status() != "open" {
			t.Fatalf("late feed = %s %v", status(), err)
		}
		// Crossing into stale is one feed.stale@1 for the owner and one
		// incident.opened@1; staying stale is nothing more.
		if err := health.Sweep(e.ctx); err != nil {
			t.Fatal(err)
		}
		stale := recorded.named(plugin.CoreFeedStale)
		if len(stale) != 1 || stale[0].Owner != samplefeeds.ID || stale[0].Payload.(coreevents.FeedStale).DatasetID != first.Dataset ||
			len(recorded.named(plugin.CoreIncidentOpened)) != 1 {
			t.Fatalf("stale events = %+v", recorded.events)
		}
		var code string
		_ = e.pool.QueryRow(e.ctx, `SELECT failure_code FROM incidents WHERE dedupe_key='data_source:source:'||$1::text`, first.Dataset).Scan(&code)
		e.clock.Set(time.Now().UTC())
		e.publish(t, first.Revision, item("a", "Tea", nil))
		if err := health.Sweep(e.ctx); err != nil || status() != "recovered" || code != "feed_stale" {
			t.Fatalf("after a publication = %s %s %v", status(), code, err)
		}
		if recovered := recorded.named(plugin.CoreIncidentRecovered); len(recovered) != 1 {
			t.Fatalf("recovered events = %d", len(recovered))
		}
		listed, err := e.service.ListFeedDatasets(e.ctx, samplefeeds.ID)
		if err != nil || len(listed) != 1 || listed[0].WidgetsUsing != 1 || listed[0].Stale {
			t.Fatalf("list = %+v %v", listed, err)
		}
	})
}

func TestFeedImagesImportAfterCommit(t *testing.T) {
	withFeeds(t, func(e feedEnvironment) {
		tea, cake := pngBytes(t, 10), pngBytes(t, 200)
		e.images.set("/tea.png", tea, "image/png")
		e.images.set("/tea-copy.png", tea, "image/png")
		e.images.set("/cake.png", cake, "image/png")
		first := e.publish(t, 0,
			item("a", "Tea", map[string]any{"photo": "https://images.example.com/tea.png"}),
			item("b", "Tea again", map[string]any{"photo": "https://images.example.com/tea-copy.png"}),
			item("c", "Cake", map[string]any{"photo": "https://images.example.com/cake.png"}))
		if first.ImagesQueued != 3 || e.images.count("/tea.png") != 0 {
			t.Fatalf("the publication fetched: %+v %d", first, e.images.count("/tea.png"))
		}
		if e.records(t, first.Dataset)["a"].Effective["photo"] != "" {
			t.Fatal("an image appeared before its import")
		}
		if ran := e.runImports(t); ran != 3 {
			t.Fatalf("imports ran %d", ran)
		}
		records := e.records(t, first.Dataset)
		teaAsset, copyAsset, cakeAsset := records["a"].Effective["photo"], records["b"].Effective["photo"], records["c"].Effective["photo"]
		if teaAsset == "" || teaAsset != copyAsset || cakeAsset == "" || cakeAsset == teaAsset {
			t.Fatalf("assets = %s %s %s", teaAsset, copyAsset, cakeAsset)
		}
		if payload := e.payload(t, first.Dataset); payload.Datasets[0].Records[0].Values["photo"] != teaAsset {
			t.Fatal("the projection lacks the imported image")
		}
		// One asset for each plugin and SHA-256, never across plugins.
		var blobs int
		_ = e.pool.QueryRow(e.ctx, `SELECT count(*) FROM plugin_feed_blobs WHERE plugin_id=$1`, samplefeeds.ID).Scan(&blobs)
		other, code, _ := e.service.storeFeedImage(e.ctx, "other_plugin", tea)
		if blobs != 2 || code != "" || other.String() == teaAsset {
			t.Fatalf("dedupe: blobs %d, other plugin %s %s", blobs, other, code)
		}
		// A private plugin asset is never a Media library item.
		asset := uuid.MustParse(teaAsset)
		if _, err := e.media.GetAsset(e.ctx, asset); !errors.Is(err, media.ErrNotFound) {
			t.Fatalf("library read = %v", err)
		}
		listing, err := e.media.ListAssets(e.ctx, media.ListOptions{Page: 1, PageSize: 100})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range listing.Items {
			if item.ID == asset {
				t.Fatal("the Media library lists a feed image")
			}
		}
		// A Player is granted the asset only while a record names it.
		var variant uuid.UUID
		// The media pipeline inspects and finishes the asset.
		for _, state := range []string{"inspecting", "processing", "ready"} {
			if _, err := e.pool.Exec(e.ctx, `UPDATE assets SET processing_status=$2 WHERE id=$1`, asset, state); err != nil {
				t.Fatal(err)
			}
		}
		if err := e.pool.QueryRow(e.ctx, `SELECT id FROM asset_variants WHERE asset_id=$1 AND kind='original'`, asset).Scan(&variant); err != nil {
			t.Fatal(err)
		}
		if _, err := e.pool.Exec(e.ctx, `UPDATE asset_variants SET player_compatible=TRUE WHERE id=$1`, variant); err != nil {
			t.Fatal(err)
		}
		if _, err := e.media.Delivery(e.ctx, asset, variant); err != nil {
			t.Fatalf("delivery while referenced = %v", err)
		}
		// The upstream drops the tea image: the reference and the grant go,
		// and the asset is discarded 24 hours later.
		second := e.publish(t, first.Revision, item("a", "Tea", nil), item("b", "Tea again", nil),
			item("c", "Cake", map[string]any{"photo": "https://images.example.com/cake.png"}))
		if second.ImagesQueued != 0 || e.records(t, first.Dataset)["a"].Effective["photo"] != "" {
			t.Fatalf("after removal = %+v", second)
		}
		if _, err := e.media.Delivery(e.ctx, asset, variant); !errors.Is(err, media.ErrVariantUnavailable) {
			t.Fatalf("delivery after removal = %v", err)
		}
		if discarded, err := e.service.CollectFeedAssets(e.ctx); err != nil || discarded != 0 {
			t.Fatalf("first collection = %d %v", discarded, err)
		}
		e.clock.Set(e.clock.Now().Add(23 * time.Hour))
		if discarded, _ := e.service.CollectFeedAssets(e.ctx); discarded != 0 {
			t.Fatal("an image was discarded before 24 hours")
		}
		e.clock.Set(e.clock.Now().Add(2 * time.Hour))
		// The tea image, and the unused copy stored for another plugin above.
		if discarded, err := e.service.CollectFeedAssets(e.ctx); err != nil || discarded != 2 {
			t.Fatalf("collection after 24 hours = %d %v", discarded, err)
		}
		var gone bool
		_ = e.pool.QueryRow(e.ctx, `SELECT deleted_at IS NOT NULL FROM assets WHERE id=$1`, asset).Scan(&gone)
		if !gone {
			t.Fatal("the discarded asset is not deleted")
		}
		// An orphaned image that a record names again before 24 hours stays.
		third := e.publish(t, second.Revision, item("c", "Cake", nil))
		cakeID := uuid.MustParse(cakeAsset)
		e.service.CollectFeedAssets(e.ctx) //nolint:errcheck
		e.clock.Set(e.clock.Now().Add(time.Hour))
		e.publish(t, third.Revision, item("c", "Cake", map[string]any{"photo": "https://images.example.com/cake.png"}))
		e.runImports(t)
		e.clock.Set(e.clock.Now().Add(30 * time.Hour))
		if discarded, _ := e.service.CollectFeedAssets(e.ctx); discarded != 0 {
			t.Fatal("a re-referenced image was discarded")
		}
		if got := e.records(t, first.Dataset)["c"].Effective["photo"]; got != cakeID.String() {
			t.Fatalf("re-referenced asset = %s, want %s", got, cakeID)
		}
	})
}

func TestFeedImageFailuresAndStaleImports(t *testing.T) {
	withFeeds(t, func(e feedEnvironment) {
		huge := bytes.Repeat([]byte{0}, feedImageMaxBytes+1)
		copy(huge, pngBytes(t, 3))
		e.images.set("/huge.png", huge, "image/png")
		e.images.set("/text.png", []byte("not an image at all, only words"), "image/png")
		e.images.set("/bomb.png", pngBomb(t), "image/png")
		e.images.set("/fine.png", pngBytes(t, 50), "image/png")
		lan, err := e.service.CreateConnection(e.ctx, samplefeeds.ID, e.userID, ConnectionWrite{Definition: "lan_images", Name: str("LAN"), Origin: str("http://nas.lan")})
		if err != nil {
			t.Fatal(err)
		}
		published, err := e.service.PublishFeed(e.ctx, samplefeeds.ID, FeedPublication{Feed: "items", Instance: e.board,
			Connections: map[string]uuid.UUID{"images": e.conn, "lan_images": lan.ID},
			Records: []FeedRecordInput{
				item("http", "Plain", map[string]any{"photo": "http://images.example.com/fine.png"}),
				item("lan", "Plain LAN", map[string]any{"lanPhoto": "http://nas.lan/fine.png"}),
				item("origin", "Other origin", map[string]any{"photo": "https://other.example.com/fine.png"}),
				item("huge", "Huge", map[string]any{"photo": "https://images.example.com/huge.png"}),
				item("text", "Text", map[string]any{"photo": "https://images.example.com/text.png"}),
				item("bomb", "Bomb", map[string]any{"photo": "https://images.example.com/bomb.png"}),
				item("missing", "Missing", map[string]any{"photo": "https://images.example.com/missing.png"}),
			}})
		if err != nil {
			t.Fatal(err)
		}
		e.runImports(t)
		want := map[string]string{"http": ImageHTTPRefused, "lan": ImageHTTPRefused, "origin": ImageFetchFailed, "huge": ImageTooLarge,
			"text": ImageInvalid, "bomb": ImageTooLarge, "missing": ImageFetchFailed}
		records := e.records(t, published.Dataset)
		for id, code := range want {
			field := "photo"
			if id == "lan" {
				field = "lanPhoto"
			}
			if records[id].ImageFailures[field] != code || records[id].Effective[field] != "" {
				t.Errorf("%s: failure %q effective %q, want %s", id, records[id].ImageFailures[field], records[id].Effective[field], code)
			}
		}
		// The failure is an attention item; the publication itself held.
		catalog, err := e.service.CatalogItem(e.ctx, samplefeeds.ID)
		if err != nil || len(catalog.Attention) != 1 || catalog.Attention[0].Code != "feed_image_import_failed" {
			t.Fatalf("attention = %+v %v", catalog.Attention, err)
		}
		var dump string
		_ = e.pool.QueryRow(e.ctx, `SELECT coalesce(string_agg(code,''),'') FROM plugin_feed_image_failures`).Scan(&dump)
		if strings.Contains(dump, "example.com") {
			t.Fatal("a failure holds a URL")
		}
		// A stale import attaches nothing: revision 1 asked for fine.png,
		// revision 2 asks for another image before the first import ends.
		first := e.publish(t, published.Revision, item("x", "X", map[string]any{"photo": "https://images.example.com/fine.png"}))
		claims, err := imageQueue.Claim(e.ctx, e.pool, e.clock.Now(), feedImageLease, 10, durable.Filter{})
		if err != nil || len(claims) != 1 {
			t.Fatalf("claim = %v %v", claims, err)
		}
		job := imageJob{claim: claims[0]}
		if err := e.pool.QueryRow(e.ctx, `SELECT i.dataset_id,d.plugin_id,d.feed_id,i.revision,i.record_id,i.field_key,i.url,i.connection_id
			FROM plugin_feed_image_imports i JOIN plugin_feed_datasets d ON d.id=i.dataset_id WHERE i.id=$1`, claims[0].ID).
			Scan(&job.datasetID, &job.pluginID, &job.feedID, &job.revision, &job.recordID, &job.field, &job.address, &job.connection); err != nil {
			t.Fatal(err)
		}
		e.images.set("/newer.png", pngBytes(t, 90), "image/png")
		e.publish(t, first.Revision, item("x", "X", map[string]any{"photo": "https://images.example.com/newer.png"}))
		if err := e.service.importFeedImage(e.ctx, job); err != nil {
			t.Fatal(err)
		}
		if got := e.records(t, published.Dataset)["x"].Effective["photo"]; got != "" {
			t.Fatalf("a stale import attached %s", got)
		}
		e.runImports(t)
		var source string
		if err := e.pool.QueryRow(e.ctx, `SELECT source_url FROM plugin_feed_assets WHERE dataset_id=$1 AND record_id='x'`, published.Dataset).Scan(&source); err != nil ||
			source != "https://images.example.com/newer.png" {
			t.Fatalf("the newer revision's image = %s %v", source, err)
		}
	})
}

// recordedSink is a core event sink that keeps what producers emit.
type recordedSink struct {
	mu     sync.Mutex
	events []coreevents.Event
}

func (r *recordedSink) Emit(_ context.Context, _ pgx.Tx, event coreevents.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
	return nil
}

func (r *recordedSink) named(name string) []coreevents.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []coreevents.Event{}
	for _, event := range r.events {
		if event.Name == name {
			out = append(out, event)
		}
	}
	return out
}
