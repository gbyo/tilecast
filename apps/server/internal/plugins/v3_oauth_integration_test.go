package plugins

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/outbound"
	"github.com/tilecast/tilecast/apps/server/internal/outbound/outboundtest"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleconnections"
)

// OAuth 2.0 connections end to end: the host's authorization code flow with
// PKCE, the token store, refresh, and revocation against a mock provider on
// a fake network. No test reaches real DNS or the internet, and the clock is
// a stepped clock.

const (
	oauthPublicURL    = "https://signs.example.org"
	oauthClientID     = "tilecast+client:1"
	oauthClientSecret = "s3cr:et&=value"
)

var (
	oauthAPIAddress  = netip.MustParseAddr("93.184.216.34")
	oauthAuthAddress = netip.MustParseAddr("93.184.216.40")
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// tokenRequestRecord is one request the mock token endpoint received.
type tokenRequestRecord struct {
	path          string
	contentType   string
	authorization string
	values        map[string]string
}

// oauthProvider is a mock authorization server and API. It checks PKCE the
// way a provider does: the verifier of the exchange must hash to the
// challenge of the authorization request that issued the code.
type oauthProvider struct {
	mu         sync.Mutex
	challenges map[string]string
	redirects  map[string]string
	requests   []tokenRequestRecord
	revocation []tokenRequestRecord
	apiAuth    []string
	issued     int
	// refresh answers a refresh grant; nil issues new tokens and rotates
	// the refresh token.
	refresh func(values map[string]string) (int, string)
	// revokeStatus is the revocation endpoint's status.
	revokeStatus int
	// refreshGate, when set, holds each refresh until it is closed.
	refreshGate chan struct{}
}

func newOAuthProvider() *oauthProvider {
	return &oauthProvider{challenges: map[string]string{}, redirects: map[string]string{}, revokeStatus: http.StatusOK}
}

func (p *oauthProvider) issueCode(challenge, redirect string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	code := "code-" + uuid.NewString()
	p.challenges[code] = challenge
	p.redirects[code] = redirect
	return code
}

func (p *oauthProvider) tokens(refresh bool) string {
	p.mu.Lock()
	p.issued++
	n := p.issued
	p.mu.Unlock()
	document := map[string]any{"access_token": fmt.Sprintf("at-%d-0a8f", n), "token_type": "Bearer", "expires_in": 3600}
	if refresh {
		document["refresh_token"] = fmt.Sprintf("rt-%d-77c1", n)
	}
	body, _ := json.Marshal(document)
	return string(body)
}

func readValues(r *http.Request) map[string]string {
	out := map[string]string{}
	body, _ := io.ReadAll(r.Body)
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		_ = json.Unmarshal(body, &out)
		return out
	}
	values, _ := url.ParseQuery(string(body))
	for key := range values {
		out[key] = values.Get(key)
	}
	return out
}

func (p *oauthProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	values := readValues(r)
	record := tokenRequestRecord{path: r.URL.Path, contentType: r.Header.Get("Content-Type"), authorization: r.Header.Get("Authorization"), values: values}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/revoke" {
		p.mu.Lock()
		p.revocation = append(p.revocation, record)
		status := p.revokeStatus
		p.mu.Unlock()
		w.WriteHeader(status)
		return
	}
	p.mu.Lock()
	p.requests = append(p.requests, record)
	refresh, gate := p.refresh, p.refreshGate
	p.mu.Unlock()
	switch values["grant_type"] {
	case "authorization_code":
		p.mu.Lock()
		challenge, ok := p.challenges[values["code"]]
		redirect := p.redirects[values["code"]]
		delete(p.challenges, values["code"])
		p.mu.Unlock()
		sum := sha256.Sum256([]byte(values["code_verifier"]))
		if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge || values["redirect_uri"] != redirect {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		_, _ = io.WriteString(w, p.tokens(true))
	case "refresh_token":
		if gate != nil {
			<-gate
		}
		if refresh != nil {
			status, body := refresh(values)
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
			return
		}
		_, _ = io.WriteString(w, p.tokens(true))
	default:
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"unsupported_grant_type"}`)
	}
}

func (p *oauthProvider) grants(kind string) []tokenRequestRecord {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []tokenRequestRecord
	for _, request := range p.requests {
		if request.values["grant_type"] == kind {
			out = append(out, request)
		}
	}
	return out
}

func (p *oauthProvider) revocations() []tokenRequestRecord {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]tokenRequestRecord(nil), p.revocation...)
}

func (p *oauthProvider) apiAuthorizations() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.apiAuth...)
}

type oauthEnvironment struct {
	installationEnvironment
	service  *Service
	options  []Option
	clock    *steppedClock
	provider *oauthProvider
	network  *outboundtest.Network
	secrets  *pluginsecrets.Store
	logs     *syncBuffer
}

func withOAuth(t *testing.T, publicURL string, run func(oauthEnvironment)) {
	t.Helper()
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, err := env.pool.Exec(env.ctx, `TRUNCATE plugin_secret_deks CASCADE`); err != nil {
			t.Fatal(err)
		}
		ring, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "kek.json"))
		if err != nil {
			t.Fatal(err)
		}
		provider := newOAuthProvider()
		network := outboundtest.NewNetwork(t, "api.example.com", "auth.example.com")
		network.Resolver.Answer("auth.example.com", oauthAuthAddress)
		network.Resolver.Answer("api.example.com", oauthAPIAddress)
		network.HTTPS(oauthAuthAddress, provider)
		network.HTTPS(oauthAPIAddress, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			provider.mu.Lock()
			provider.apiAuth = append(provider.apiAuth, r.Header.Get("Authorization"))
			provider.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"events":[]}`)
		}))
		clock := &steppedClock{now: time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)}
		logs := &syncBuffer{}
		secrets := pluginsecrets.NewStore(env.pool, ring, nil)
		engine := outbound.New(outbound.Options{Resolver: network.Resolver, Dialer: network.Dialer, RootCAs: network.Roots})
		options := []Option{WithPlugins(sampleconnections.New()), WithSecrets(secrets), WithOutbound(engine), WithClock(clock),
			WithPublicURL(publicURL), WithLogger(slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))}
		service := NewService(env.pool, nil, options...)
		if _, _, err := service.Install(env.ctx, sampleconnections.ID, env.userID); err != nil {
			t.Fatal(err)
		}
		run(oauthEnvironment{installationEnvironment: env, service: service, options: options, clock: clock, provider: provider,
			network: network, secrets: secrets, logs: logs})
	})
}

