package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/outbound"
	"github.com/tilecast/tilecast/apps/server/internal/outbound/outboundtest"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleconnections"
)

// http.fetch@1 end to end: the dispatcher, the plugin host's connection
// records and consents, the secret store, and the outbound engine over a
// fake network. No test reaches real DNS or the internet.

const fetchToken = "tok-5ecret-value-91f2"

// studioRequestContext is a request context as httpapi builds it: every
// audited change names its calling surface.
func studioRequestContext() context.Context {
	return audit.WithSurface(context.Background(), audit.SurfaceStudio)
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type fetchFixture struct {
	*serviceFixture
	plugins *plugins.Service
	network *outboundtest.Network
	logs    *lockedBuffer
	secrets *pluginsecrets.Store
}

var (
	apiAddress     = netip.MustParseAddr("93.184.216.34")
	filesAddress   = netip.MustParseAddr("93.184.216.35")
	gatewayAddress = netip.MustParseAddr("192.168.40.10")
	nasAddress     = netip.MustParseAddr("10.9.8.7")
)

func newFetchFixture(t *testing.T) *fetchFixture {
	t.Helper()
	f := newServiceFixture(t)
	ring, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(context.Background(), `TRUNCATE plugin_secret_deks CASCADE`); err != nil {
		t.Fatal(err)
	}
	secrets := pluginsecrets.NewStore(f.pool, ring, nil)
	network := outboundtest.NewNetwork(t, "api.example.com", "files.example.com", "example.com", "nas.lan")
	logs := &lockedBuffer{}
	engine := outbound.New(outbound.Options{Resolver: network.Resolver, Dialer: network.Dialer, RootCAs: network.Roots})
	service := plugins.NewService(f.pool, nil, plugins.WithPlugins(sampleconnections.New()), plugins.WithSecrets(secrets),
		plugins.WithOutbound(engine), plugins.WithLogger(slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))))
	f.dispatcher.deps.Plugins = service
	service.SetServiceCaller(f.dispatcher)
	if _, _, err := service.Install(context.Background(), sampleconnections.ID, f.ownerID); err != nil {
		t.Fatal(err)
	}
	return &fetchFixture{serviceFixture: f, plugins: service, network: network, logs: logs, secrets: secrets}
}

func (f *fetchFixture) fetch(t *testing.T, request map[string]any) (httpFetchOutput, *CallError) {
	t.Helper()
	input, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	data, denial, failure := f.dispatcher.Call(context.Background(), Call{PluginID: sampleconnections.ID, Context: ContextBackground,
		Grants: bundledGrants("http.fetch"), Operation: "http.fetch@1/request", Input: input})
	if denial != nil {
		t.Fatalf("denied: %+v", denial)
	}
	if failure != nil {
		return httpFetchOutput{}, failure
	}
	return data.(httpFetchOutput), nil
}

func (f *fetchFixture) connection(t *testing.T, definition string, origin *string) plugins.ConnectionDocument {
	t.Helper()
	name := definition
	document, err := f.plugins.CreateConnection(studioRequestContext(), sampleconnections.ID, f.ownerID, plugins.ConnectionWrite{Definition: definition, Name: &name, Origin: origin})
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func (f *fetchFixture) consent(t *testing.T, document plugins.ConnectionDocument, private, plain, plaintext bool) plugins.ConnectionDocument {
	t.Helper()
	revision := document.Revision
	out, err := f.plugins.SetConsents(studioRequestContext(), sampleconnections.ID, document.ID, f.ownerID, plugins.ConsentWrite{
		PrivateNetwork: private, PlainHTTP: plain, PlaintextSecret: plaintext, ExpectedRevision: &revision})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func expectFetchCode(t *testing.T, failure *CallError, code string) {
	t.Helper()
	if failure == nil || failure.Code != code {
		t.Fatalf("failure = %+v, want %s", failure, code)
	}
}

func textPointer(value string) *string { return &value }

type headerRecorder struct {
	mu      sync.Mutex
	headers []http.Header
}

func (r *headerRecorder) handler(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.headers = append(r.headers, req.Header.Clone())
		r.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "session=1")
		_, _ = io.WriteString(w, body)
	}
}

func (r *headerRecorder) last() http.Header {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.headers[len(r.headers)-1]
}