// restarted is a second Server process over the same database.
func (e oauthEnvironment) restarted() *Service { return NewService(e.pool, nil, e.options...) }

func (e oauthEnvironment) connection(t *testing.T, definition string, write ConnectionWrite) ConnectionDocument {
	t.Helper()
	write.Definition = definition
	if write.Name == nil {
		write.Name = str(definition)
	}
	document, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, write)
	if err != nil {
		t.Fatalf("create %s: %v", definition, err)
	}
	return document
}

func (e oauthEnvironment) calendar(t *testing.T) ConnectionDocument {
	return e.connection(t, "calendar", ConnectionWrite{ClientID: str(oauthClientID), ClientSecret: str(oauthClientSecret)})
}

// authorize starts an attempt and plays the operator's browser at the
// provider: it returns the state and a code the provider issued for the
// attempt's PKCE challenge.
func (e oauthEnvironment) authorize(t *testing.T, service *Service, id uuid.UUID) (string, string) {
	t.Helper()
	authorization, err := service.StartOAuth(e.ctx, sampleconnections.ID, id, e.userID)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	parsed, err := url.Parse(authorization)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("code_challenge_method") != "S256" || len(query.Get("code_challenge")) != 43 {
		t.Fatalf("PKCE parameters = %v", query)
	}
	return query.Get("state"), e.provider.issueCode(query.Get("code_challenge"), query.Get("redirect_uri"))
}

func (e oauthEnvironment) connect(t *testing.T, id uuid.UUID) ConnectionDocument {
	t.Helper()
	state, code := e.authorize(t, e.service, id)
	document, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, id, e.userID, OAuthCallback{State: state, Code: code})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if document.OAuth == nil || document.OAuth.Status != OAuthConnected || document.Status != ConnectionReady {
		t.Fatalf("connected document = %+v", document)
	}
	return document
}

func (e oauthEnvironment) fetch(t *testing.T, id uuid.UUID, headers ...ConnectionHeader) (ConnectionResponse, error) {
	t.Helper()
	return e.service.FetchThroughConnection(e.ctx, sampleconnections.ID, ConnectionRequest{Connection: id, Method: http.MethodGet, URL: "/calendar/v3/events", Headers: headers})
}

func oauthReason(err error) string {
	var explicit *plugin.APIError
	if errors.As(err, &explicit) {
		if reason, ok := explicit.Details["reason"].(string); ok {
			return explicit.Code + ":" + reason
		}
	}
	return apiCode(err)
}

func fetchCode(err error) string {
	if failure, ok := err.(*FetchFailure); ok {
		return failure.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func (e oauthEnvironment) secretCount(t *testing.T, id uuid.UUID, key string) int {
	t.Helper()
	var count int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM plugin_secrets WHERE owner_type='connection' AND owner_id=$1 AND setting_key=$2`, id, key).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestOAuthConnectNeedsHTTPSPublicURLAndAClient(t *testing.T) {
	for _, publicURL := range []string{"", "http://signs.example.org", "https://", "https://user@signs.example.org"} {
		t.Run(publicURL, func(t *testing.T) {
			withOAuth(t, publicURL, func(e oauthEnvironment) {
				document := e.calendar(t)
				if document.OAuth.ConnectAvailable || document.OAuth.ConnectBlocker != ConnectNeedsHTTPSPublicURL || document.OAuth.CallbackURL != "" {
					t.Fatalf("oauth = %+v", document.OAuth)
				}
				if _, err := e.service.StartOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID); oauthReason(err) != "plugin_connection_oauth_unavailable:"+ConnectNeedsHTTPSPublicURL {
					t.Fatalf("start = %v", err)
				}
			})
		})
	}
	withOAuth(t, oauthPublicURL+"/", func(e oauthEnvironment) {
		document := e.connection(t, "calendar", ConnectionWrite{})
		want := oauthPublicURL + "/api/v1/plugins/sample_connections/connections/" + document.ID.String() + "/callback"
		if document.OAuth.CallbackURL != want || document.OAuth.ConnectBlocker != ConnectNeedsClientID || document.Status != ReasonOAuthClientRequired {
			t.Fatalf("no client = %+v %s", document.OAuth, document.Status)
		}
		document, err := e.service.UpdateConnection(e.ctx, sampleconnections.ID, document.ID, e.userID, ConnectionWrite{Name: str("calendar"), ClientID: str(oauthClientID), ExpectedRevision: revisionOf(document.Revision)})
		if err != nil || document.OAuth.ConnectBlocker != ConnectNeedsClientSecret || document.OAuth.ClientSecret != pluginsecrets.StateNotSet {
			t.Fatalf("no secret = %+v %v", document.OAuth, err)
		}
		document, err = e.service.UpdateConnection(e.ctx, sampleconnections.ID, document.ID, e.userID, ConnectionWrite{Name: str("calendar"), ClientSecret: str(oauthClientSecret), ExpectedRevision: revisionOf(document.Revision)})
		if err != nil || !document.OAuth.ConnectAvailable || document.OAuth.ClientSecret != pluginsecrets.StateSet || document.Status != ReasonOAuthNotConnected {
			t.Fatalf("ready to connect = %+v %s %v", document.OAuth, document.Status, err)
		}
		if *document.OAuth.ClientID != oauthClientID || strings.Join(document.OAuth.Scopes, " ") != "calendar.read offline" {
			t.Fatalf("client = %+v", document.OAuth)
		}
		// A public client takes no secret; an HTTP connection takes no client.
		public := e.connection(t, "calendar_public", ConnectionWrite{ClientID: str("public")})
		if !public.OAuth.ConnectAvailable || public.OAuth.ClientSecretRequired {
			t.Fatalf("public = %+v", public.OAuth)
		}
		if _, err := e.service.UpdateConnection(e.ctx, sampleconnections.ID, public.ID, e.userID, ConnectionWrite{Name: str("p"), ClientSecret: str("x"), ExpectedRevision: revisionOf(public.Revision)}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("secret on a public client: %v", err)
		}
		if _, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: "api", Name: str("api"), ClientID: str("x")}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("client on an HTTP connection: %v", err)
		}
	})
}

func TestOAuthAuthorizationCodeFlowWithPKCE(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		authorization, err := e.service.StartOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID)
		if err != nil {
			t.Fatal(err)
		}
		parsed, _ := url.Parse(authorization)
		query := parsed.Query()
		if parsed.Scheme+"://"+parsed.Host+parsed.Path != "https://auth.example.com/authorize" || query.Get("response_type") != "code" ||
			query.Get("client_id") != oauthClientID || query.Get("redirect_uri") != document.OAuth.CallbackURL ||
			query.Get("scope") != "calendar.read offline" || query.Get("access_type") != "offline" || query.Get("prompt") != "consent" ||
			query.Get("code_challenge_method") != "S256" || len(query.Get("state")) != 43 {
			t.Fatalf("authorization URL = %s", authorization)
		}
		// A second start replaces the first attempt with a new random state.
		state, code := e.authorize(t, e.service, document.ID)
		if state == query.Get("state") {
			t.Fatal("the state repeated")
		}
		if _, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: query.Get("state"), Code: code}); oauthReason(err) != "plugin_oauth_failed:invalid_state" {
			t.Fatalf("replaced attempt = %v", err)
		}
		connected, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: code})
		if err != nil || connected.OAuth.Status != OAuthConnected || connected.OAuth.ConnectedBy == nil || *connected.OAuth.ConnectedBy != e.userID ||
			connected.OAuth.AccessExpiresAt == nil || !connected.OAuth.AccessExpiresAt.Equal(e.clock.Now().Add(time.Hour)) {
			t.Fatalf("connected = %+v %v", connected.OAuth, err)
		}
		exchanges := e.provider.grants("authorization_code")
		if len(exchanges) != 1 {
			t.Fatalf("exchanges = %d", len(exchanges))
		}
		exchange := exchanges[0]
		// client_secret_basic form-encodes each value before Base64 (RFC 6749
		// section 2.3.1), and the body carries neither credential.
		raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(exchange.authorization, "Basic "))
		if err != nil || string(raw) != "tilecast%2Bclient%3A1:s3cr%3Aet%26%3Dvalue" {
			t.Fatalf("basic credentials = %q %v", raw, err)
		}
		if exchange.values["client_secret"] != "" || exchange.values["client_id"] != "" || exchange.contentType != "application/x-www-form-urlencoded" ||
			exchange.values["redirect_uri"] != document.OAuth.CallbackURL || len(exchange.values["code_verifier"]) != 43 {
			t.Fatalf("exchange = %+v", exchange)
		}
		// The state is single use.
		if _, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: code}); oauthReason(err) != "plugin_oauth_failed:invalid_state" {
			t.Fatalf("replay = %v", err)
		}
		if e.secretCount(t, document.ID, oauthVerifierKey) != 0 {
			t.Fatal("the verifier outlived the attempt")
		}
	})
}

func TestOAuthStateIsBoundToTheAttempt(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		other := e.connection(t, "calendar_public", ConnectionWrite{ClientID: str("public")})
		otherUser := uuid.New()
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Admin','oauth-admin','unused','administrator',TRUE)`, otherUser); err != nil {
			t.Fatal(err)
		}
		expect := func(name string, err error, reason string) {
			t.Helper()
			if oauthReason(err) != "plugin_oauth_failed:"+reason {
				t.Fatalf("%s = %v", name, err)
			}
		}
		_, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: "not-a-state", Code: "x"})
		expect("unknown state", err, OAuthFailInvalidState)
		_, err = e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{Code: "x"})
		expect("missing state", err, OAuthFailInvalidState)
		_, err = e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: strings.Repeat("a", 257), Code: "x"})
		expect("long state", err, OAuthFailInvalidState)

		// Another operator, another connection, and an expired attempt each
		// fail, and each failure consumes the attempt.
		cases := []struct {
			name string
			call func(state, code string) error
		}{
			{"another operator", func(state, code string) error {
				_, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, otherUser, OAuthCallback{State: state, Code: code})
				return err
			}},
			{"another connection", func(state, code string) error {
				_, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, other.ID, e.userID, OAuthCallback{State: state, Code: code})
				return err
			}},
			{"expired", func(state, code string) error {
				e.clock.Set(e.clock.Now().Add(oauthAttemptLifetime))
				_, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: code})
				return err
			}},
		}
		for _, c := range cases {
			state, code := e.authorize(t, e.service, document.ID)
			expect(c.name, c.call(state, code), OAuthFailInvalidState)
			_, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: code})
			expect(c.name+" then the right operator", err, OAuthFailInvalidState)
		}
		// A provider error consumes the attempt and never sends a code.
		state, _ := e.authorize(t, e.service, document.ID)
		_, err = e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Error: "access_denied"})
		expect("provider error", err, OAuthFailProviderDenied)
		// A code the provider did not issue for this verifier is refused at
		// the token endpoint.
		state, _ = e.authorize(t, e.service, document.ID)
		_, err = e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: e.provider.issueCode("wrong-challenge", document.OAuth.CallbackURL)})
		expect("wrong verifier", err, tokenInvalidGrant)
		if len(e.provider.grants("authorization_code")) != 1 {
			t.Fatalf("exchanges = %d", len(e.provider.grants("authorization_code")))
		}
		current, _ := e.service.GetConnection(e.ctx, sampleconnections.ID, document.ID)
		if current.OAuth.Status != OAuthNotConnected {
			t.Fatalf("status = %s", current.OAuth.Status)
		}
	})
}