func TestHTTPFetchThroughAFixedConnectionWithASecretHeader(t *testing.T) {
	f := newFetchFixture(t)
	ctx := studioRequestContext()
	api := f.connection(t, "api", nil)
	revision := int64(0)
	if _, err := f.plugins.UpdateSettings(ctx, sampleconnections.ID, "organization", uuid.Nil, f.ownerID, plugins.SettingsWrite{
		Values: map[string]any{"primary": api.ID.String()}, Secrets: map[string]string{"apiToken": fetchToken}, ExpectedRevision: &revision}); err != nil {
		t.Fatal(err)
	}
	recorder := &headerRecorder{}
	f.network.Resolver.Answer("api.example.com", apiAddress)
	f.network.HTTPS(apiAddress, recorder.handler(`{"items":[1,2]}`))

	// Two approved origins: a path alone does not say which.
	_, failure := f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "/v1/items?page=2"})
	expectFetchCode(t, failure, outbound.CodeRequestInvalid)

	output, failure := f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/v1/items?page=2&key=query-detail",
		"headers": []any{
			map[string]any{"name": "Accept", "value": "application/json"},
			map[string]any{"name": "Authorization", "secret": map[string]any{"scope": "organization", "key": "apiToken", "prefix": "Bearer "}},
		}})
	if failure != nil {
		t.Fatal(failure)
	}
	if output.Status != 200 || string(output.Body) != `{"items":[1,2]}` || output.Headers["Content-Type"][0] != "application/json" {
		t.Fatalf("output = %+v", output)
	}
	if _, cookie := output.Headers["Set-Cookie"]; cookie {
		t.Fatal("Set-Cookie reached plugin code")
	}
	if got := recorder.last().Get("Authorization"); got != "Bearer "+fetchToken {
		t.Fatalf("Authorization = %q", got)
	}
	encoded, _ := json.Marshal(output)
	if strings.Contains(string(encoded), fetchToken) {
		t.Fatal("the answer holds the secret")
	}
	// A secret that is not set answers a stable code.
	_, failure = f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/",
		"headers": []any{map[string]any{"name": "X-Key", "secret": map[string]any{"scope": "instance", "ownerId": uuid.New(), "key": "gatewayKey"}}}})
	expectFetchCode(t, failure, plugins.ErrCodeSecretUnavailable)
	// A field that is not a secret, or does not exist, is no secret either.
	_, failure = f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/",
		"headers": []any{map[string]any{"name": "X-Key", "secret": map[string]any{"scope": "organization", "key": "primary"}}}})
	expectFetchCode(t, failure, plugins.ErrCodeSecretUnavailable)
	// Another plugin's secret never resolves, even with its exact owner.
	otherInstance := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO plugin_instances(id,organization_id,plugin_id,kind,name) VALUES($1,$2,'sample_signs','sign','Other')`, otherInstance, serviceOrgID(t, f.pool)); err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return f.secrets.WriteInTx(ctx, tx, pluginsecrets.SecretRef{PluginID: "sample_signs", OwnerType: "instance", OwnerID: otherInstance, Key: "gatewayKey"}, "other-plugin-secret", nil)
	}); err != nil {
		t.Fatal(err)
	}
	_, failure = f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/",
		"headers": []any{map[string]any{"name": "X-Key", "secret": map[string]any{"scope": "instance", "ownerId": otherInstance, "key": "gatewayKey"}}}})
	expectFetchCode(t, failure, plugins.ErrCodeSecretUnavailable)
	// A format holds one secret and bounded text around it.
	_, failure = f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/",
		"headers": []any{map[string]any{"name": "Authorization", "secret": map[string]any{"scope": "organization", "key": "apiToken", "prefix": "{secret} "}}}})
	expectFetchCode(t, failure, outbound.CodeRequestInvalid)
	_, failure = f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/",
		"headers": []any{map[string]any{"name": "Authorization", "value": "x", "secret": map[string]any{"scope": "organization", "key": "apiToken"}}}})
	expectFetchCode(t, failure, outbound.CodeRequestInvalid)
	// An origin the connection does not declare.
	_, failure = f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://example.com/"})
	expectFetchCode(t, failure, outbound.CodeOriginNotAllowed)
	// Refused request headers.
	_, failure = f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/",
		"headers": []any{map[string]any{"name": "Cookie", "value": "a=b"}}})
	expectFetchCode(t, failure, outbound.CodeRequestInvalid)

	// No secret, path, or query detail in a log, an audit event, or a row.
	logs := f.logs.String()
	for _, leaked := range []string{fetchToken, "/v1/items", "query-detail", "Bearer"} {
		if strings.Contains(logs, leaked) {
			t.Fatalf("the log holds %q:\n%s", leaked, logs)
		}
	}
	if !strings.Contains(logs, `"origin":"https://api.example.com"`) || !strings.Contains(logs, `"failure":"origin_not_allowed"`) {
		t.Fatalf("the log lacks diagnostics:\n%s", logs)
	}
	var stored string
	if err := f.pool.QueryRow(ctx, `SELECT coalesce(string_agg(metadata::text,''),'') FROM audit_logs`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var rows string
	if err := f.pool.QueryRow(ctx, `SELECT coalesce(string_agg(row_to_json(c)::text,''),'') FROM plugin_connections c`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, fetchToken) || strings.Contains(rows, fetchToken) {
		t.Fatal("the secret reached the audit log or a connection row")
	}
}

func TestHTTPFetchConnectionBelongsToThePlugin(t *testing.T) {
	f := newFetchFixture(t)
	other := uuid.New()
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO plugin_connections(id,organization_id,plugin_id,definition_id,name) VALUES($1,$2,'sample_signs','api','Other')`, other, serviceOrgID(t, f.pool)); err != nil {
		t.Fatal(err)
	}
	f.network.Resolver.Answer("api.example.com", apiAddress)
	f.network.HTTPS(apiAddress, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	for _, id := range []uuid.UUID{other, uuid.New()} {
		_, failure := f.fetch(t, map[string]any{"connection": id, "method": "GET", "url": "https://api.example.com/"})
		expectFetchCode(t, failure, outbound.CodeConnectionUnavailable)
	}
	if dials := f.network.Dialer.Dials(); len(dials) != 0 {
		t.Fatalf("dialed for an unavailable connection: %v", dials)
	}
}