func TestOAuthAttemptSurvivesRestartAndIsConsumedOnce(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		state, code := e.authorize(t, e.service, document.ID)
		// A Server restart between the start and the callback.
		restarted := e.restarted()
		connected, err := restarted.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: code})
		if err != nil || connected.OAuth.Status != OAuthConnected {
			t.Fatalf("after restart = %+v %v", connected.OAuth, err)
		}
		if _, err := e.service.DisconnectOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID); err != nil {
			t.Fatal(err)
		}
		// Two Server processes receive the same callback: one wins.
		state, code = e.authorize(t, e.service, document.ID)
		services := []*Service{e.service, e.restarted(), e.restarted(), e.restarted()}
		var wg sync.WaitGroup
		results := make([]error, len(services))
		for i, service := range services {
			wg.Add(1)
			go func(i int, service *Service) {
				defer wg.Done()
				_, results[i] = service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: code})
			}(i, service)
		}
		wg.Wait()
		wins := 0
		for _, err := range results {
			if err == nil {
				wins++
			} else if oauthReason(err) != "plugin_oauth_failed:invalid_state" {
				t.Fatalf("loser = %v", err)
			}
		}
		if wins != 1 || len(e.provider.grants("authorization_code")) != 2 {
			t.Fatalf("wins = %d, exchanges = %d", wins, len(e.provider.grants("authorization_code")))
		}
	})
}

func TestOAuthCallbackPageIsFixed(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		id := uuid.New()
		page := "/plugins/sample-connections/connections/" + id.String()
		location := e.service.OAuthCallbackPage(sampleconnections.ID, id.String(), url.Values{
			"state": {"abc"}, "code": {"xyz"}, "returnTo": {"https://evil.example/steal"}, "redirect": {"//evil.example"},
		})
		if !strings.HasPrefix(location, page+"#oauth=") || strings.Contains(location, "evil") {
			t.Fatalf("location = %s", location)
		}
		fragment, _ := url.QueryUnescape(strings.TrimPrefix(location, page+"#oauth="))
		values, _ := url.ParseQuery(fragment)
		if values.Get("state") != "abc" || values.Get("code") != "xyz" || values.Has("error") {
			t.Fatalf("fragment = %v", values)
		}
		location = e.service.OAuthCallbackPage(sampleconnections.ID, id.String(), url.Values{"error": {"<script>"}, "error_description": {"provider text"}})
		fragment, _ = url.QueryUnescape(strings.TrimPrefix(location, page+"#oauth="))
		values, _ = url.ParseQuery(fragment)
		if values.Get("error") != "invalid_request" || strings.Contains(location, "provider") {
			t.Fatalf("error location = %s", location)
		}
		for _, bad := range [][2]string{{"unknown_plugin", id.String()}, {sampleconnections.ID, "not-a-uuid"}, {"sample_signs", id.String()}} {
			if location := e.service.OAuthCallbackPage(bad[0], bad[1], url.Values{"state": {"abc"}}); location != "/plugins" {
				t.Fatalf("%v = %s", bad, location)
			}
		}
	})
}

func TestOAuthTokenEndpointAddressPolicy(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254"} {
		t.Run(address, func(t *testing.T) {
			withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
				document := e.calendar(t)
				state, code := e.authorize(t, e.service, document.ID)
				// The token endpoint's host now resolves to a refused address.
				if _, err := e.network.Resolver.LookupNetIP(e.ctx, "ip", "auth.example.com"); err != nil {
					t.Fatal(err)
				}
				e.network.Resolver.Answer("auth.example.com", netip.MustParseAddr(address))
				_, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID, OAuthCallback{State: state, Code: code})
				if oauthReason(err) != "plugin_oauth_failed:"+tokenUnavailable || len(e.provider.grants("authorization_code")) != 0 {
					t.Fatalf("complete = %v", err)
				}
			})
		})
	}
}

func TestOAuthClientAuthenticationMethods(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		jsonClient := e.connection(t, "calendar_json", ConnectionWrite{ClientID: str("json-client"), ClientSecret: str("json-secret")})
		e.connect(t, jsonClient.ID)
		public := e.connection(t, "calendar_public", ConnectionWrite{ClientID: str("public-client")})
		e.connect(t, public.ID)
		exchanges := e.provider.grants("authorization_code")
		if len(exchanges) != 2 {
			t.Fatalf("exchanges = %d", len(exchanges))
		}
		post, none := exchanges[0], exchanges[1]
		if post.path != "/json-token" || post.contentType != "application/json" || post.authorization != "" ||
			post.values["client_id"] != "json-client" || post.values["client_secret"] != "json-secret" || post.values["code_verifier"] == "" {
			t.Fatalf("client_secret_post JSON = %+v", post)
		}
		if none.contentType != "application/x-www-form-urlencoded" || none.authorization != "" || none.values["client_id"] != "public-client" ||
			none.values["client_secret"] != "" {
			t.Fatalf("public client = %+v", none)
		}
	})
}

func TestOAuthTokensStayEncryptedAndOutOfEveryProjection(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		e.connect(t, document.ID)
		if _, err := e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID,
			SettingsWrite{Values: map[string]any{"calendar": document.ID.String()}, ExpectedRevision: revisionOf(0)}); err != nil {
			t.Fatal(err)
		}
		// A refresh writes a second generation of tokens.
		e.clock.Set(e.clock.Now().Add(time.Hour))
		if _, err := e.fetch(t, document.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := e.service.DisconnectOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID); err != nil {
			t.Fatal(err)
		}
		e.connect(t, document.ID)
		secrets := []string{oauthClientSecret, "at-1-0a8f", "rt-1-77c1", "at-2-0a8f", "rt-2-77c1", "at-3-0a8f", "rt-3-77c1"}
		var dumps []string
		for _, query := range []string{
			`SELECT coalesce(string_agg(encode(envelope,'escape'),''),'') FROM plugin_secrets`,
			`SELECT coalesce(string_agg(row_to_json(c)::text,''),'') FROM plugin_connections c`,
			`SELECT coalesce(string_agg(row_to_json(a)::text,''),'') FROM audit_logs a`,
			`SELECT coalesce(string_agg(row_to_json(o)::text,''),'') FROM plugin_oauth_transactions o`,
		} {
			var dump string
			if err := e.pool.QueryRow(e.ctx, query).Scan(&dump); err != nil {
				t.Fatal(err)
			}
			dumps = append(dumps, dump)
		}
		list, err := e.service.ListConnections(e.ctx, sampleconnections.ID)
		if err != nil {
			t.Fatal(err)
		}
		manifest, err := e.service.ManifestForScreen(e.ctx, e.screenID)
		if err != nil {
			t.Fatal(err)
		}
		state, err := e.service.PlayerStateForScreen(e.ctx, e.screenID, nil)
		if err != nil {
			t.Fatal(err)
		}
		settings, err := e.service.ReadPluginSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range []any{list, manifest, state, settings} {
			encoded, _ := json.Marshal(value)
			dumps = append(dumps, string(encoded))
		}
		dumps = append(dumps, e.logs.String())
		for i, dump := range dumps {
			for _, secret := range secrets {
				if strings.Contains(dump, secret) {
					t.Fatalf("dump %d holds %q", i, secret)
				}
			}
		}
		if !strings.Contains(dumps[2], "plugin.connection.oauth_connected") || !strings.Contains(dumps[2], "plugin.connection.oauth_disconnected") {
			t.Fatal("the audit log has no OAuth rows")
		}
	})
}