func TestHTTPFetchLocalPlainHTTPNeedsEveryConsent(t *testing.T) {
	f := newFetchFixture(t)
	ctx := studioRequestContext()
	lan := f.connection(t, "lan", textPointer("http://gateway.lan:8080"))
	strict := f.connection(t, "lan_strict", textPointer("http://strict.lan"))
	recorder := &headerRecorder{}
	f.network.Resolver.Answer("gateway.lan", gatewayAddress)
	f.network.Resolver.Answer("strict.lan", gatewayAddress)
	f.network.HTTP(gatewayAddress, recorder.handler("ok"))
	// The instance row and its secret, written the way the host stores them.
	instanceID := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO plugin_instances(id,organization_id,plugin_id,kind,name,configuration) VALUES($1,$2,$3,'source','Lobby',$4)`,
		instanceID, serviceOrgID(t, f.pool), sampleconnections.ID, `{"title":"Lobby","gateway":"`+lan.ID.String()+`"}`); err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return f.secrets.WriteInTx(ctx, tx, pluginsecrets.SecretRef{PluginID: sampleconnections.ID, OwnerType: "instance", OwnerID: instanceID, Key: "gatewayKey"}, fetchToken, nil)
	}); err != nil {
		t.Fatal(err)
	}
	instance := struct{ ID uuid.UUID }{instanceID}
	request := func(connection uuid.UUID, secret bool) map[string]any {
		out := map[string]any{"connection": connection, "method": "GET", "url": "/status"}
		if secret {
			out["headers"] = []any{map[string]any{"name": "X-Key", "secret": map[string]any{"scope": "instance", "ownerId": instance.ID, "key": "gatewayKey"}}}
		}
		return out
	}
	_, failure := f.fetch(t, request(lan.ID, false))
	expectFetchCode(t, failure, outbound.CodePlainHTTPRefused)
	lan = f.consent(t, lan, true, false, false)
	_, failure = f.fetch(t, request(lan.ID, false))
	expectFetchCode(t, failure, outbound.CodePlainHTTPRefused)
	lan = f.consent(t, lan, true, true, false)
	if output, failure := f.fetch(t, request(lan.ID, false)); failure != nil || string(output.Body) != "ok" {
		t.Fatalf("%+v %+v", output, failure)
	}
	// Plain HTTP consent does not cover a secret.
	_, failure = f.fetch(t, request(lan.ID, true))
	expectFetchCode(t, failure, outbound.CodePlaintextSecretRefused)
	lan = f.consent(t, lan, true, true, true)
	if _, failure := f.fetch(t, request(lan.ID, true)); failure != nil {
		t.Fatal(failure)
	}
	if recorder.last().Get("X-Key") != fetchToken {
		t.Fatal("the gateway did not receive the key")
	}
	// A declaration without allowPlaintextSecret never sends one.
	strict = f.consent(t, strict, true, true, false)
	if _, failure := f.fetch(t, request(strict.ID, false)); failure != nil {
		t.Fatal(failure)
	}
	_, failure = f.fetch(t, request(strict.ID, true))
	expectFetchCode(t, failure, outbound.CodePlaintextSecretRefused)
	// A public answer is refused for plain HTTP even with every consent.
	f.network.Resolver.Answer("gateway.lan", apiAddress)
	_, failure = f.fetch(t, request(lan.ID, false))
	expectFetchCode(t, failure, outbound.CodePlainHTTPRefused)
	// A new origin clears the consents.
	revision := lan.Revision
	lan, err := f.plugins.UpdateConnection(ctx, sampleconnections.ID, lan.ID, f.ownerID, plugins.ConnectionWrite{Name: textPointer("Gateway"), Origin: textPointer("http://strict.lan"), ExpectedRevision: &revision})
	if err != nil {
		t.Fatal(err)
	}
	_, failure = f.fetch(t, request(lan.ID, false))
	expectFetchCode(t, failure, outbound.CodePlainHTTPRefused)
	if strings.Contains(f.logs.String(), fetchToken) {
		t.Fatal("the log holds the secret")
	}
}

func TestHTTPFetchPrivateHTTPSNeedsConsent(t *testing.T) {
	f := newFetchFixture(t)
	nas := f.connection(t, "private_https", textPointer("https://nas.lan"))
	f.network.Resolver.Answer("nas.lan", nasAddress)
	f.network.HTTPS(nasAddress, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "nas") }))
	_, failure := f.fetch(t, map[string]any{"connection": nas.ID, "method": "GET", "url": "/"})
	expectFetchCode(t, failure, outbound.CodePrivateNetworkRefused)
	nas = f.consent(t, nas, true, false, false)
	if output, failure := f.fetch(t, map[string]any{"connection": nas.ID, "method": "GET", "url": "/"}); failure != nil || string(output.Body) != "nas" {
		t.Fatalf("%+v %+v", output, failure)
	}
}

func TestHTTPFetchResponseLimitsAndEncoding(t *testing.T) {
	f := newFetchFixture(t)
	api := f.connection(t, "api", nil)
	large := f.connection(t, "large", nil)
	f.network.Resolver.Answer("api.example.com", apiAddress)
	f.network.Resolver.Answer("example.com", filesAddress)
	f.network.HTTPS(apiAddress, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		size := plugin.DefaultMaxResponseBytes
		if req.URL.Path == "/over" {
			size++
		}
		_, _ = w.Write(bytes.Repeat([]byte("a"), size))
	}))
	f.network.HTTPS(filesAddress, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		if len(body) != 1<<20 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write(bytes.Repeat([]byte("b"), plugin.MaxMaxResponseBytes))
	}))
	if output, failure := f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/exact"}); failure != nil || len(output.Body) != plugin.DefaultMaxResponseBytes {
		t.Fatalf("exact default limit: %v", failure)
	}
	_, failure := f.fetch(t, map[string]any{"connection": api.ID, "method": "GET", "url": "https://api.example.com/over"})
	expectFetchCode(t, failure, outbound.CodeResponseTooLarge)
	// A 16 MiB answer to a 1 MiB body fits the operation's transport bound.
	input, _ := json.Marshal(map[string]any{"connection": large.ID, "method": "POST", "url": "/export", "body": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("c"), 1<<20))})
	encoded, err := f.dispatcher.CallBundled(context.Background(), plugins.BundledCall{PluginID: sampleconnections.ID, Context: ContextBackground,
		Grants: bundledGrants("http.fetch"), Operation: "http.fetch@1/request", Input: input})
	if err != nil {
		t.Fatal(err)
	}
	var decoded httpFetchOutput
	if err := json.Unmarshal(encoded, &decoded); err != nil || decoded.Status != 200 || len(decoded.Body) != plugin.MaxMaxResponseBytes {
		t.Fatalf("large answer: status %d, %d bytes, %v", decoded.Status, len(decoded.Body), err)
	}
	if len(encoded) > HTTPFetchMaxOutputBytes {
		t.Fatalf("encoded answer %d exceeds the bound", len(encoded))
	}
	// One byte over 1 MiB of body is refused before any request.
	before := len(f.network.Dialer.Dials())
	input, _ = json.Marshal(map[string]any{"connection": large.ID, "method": "POST", "url": "/export", "body": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("c"), 1<<20+1))})
	_, _, failure = f.dispatcher.Call(context.Background(), Call{PluginID: sampleconnections.ID, Context: ContextBackground,
		Grants: bundledGrants("http.fetch"), Operation: "http.fetch@1/request", Input: input})
	expectFetchCode(t, failure, outbound.CodeRequestInvalid)
	if len(f.network.Dialer.Dials()) != before {
		t.Fatal("an oversized body reached the network")
	}
}