func TestOAuthFetchSendsTheBearerAndRefusesAPluginAuthorization(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		if _, err := e.fetch(t, document.ID); fetchCode(err) != CodeOAuthNotConnected {
			t.Fatalf("before connecting = %v", err)
		}
		e.connect(t, document.ID)
		response, err := e.fetch(t, document.ID)
		if err != nil || response.Status != http.StatusOK {
			t.Fatalf("fetch = %+v %v", response, err)
		}
		encoded, _ := json.Marshal(response)
		if strings.Contains(string(encoded), "at-1-0a8f") {
			t.Fatal("the response holds the token")
		}
		for _, name := range []string{"Authorization", " authorization "} {
			value := "Bearer mine"
			if _, err := e.fetch(t, document.ID, ConnectionHeader{Name: name, Value: &value}); fetchCode(err) != CodeOAuthAuthorizationHeader {
				t.Fatalf("plugin Authorization %q = %v", name, err)
			}
		}
		if got := e.provider.apiAuthorizations(); len(got) != 1 || got[0] != "Bearer at-1-0a8f" {
			t.Fatalf("API saw %v", got)
		}
		// A release that changes the OAuth declaration needs a new
		// authorization.
		if _, err := e.pool.Exec(e.ctx, `UPDATE plugin_connections SET oauth_fingerprint=repeat('0',64) WHERE id=$1`, document.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := e.fetch(t, document.ID); fetchCode(err) != CodeOAuthReconnectRequired {
			t.Fatalf("changed declaration = %v", err)
		}
		current, _ := e.service.GetConnection(e.ctx, sampleconnections.ID, document.ID)
		if current.Status != ReasonOAuthReconnectRequired {
			t.Fatalf("status = %s", current.Status)
		}
	})
}

func TestOAuthRefreshIsSerializedAndRotates(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		e.connect(t, document.ID)
		// Inside the margin before expiry, five concurrent requests refresh
		// once and all use the new token.
		e.clock.Set(e.clock.Now().Add(time.Hour - 30*time.Second))
		gate := make(chan struct{})
		e.provider.mu.Lock()
		e.provider.refreshGate = gate
		e.provider.mu.Unlock()
		var wg sync.WaitGroup
		errs := make([]error, 5)
		for i := range errs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				_, errs[i] = e.fetch(t, document.ID)
			}(i)
		}
		time.Sleep(100 * time.Millisecond) // let every request reach the lock or the provider
		close(gate)
		wg.Wait()
		for _, err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		refreshes := e.provider.grants("refresh_token")
		if len(refreshes) != 1 || refreshes[0].values["refresh_token"] != "rt-1-77c1" {
			t.Fatalf("refreshes = %+v", refreshes)
		}
		for _, header := range e.provider.apiAuthorizations() {
			if header != "Bearer at-2-0a8f" {
				t.Fatalf("API saw %s", header)
			}
		}
		// The rotated refresh token replaced the old one.
		e.provider.mu.Lock()
		e.provider.refreshGate = nil
		e.provider.refresh = func(map[string]string) (int, string) {
			return http.StatusOK, `{"access_token":"at-x-0a8f","token_type":"bearer","expires_in":"3600"}`
		}
		e.provider.mu.Unlock()
		e.clock.Set(e.clock.Now().Add(2 * time.Hour))
		if _, err := e.fetch(t, document.ID); err != nil {
			t.Fatal(err)
		}
		refreshes = e.provider.grants("refresh_token")
		if len(refreshes) != 2 || refreshes[1].values["refresh_token"] != "rt-2-77c1" {
			t.Fatalf("rotation = %+v", refreshes)
		}
		// A provider that sends no new refresh token keeps the old one.
		e.clock.Set(e.clock.Now().Add(2 * time.Hour))
		if _, err := e.fetch(t, document.ID); err != nil {
			t.Fatal(err)
		}
		refreshes = e.provider.grants("refresh_token")
		if len(refreshes) != 3 || refreshes[2].values["refresh_token"] != "rt-2-77c1" {
			t.Fatalf("kept refresh token = %+v", refreshes)
		}
		current, _ := e.service.GetConnection(e.ctx, sampleconnections.ID, document.ID)
		if current.OAuth.RefreshedAt == nil || !current.OAuth.RefreshedAt.Equal(e.clock.Now()) {
			t.Fatalf("refreshedAt = %v", current.OAuth.RefreshedAt)
		}
	})
}

func TestOAuthRefreshFailures(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		e.connect(t, document.ID)
		e.provider.mu.Lock()
		e.provider.refresh = func(map[string]string) (int, string) {
			return http.StatusServiceUnavailable, `{"error":"temporarily_unavailable"}`
		}
		e.provider.mu.Unlock()
		// A transient failure inside the margin keeps the tokens and still
		// uses the unexpired access token.
		e.clock.Set(e.clock.Now().Add(time.Hour - 30*time.Second))
		if _, err := e.fetch(t, document.ID); err != nil {
			t.Fatalf("transient with a valid token = %v", err)
		}
		current, _ := e.service.GetConnection(e.ctx, sampleconnections.ID, document.ID)
		if current.OAuth.Status != OAuthConnected || current.OAuth.LastError == nil || *current.OAuth.LastError != tokenUnavailable ||
			len(current.Notices) != 1 || current.Notices[0] != ReasonOAuthRefreshFailing {
			t.Fatalf("after a transient failure = %+v %v", current.OAuth, current.Notices)
		}
		// Within the backoff the provider is not asked again.
		if _, err := e.fetch(t, document.ID); err != nil {
			t.Fatal(err)
		}
		if len(e.provider.grants("refresh_token")) != 1 {
			t.Fatalf("refreshes = %d", len(e.provider.grants("refresh_token")))
		}
		// After expiry, a transient failure is refresh_failed and keeps the
		// refresh token for the next attempt.
		e.clock.Set(e.clock.Now().Add(time.Minute))
		if _, err := e.fetch(t, document.ID); fetchCode(err) != CodeOAuthRefreshFailed {
			t.Fatalf("expired + transient = %v", err)
		}
		if e.secretCount(t, document.ID, oauthRefreshTokenKey) != 1 || len(e.provider.grants("refresh_token")) != 2 {
			t.Fatal("a transient failure lost the refresh token")
		}
		// invalid_grant needs a new authorization and never retries.
		e.provider.mu.Lock()
		e.provider.refresh = func(map[string]string) (int, string) { return http.StatusBadRequest, `{"error":"invalid_grant"}` }
		e.provider.mu.Unlock()
		e.clock.Set(e.clock.Now().Add(time.Minute))
		if _, err := e.fetch(t, document.ID); fetchCode(err) != CodeOAuthReconnectRequired {
			t.Fatalf("invalid_grant = %v", err)
		}
		e.clock.Set(e.clock.Now().Add(time.Hour))
		if _, err := e.fetch(t, document.ID); fetchCode(err) != CodeOAuthReconnectRequired {
			t.Fatalf("after invalid_grant = %v", err)
		}
		if len(e.provider.grants("refresh_token")) != 3 || e.secretCount(t, document.ID, oauthAccessTokenKey) != 0 || e.secretCount(t, document.ID, oauthRefreshTokenKey) != 0 {
			t.Fatal("invalid_grant kept tokens or retried")
		}
		current, _ = e.service.GetConnection(e.ctx, sampleconnections.ID, document.ID)
		if current.OAuth.Status != OAuthReconnectRequired || current.Status != ReasonOAuthReconnectRequired || !current.OAuth.ConnectAvailable {
			t.Fatalf("reconnect = %+v %s", current.OAuth, current.Status)
		}
		var audited int
		if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM audit_logs WHERE action='plugin.connection.oauth_reconnect_required' AND calling_surface='system'`).Scan(&audited); err != nil || audited != 1 {
			t.Fatalf("reconnect audit = %d %v", audited, err)
		}
		// Reconnecting restores the connection.
		e.connect(t, document.ID)
	})
}

func TestOAuthDisconnectAndClientChanges(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		e.connect(t, document.ID)
		if err := e.service.DeleteConnection(e.ctx, sampleconnections.ID, document.ID, e.userID); apiCode(err) != "plugin_connection_connected" {
			t.Fatalf("delete while connected = %v", err)
		}
		disconnected, err := e.service.DisconnectOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID)
		if err != nil || disconnected.OAuth.Status != OAuthNotConnected || *disconnected.OAuth.Revocation != "confirmed" {
			t.Fatalf("disconnect = %+v %v", disconnected.OAuth, err)
		}
		revocations := e.provider.revocations()
		if len(revocations) != 1 || revocations[0].values["token"] != "rt-1-77c1" || revocations[0].values["token_type_hint"] != "refresh_token" ||
			!strings.HasPrefix(revocations[0].authorization, "Basic ") {
			t.Fatalf("revocation = %+v", revocations)
		}
		if e.secretCount(t, document.ID, oauthAccessTokenKey)+e.secretCount(t, document.ID, oauthRefreshTokenKey) != 0 {
			t.Fatal("disconnect kept tokens")
		}
		// A failed revocation still deletes the local tokens and says so.
		e.connect(t, document.ID)
		e.provider.mu.Lock()
		e.provider.revokeStatus = http.StatusServiceUnavailable
		e.provider.mu.Unlock()
		disconnected, err = e.service.DisconnectOAuth(e.ctx, sampleconnections.ID, document.ID, e.userID)
		if err != nil || *disconnected.OAuth.Revocation != "failed" || len(disconnected.Notices) != 1 || disconnected.Notices[0] != ReasonOAuthRevocationFailed ||
			e.secretCount(t, document.ID, oauthAccessTokenKey)+e.secretCount(t, document.ID, oauthRefreshTokenKey) != 0 {
			t.Fatalf("failed revocation = %+v %v", disconnected, err)
		}
		if err := e.service.DeleteConnection(e.ctx, sampleconnections.ID, document.ID, e.userID); err != nil {
			t.Fatalf("delete after disconnect = %v", err)
		}
		// A declaration without a revocation endpoint records not_declared.
		jsonClient := e.connection(t, "calendar_json", ConnectionWrite{ClientID: str("json-client"), ClientSecret: str("json-secret")})
		e.connect(t, jsonClient.ID)
		disconnected, err = e.service.DisconnectOAuth(e.ctx, sampleconnections.ID, jsonClient.ID, e.userID)
		if err != nil || *disconnected.OAuth.Revocation != "not_declared" || len(e.provider.revocations()) != 2 {
			t.Fatalf("not declared = %+v %v", disconnected.OAuth, err)
		}
		// A new client secret keeps the tokens; a new client ID deletes them
		// and the attempt in progress.
		calendar := e.calendar(t)
		connected := e.connect(t, calendar.ID)
		updated, err := e.service.UpdateConnection(e.ctx, sampleconnections.ID, calendar.ID, e.userID, ConnectionWrite{Name: str("calendar"), ClientSecret: str("rotated-secret"), ExpectedRevision: revisionOf(connected.Revision)})
		if err != nil || updated.OAuth.Status != OAuthConnected || updated.OAuth.ClientSecret != pluginsecrets.StateSet {
			t.Fatalf("new secret = %+v %v", updated.OAuth, err)
		}
		state, code := e.authorize(t, e.service, calendar.ID)
		updated, err = e.service.UpdateConnection(e.ctx, sampleconnections.ID, calendar.ID, e.userID, ConnectionWrite{Name: str("calendar"), ClientID: str("another-client"), ExpectedRevision: revisionOf(updated.Revision)})
		if err != nil || updated.OAuth.Status != OAuthNotConnected || e.secretCount(t, calendar.ID, oauthAccessTokenKey) != 0 || e.secretCount(t, calendar.ID, oauthVerifierKey) != 0 {
			t.Fatalf("new client ID = %+v %v", updated.OAuth, err)
		}
		if _, err := e.service.CompleteOAuth(e.ctx, sampleconnections.ID, calendar.ID, e.userID, OAuthCallback{State: state, Code: code}); oauthReason(err) != "plugin_oauth_failed:invalid_state" {
			t.Fatalf("attempt of the old client = %v", err)
		}
		// The secret is write-only: no document carries it.
		encoded, _ := json.Marshal(updated)
		if strings.Contains(string(encoded), "rotated-secret") {
			t.Fatal("a document holds the client secret")
		}
	})
}

func TestOAuthExpiredAttemptsAreSwept(t *testing.T) {
	withOAuth(t, oauthPublicURL, func(e oauthEnvironment) {
		document := e.calendar(t)
		e.authorize(t, e.service, document.ID)
		if removed, err := e.service.ExpireOAuthAttempts(e.ctx); err != nil || removed != 0 {
			t.Fatalf("fresh sweep = %d %v", removed, err)
		}
		e.clock.Set(e.clock.Now().Add(oauthAttemptLifetime))
		if removed, err := e.service.ExpireOAuthAttempts(e.ctx); err != nil || removed != 1 {
			t.Fatalf("sweep = %d %v", removed, err)
		}
		if e.secretCount(t, document.ID, oauthVerifierKey) != 0 {
			t.Fatal("the sweep kept the verifier")
		}
	})
}

func TestParseTokenResponse(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{400, `{"error":"invalid_grant"}`, tokenInvalidGrant},
		{401, `{"error":"invalid_client"}`, tokenRejected},
		{400, `{"error":"invalid_scope"}`, tokenRejected},
		{401, ``, tokenRejected},
		{429, `{"error":"slow_down"}`, tokenUnavailable},
		{408, ``, tokenUnavailable},
		{503, `{"error":"invalid_grant"}`, tokenUnavailable},
		{302, ``, tokenUnavailable},
		{200, `{"token_type":"bearer"}`, tokenInvalid},
		{200, `{"access_token":"a","token_type":"mac"}`, tokenInvalid},
		{200, `not json`, tokenInvalid},
		{200, `{"access_token":"a"}`, ""},
	} {
		if _, got := parseTokenResponse(c.status, []byte(c.body), now); got != c.want {
			t.Errorf("%d %s = %q, want %q", c.status, c.body, got, c.want)
		}
	}
	tokens, _ := parseTokenResponse(200, []byte(`{"access_token":"a","refresh_token":"r","expires_in":"120"}`), now)
	if tokens.refresh != "r" || tokens.expiresAt == nil || !tokens.expiresAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("tokens = %+v", tokens)
	}
	if tokens, _ := parseTokenResponse(200, []byte(`{"access_token":"a"}`), now); tokens.expiresAt != nil {
		t.Fatal("no expiry invented an expiry")
	}
	if _, failure := parseTokenResponse(200, []byte(`{"access_token":"`+strings.Repeat("a", 4097)+`"}`), now); failure != tokenInvalid {
		t.Fatal("an oversized token was accepted")
	}
}
