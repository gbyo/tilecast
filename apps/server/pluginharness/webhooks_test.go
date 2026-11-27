package pluginharness_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	"github.com/tilecast/tilecast/apps/server/pluginharness/webhookplugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Inbound webhook conformance (docs/plugin-webhooks.md): the test plugin,
// the real plugin host, the real delivery queue, the real secret store, and
// a stepped clock. No request leaves the process.

const (
	pcoSecret      = "a3f9c1d2e4b5a6978877665544332211a3f9c1d2e4b5a6978877665544332211"
	standardSecret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
)

type hookEnv struct {
	h     *pluginharness.Harness
	clock *clock
	hooks *webhookplugins.Hooks
	logs  *syncBuffer
}

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

func newHookEnv(t *testing.T) hookEnv {
	t.Helper()
	logs := &syncBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	c := &clock{now: time.Now().UTC().Truncate(time.Second)}
	hooks := webhookplugins.New()
	h := pluginharness.New(t, hooks, pluginharness.Clock(c))
	if _, err := h.Pool.Exec(h.Ctx, `TRUNCATE plugin_deliveries, plugin_delivery_status, plugin_webhook_tokens, plugin_webhook_receipts, plugin_webhook_status`); err != nil {
		t.Fatal(err)
	}
	h.Install()
	h.SetOrganizationSecret(webhookplugins.SigningSecret, pcoSecret)
	h.SetOrganizationSecret(webhookplugins.StandardSecret, standardSecret)
	return hookEnv{h: h, clock: c, hooks: hooks, logs: logs}
}

func hexHMAC(key string, parts ...string) string {
	m := hmac.New(sha256.New, []byte(key))
	for _, part := range parts {
		m.Write([]byte(part))
	}
	return hex.EncodeToString(m.Sum(nil))
}

func b64HMAC(key []byte, parts ...string) string {
	m := hmac.New(sha256.New, key)
	for _, part := range parts {
		m.Write([]byte(part))
	}
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

func pcoBody(id string) string {
	return `{"data":[{"id":"` + id + `","type":"EventDelivery","attributes":{"name":"services.v2.events.plan_time.updated","attempt":1,"payload":"{}"}}]}`
}

func pcoCall(id string) pluginharness.WebhookCall {
	body := pcoBody(id)
	return pluginharness.WebhookCall{Body: []byte(body), Header: http.Header{
		"X-Pco-Webhooks-Authenticity": {hexHMAC(pcoSecret, body)},
		"X-Pco-Webhooks-Event":        {"services.v2.events.plan_time.updated"},
		"Authorization":               {"Bearer should-never-be-kept"},
		"Cookie":                      {"tilecast_session=never"},
	}}
}

func (e hookEnv) standardCall(id string, at time.Time, body string) pluginharness.WebhookCall {
	key, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(standardSecret, "whsec_"))
	ts := strconv.FormatInt(at.Unix(), 10)
	return pluginharness.WebhookCall{Body: []byte(body), Header: http.Header{
		"Webhook-Id": {id}, "Webhook-Timestamp": {ts},
		"Webhook-Signature": {"v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1," + b64HMAC(key, id, ".", ts, ".", body)},
	}}
}

func status(t *testing.T, got plugins.WebhookResponse, want int) {
	t.Helper()
	if got.Status != want {
		t.Fatalf("status %d (%s %s), want %d", got.Status, got.Code, got.Message, want)
	}
}

func (e hookEnv) state(t *testing.T, id string) plugins.WebhookState {
	t.Helper()
	for _, state := range e.h.Webhooks() {
		if state.ID == id {
			return state
		}
	}
	t.Fatalf("no webhook %s", id)
	return plugins.WebhookState{}
}

func (e hookEnv) queued(t *testing.T, source string) int {
	t.Helper()
	var count int
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM plugin_deliveries WHERE plugin_id=$1 AND kind='webhook' AND source=$2`,
		webhookplugins.ID, source).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// countingReader counts what the host reads of an endless body.
type countingReader struct{ read int64 }

func (r *countingReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	r.read += int64(len(p))
	return len(p), nil
}

func TestWebhookBodyBound(t *testing.T) {
	e := newHookEnv(t)
	token := e.h.CreateWebhookToken(webhookplugins.DoorsTwo, "Panel")
	header := func() http.Header { return http.Header{"Authorization": {"Bearer " + token.Token}} }

	exact := bytes.Repeat([]byte("x"), plugin.MaxWebhookBodyBytes)
	status(t, e.h.Webhook(webhookplugins.DoorsTwo, pluginharness.WebhookCall{Header: header(), Body: exact}), 202)
	over := append(append([]byte{}, exact...), 'x')
	status(t, e.h.Webhook(webhookplugins.DoorsTwo, pluginharness.WebhookCall{Header: header(), Body: over}), 413)

	// An endless body without a declared length: the host stops one byte
	// past the limit and never holds more.
	endless := &countingReader{}
	status(t, e.h.Webhook(webhookplugins.DoorsTwo, pluginharness.WebhookCall{Header: header(), Reader: endless, ContentLength: -1}), 413)
	if endless.read > plugin.MaxWebhookBodyBytes+1+int64(64<<10) {
		t.Fatalf("read %d bytes of an endless body", endless.read)
	}
	// A declared length over the limit is refused before reading anything.
	declared := &countingReader{}
	status(t, e.h.Webhook(webhookplugins.DoorsTwo, pluginharness.WebhookCall{Header: header(), Reader: declared, ContentLength: 1 << 30}), 413)
	if declared.read != 0 {
		t.Fatalf("read %d bytes of a body declared too large", declared.read)
	}
	if e.queued(t, webhookplugins.DoorsTwo) != 1 {
		t.Fatal("only the exact-limit body is queued")
	}
	e.h.Deliver()
	if got := e.hooks.Received(webhookplugins.DoorsTwo); len(got) != 1 || !bytes.Equal(got[0].Webhook.Body, exact) {
		t.Fatal("the exact-limit body was not delivered intact")
	}
}

func TestWebhookRoutingAndMethods(t *testing.T) {
	e := newHookEnv(t)
	get := e.h.Webhook(webhookplugins.Changes, pluginharness.WebhookCall{Method: http.MethodGet})
	status(t, get, 405)
	if get.Allow != http.MethodPost {
		t.Fatalf("Allow %q", get.Allow)
	}
	status(t, e.h.Webhook("undeclared", pcoCall("a")), 404)
	status(t, e.h.WebhookOf("absent_plugin", webhookplugins.Changes, pcoCall("a")), 404)
	if err := e.h.Remove(); err != nil {
		t.Fatal(err)
	}
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("a")), 404)
}

func TestStandardWebhooksConformance(t *testing.T) {
	e := newHookEnv(t)
	body := `{"type":"thing.updated","data":{"id":1}}`
	accepted := e.h.Webhook(webhookplugins.Standard, e.standardCall("msg_1", e.clock.Now(), body))
	status(t, accepted, 202)
	if accepted.Handshake != nil || accepted.Code != "" {
		t.Fatal("an acknowledgement has no body")
	}
	e.h.Deliver()
	got := e.hooks.Received(webhookplugins.Standard)
	if len(got) != 1 {
		t.Fatalf("%d deliveries", len(got))
	}
	webhook := got[0].Webhook
	if _, err := uuid.Parse(webhook.DeliveryID); err != nil || webhook.ExternalID != "msg_1" || string(webhook.Body) != body ||
		!webhook.ReceivedAt.Equal(e.clock.Now()) || webhook.Attempt != 1 {
		t.Fatalf("delivery %+v", webhook)
	}
	if got[0].Principal || !got[0].Deadline {
		t.Fatal("HandleWebhook runs in the system context with a time limit")
	}

	bad := e.standardCall("msg_2", e.clock.Now(), body)
	bad.Header.Set("Webhook-Signature", "v1,"+base64.StdEncoding.EncodeToString(make([]byte, 32)))
	status(t, e.h.Webhook(webhookplugins.Standard, bad), 401)
	if e.state(t, webhookplugins.Standard).LastRefusal != "signature_invalid" {
		t.Fatal("refusal not recorded")
	}
	status(t, e.h.Webhook(webhookplugins.Standard, e.standardCall("msg_3", e.clock.Now().Add(-6*time.Minute), body)), 401)
	status(t, e.h.Webhook(webhookplugins.Standard, e.standardCall("msg_4", e.clock.Now().Add(6*time.Minute), body)), 401)
	if e.state(t, webhookplugins.Standard).LastRefusal != "timestamp_out_of_range" {
		t.Fatal("timestamp refusal not recorded")
	}
	// A signature over a changed body fails: the host signs the exact
	// raw body.
	tampered := e.standardCall("msg_5", e.clock.Now(), body)
	tampered.Body = []byte(body + " ")
	status(t, e.h.Webhook(webhookplugins.Standard, tampered), 401)
	if e.queued(t, webhookplugins.Standard) != 0 {
		t.Fatal("a refused request was queued")
	}
}

func TestPlanningCenterStyleHMACAndForwardedHeaders(t *testing.T) {
	e := newHookEnv(t)
	call := pcoCall("5a1f9c3e-2b44-4f61-8d1f-7a0c9a2b3c4d")
	status(t, e.h.Webhook(webhookplugins.Changes, call), 200)
	e.h.Deliver()
	got := e.hooks.Received(webhookplugins.Changes)
	if len(got) != 1 {
		t.Fatalf("%d deliveries", len(got))
	}
	webhook := got[0].Webhook
	if !bytes.Equal(webhook.Body, call.Body) || webhook.ExternalID != "5a1f9c3e-2b44-4f61-8d1f-7a0c9a2b3c4d" {
		t.Fatalf("delivery %+v", webhook)
	}
	if len(webhook.Headers) != 1 || webhook.Headers["X-Pco-Webhooks-Event"] != "services.v2.events.plan_time.updated" {
		t.Fatalf("headers %v: only the declared forwarded header is kept", webhook.Headers)
	}
	// The secret looks like hex; a signature made with its decoded bytes
	// is refused, and so is a missing one.
	decoded, _ := hex.DecodeString(pcoSecret)
	wrong := pcoCall("second")
	m := hmac.New(sha256.New, decoded)
	m.Write(wrong.Body)
	wrong.Header.Set("X-Pco-Webhooks-Authenticity", hex.EncodeToString(m.Sum(nil)))
	status(t, e.h.Webhook(webhookplugins.Changes, wrong), 401)
	missing := pcoCall("third")
	missing.Header.Del("X-Pco-Webhooks-Authenticity")
	status(t, e.h.Webhook(webhookplugins.Changes, missing), 401)
	// A body without the declared delivery ID is refused.
	body := `{"data":[]}`
	status(t, e.h.Webhook(webhookplugins.Changes, pluginharness.WebhookCall{Body: []byte(body),
		Header: http.Header{"X-Pco-Webhooks-Authenticity": {hexHMAC(pcoSecret, body)}}}), 400)
}

func TestPairsSignatureAndEchoJSONHandshake(t *testing.T) {
	e := newHookEnv(t)
	ts := strconv.FormatInt(e.clock.Now().Unix(), 10)
	sign := func(body string) http.Header {
		return http.Header{"Example-Signature": {"t=" + ts + ",v1=00,v1=" + hexHMAC(pcoSecret, ts, ".", body)}}
	}
	event := `{"id":"evt_1","type":"thing"}`
	status(t, e.h.Webhook(webhookplugins.Pairs, pluginharness.WebhookCall{Body: []byte(event), Header: sign(event)}), 202)

	challenge := `{"id":"evt_challenge","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"}`
	answer := e.h.Webhook(webhookplugins.Pairs, pluginharness.WebhookCall{Body: []byte(challenge), Header: sign(challenge)})
	status(t, answer, 200)
	if string(answer.Handshake) != "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" {
		t.Fatalf("handshake %q", answer.Handshake)
	}
	unsigned := e.h.Webhook(webhookplugins.Pairs, pluginharness.WebhookCall{Body: []byte(challenge),
		Header: http.Header{"Example-Signature": {"t=" + ts + ",v1=00"}}})
	status(t, unsigned, 401)
	if unsigned.Handshake != nil {
		t.Fatal("an unsigned challenge was answered")
	}
	e.h.Deliver()
	if got := e.hooks.Received(); len(got) != 1 || got[0].Webhook.ExternalID != "evt_1" {
		t.Fatalf("the plugin ran for a handshake: %+v", got)
	}
}

func TestURLBodySignatureUsesTheConfiguredAddress(t *testing.T) {
	e := newHookEnv(t)
	endpoint := e.h.WebhookEndpoint(webhookplugins.Square)
	if endpoint != "https://tilecast.example/api/v1/hooks/harness_hooks/square" || e.state(t, webhookplugins.Square).EndpointURL != endpoint {
		t.Fatalf("endpoint %s", endpoint)
	}
	body := `{"merchant_id":"ML1","type":"payment.updated","event_id":"0b6ce3c6","data":{}}`
	proxied := http.Header{
		"Host": {"internal.lan:8080"}, "X-Forwarded-Host": {"evil.example"}, "X-Forwarded-Proto": {"http"},
		"Forwarded": {"host=evil.example;proto=http"},
	}
	good := proxied.Clone()
	good.Set("x-square-hmacsha256-signature", b64HMAC([]byte(pcoSecret), endpoint, body))
	status(t, e.h.Webhook(webhookplugins.Square, pluginharness.WebhookCall{Body: []byte(body), Header: good}), 202)
	// A signature over the address the proxy headers suggest is refused.
	forged := proxied.Clone()
	body2 := strings.Replace(body, "0b6ce3c6", "11111111", 1)
	forged.Set("x-square-hmacsha256-signature", b64HMAC([]byte(pcoSecret), "http://evil.example/api/v1/hooks/harness_hooks/square", body2))
	status(t, e.h.Webhook(webhookplugins.Square, pluginharness.WebhookCall{Body: []byte(body2), Header: forged}), 401)
}

func TestSigningSecretFailsClosed(t *testing.T) {
	e := newHookEnv(t)
	if got := e.state(t, webhookplugins.Changes); got.SigningSecret != "set" || got.SigningSecretKey != webhookplugins.SigningSecret {
		t.Fatalf("secret state %+v", got)
	}
	e.h.LoseOrganizationSecretKey(webhookplugins.SigningSecret)
	unreadable := e.h.Webhook(webhookplugins.Changes, pcoCall("a"))
	status(t, unreadable, 503)
	if unreadable.RetryAfter == 0 {
		t.Fatal("a 503 names Retry-After")
	}
	if got := e.state(t, webhookplugins.Changes); got.SigningSecret != "needs_value" || got.LastRefusal != plugins.RefusalSigningSecretUnset {
		t.Fatalf("state %+v", got)
	}
	if _, err := e.h.Pool.Exec(e.h.Ctx, `DELETE FROM plugin_secrets WHERE plugin_id=$1`, webhookplugins.ID); err != nil {
		t.Fatal(err)
	}
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("a")), 503)
	status(t, e.h.Webhook(webhookplugins.Standard, e.standardCall("msg", e.clock.Now(), `{}`)), 503)
	if got := e.state(t, webhookplugins.Changes); got.SigningSecret != "not_set" {
		t.Fatalf("state %+v", got)
	}
	if e.queued(t, webhookplugins.Changes)+e.queued(t, webhookplugins.Standard) != 0 {
		t.Fatal("a request without a usable secret was queued")
	}
}

func TestReplayRaceQueuesOnce(t *testing.T) {
	e := newHookEnv(t)
	const copies = 12
	var wg sync.WaitGroup
	statuses := make([]int, copies)
	for i := 0; i < copies; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			statuses[i] = e.h.Webhook(webhookplugins.Changes, pcoCall("same-delivery")).Status
		}(i)
	}
	wg.Wait()
	for _, got := range statuses {
		if got != 200 {
			t.Fatalf("statuses %v: every copy answers the configured success", statuses)
		}
	}
	if got := e.queued(t, webhookplugins.Changes); got != 1 {
		t.Fatalf("%d deliveries queued for one delivery ID", got)
	}
	state := e.state(t, webhookplugins.Changes)
	if state.AcceptedCount != 1 || state.DuplicateCount != copies-1 {
		t.Fatalf("state %+v", state)
	}
	var receipt uuid.UUID
	var delivery uuid.UUID
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT r.delivery_id, d.id FROM plugin_webhook_receipts r JOIN plugin_deliveries d ON d.id=r.delivery_id
		WHERE r.plugin_id=$1 AND r.external_id='same-delivery'`, webhookplugins.ID).Scan(&receipt, &delivery); err != nil || receipt != delivery {
		t.Fatalf("receipt does not name the queued delivery: %v", err)
	}
}

func TestReplayReceiptRetention(t *testing.T) {
	e := newHookEnv(t)
	// Without a signed timestamp: 7 days.
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("untimed")), 200)
	e.clock.advance(7*24*time.Hour - time.Second)
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("untimed")), 200)
	if e.queued(t, webhookplugins.Changes) != 1 {
		t.Fatal("a copy inside 7 days was queued")
	}
	e.clock.advance(2 * time.Second)
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("untimed")), 200)
	if e.queued(t, webhookplugins.Changes) != 2 {
		t.Fatal("a delivery ID after 7 days was not accepted again")
	}
	// With a signed timestamp: 24 hours.
	status(t, e.h.Webhook(webhookplugins.Standard, e.standardCall("timed", e.clock.Now(), `{}`)), 202)
	e.clock.advance(24*time.Hour - time.Second)
	status(t, e.h.Webhook(webhookplugins.Standard, e.standardCall("timed", e.clock.Now(), `{}`)), 202)
	if e.queued(t, webhookplugins.Standard) != 1 {
		t.Fatal("a copy inside 24 hours was queued")
	}
	e.clock.advance(2 * time.Second)
	status(t, e.h.Webhook(webhookplugins.Standard, e.standardCall("timed", e.clock.Now(), `{}`)), 202)
	if e.queued(t, webhookplugins.Standard) != 2 {
		t.Fatal("a delivery ID after 24 hours was not accepted again")
	}
	// The sweep deletes expired receipts.
	e.clock.advance(25 * time.Hour)
	before := receiptCount(t, e)
	e.h.SweepWebhooks()
	if after := receiptCount(t, e); after >= before {
		t.Fatalf("receipts %d -> %d", before, after)
	}
}

func receiptCount(t *testing.T, e hookEnv) int {
	t.Helper()
	var count int
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM plugin_webhook_receipts`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestWebhookTokens(t *testing.T) {
	e := newHookEnv(t)
	created := e.h.CreateWebhookToken(webhookplugins.Doors, "Fire panel")
	if !strings.HasPrefix(created.Token, "tch_"+created.PublicID+".") {
		t.Fatalf("token %q", created.Token)
	}
	secret := strings.TrimPrefix(created.Token, "tch_"+created.PublicID+".")
	// The secret is stored only as its SHA-256 digest.
	var stored []byte
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT secret_hash FROM plugin_webhook_tokens WHERE id=$1`, created.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(secret))
	if !bytes.Equal(stored, digest[:]) {
		t.Fatal("the stored hash is not the secret's digest")
	}
	var dump string
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT row_to_json(t)::text FROM plugin_webhook_tokens t WHERE id=$1`, created.ID).Scan(&dump); err != nil || strings.Contains(dump, secret) {
		t.Fatal("the secret is stored")
	}
	// Listed metadata never holds the secret again.
	listed, _ := json.Marshal(e.h.Webhooks())
	if strings.Contains(string(listed), secret) || !strings.Contains(string(listed), created.PublicID) {
		t.Fatal("the list reveals the secret or misses the token")
	}

	call := func(webhook, authorization, eventID string) plugins.WebhookResponse {
		return e.h.Webhook(webhook, pluginharness.WebhookCall{Body: []byte(`{"door":"north"}`),
			Header: http.Header{"Authorization": {authorization}, "X-Event-Id": {eventID}, "X-Event-Type": {"door.opened"}}})
	}
	status(t, call(webhookplugins.Doors, "Bearer "+created.Token, "e1"), 202)
	status(t, call(webhookplugins.Doors, "Bearer tch_"+created.PublicID+".wrong", "e2"), 401)
	status(t, call(webhookplugins.Doors, "Bearer tci_"+created.PublicID+"."+secret, "e3"), 401)
	status(t, call(webhookplugins.Doors, created.Token, "e4"), 401)
	// A token authenticates its own webhook only.
	status(t, call(webhookplugins.DoorsTwo, "Bearer "+created.Token, "e5"), 401)
	if e.state(t, webhookplugins.DoorsTwo).LastRefusal != plugins.RefusalTokenInvalid {
		t.Fatal("cross-webhook refusal not recorded")
	}
	// The token webhook's declared delivery ID still applies.
	status(t, call(webhookplugins.Doors, "Bearer "+created.Token, ""), 400)
	status(t, call(webhookplugins.Doors, "Bearer "+created.Token, "e1"), 202)
	if e.queued(t, webhookplugins.Doors) != 1 {
		t.Fatal("token deliveries")
	}
	var lastUsed *time.Time
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT last_used_at FROM plugin_webhook_tokens WHERE id=$1`, created.ID).Scan(&lastUsed); err != nil || lastUsed == nil {
		t.Fatal("last use not recorded")
	}
	revoked, err := e.h.Plugins.RevokeWebhookToken(e.h.Ctx, webhookplugins.ID, webhookplugins.Doors, created.ID, e.h.OwnerID)
	if err != nil || revoked.RevokedAt == nil {
		t.Fatalf("revoke %v", err)
	}
	status(t, call(webhookplugins.Doors, "Bearer "+created.Token, "e9"), 401)
	if _, err := e.h.Plugins.RevokeWebhookToken(e.h.Ctx, webhookplugins.ID, webhookplugins.Doors, created.ID, e.h.OwnerID); !errors.Is(err, plugins.ErrWebhookTokenNotFound) {
		t.Fatalf("second revoke %v", err)
	}
	if _, err := e.h.Plugins.CreateWebhookToken(e.h.Ctx, webhookplugins.ID, webhookplugins.Changes, "x", e.h.OwnerID); !errors.Is(err, plugins.ErrWebhookNotToken) {
		t.Fatalf("token for a signature webhook: %v", err)
	}
	if e.h.AuditCount("plugin.webhook_token.created", created.ID.String()) != 1 || e.h.AuditCount("plugin.webhook_token.revoked", created.ID.String()) != 1 {
		t.Fatal("token lifecycle not audited")
	}
	for i := 0; i < plugins.MaxActiveWebhookTokens; i++ {
		e.h.CreateWebhookToken(webhookplugins.Doors, fmt.Sprintf("t%d", i))
	}
	if _, err := e.h.Plugins.CreateWebhookToken(e.h.Ctx, webhookplugins.ID, webhookplugins.Doors, "one more", e.h.OwnerID); !errors.Is(err, plugins.ErrWebhookTokenLimit) {
		t.Fatalf("token limit: %v", err)
	}
}

func TestCustomVerifier(t *testing.T) {
	e := newHookEnv(t)
	call := func(signature, delivery string) plugins.WebhookResponse {
		return e.h.Webhook(webhookplugins.Custom, pluginharness.WebhookCall{Body: []byte(`{"k":1}`),
			Header: http.Header{"X-Custom-Signature": {signature}, "X-Custom-Delivery": {delivery}, "X-Other": {"hidden"}}})
	}
	var seen plugin.WebhookVerification
	e.hooks.SetVerify(func(_ context.Context, _ *plugin.Services, request plugin.WebhookVerification) error {
		seen = request
		if request.Headers.Get("X-Custom-Signature") != "valid" {
			return webhookplugins.ErrNotAuthentic
		}
		return nil
	})
	status(t, call("valid", "d1"), 202)
	if string(seen.Body) != `{"k":1}` || seen.Headers.Get("X-Other") != "" || len(seen.Headers) != 1 ||
		seen.EndpointURL != e.h.WebhookEndpoint(webhookplugins.Custom) || seen.WebhookID != webhookplugins.Custom {
		t.Fatalf("verify input %+v", seen)
	}
	status(t, call("forged", "d2"), 401)
	if e.state(t, webhookplugins.Custom).LastRefusal != plugins.RefusalVerifyFailed {
		t.Fatal("failure not recorded")
	}

	e.hooks.SetVerify(func(context.Context, *plugin.Services, plugin.WebhookVerification) error { panic("boom") })
	status(t, call("valid", "d3"), 401)
	if e.state(t, webhookplugins.Custom).LastRefusal != plugins.RefusalVerifyPanic {
		t.Fatal("panic not recorded")
	}

	release := make(chan struct{})
	e.hooks.SetVerify(func(context.Context, *plugin.Services, plugin.WebhookVerification) error {
		<-release
		return nil
	})
	started := time.Now()
	status(t, call("valid", "d4"), 401)
	close(release)
	if elapsed := time.Since(started); elapsed < plugin.WebhookVerifyTimeout || elapsed > 3*plugin.WebhookVerifyTimeout {
		t.Fatalf("verify timeout after %s", elapsed)
	}
	if e.state(t, webhookplugins.Custom).LastRefusal != plugins.RefusalVerifyTimeout {
		t.Fatal("timeout not recorded")
	}

	// The verify hook may not reach the network: the host refuses
	// http.fetch@1 inside it.
	var fetchErr error
	e.hooks.SetVerify(func(ctx context.Context, services *plugin.Services, _ plugin.WebhookVerification) error {
		_, fetchErr = services.Fetch(ctx, plugin.HTTPRequest{Connection: uuid.New(), Method: http.MethodGet, URL: "https://provider.example/verify"})
		return fetchErr
	})
	status(t, call("valid", "d5"), 401)
	var denial *plugin.ServiceDenial
	if !errors.As(fetchErr, &denial) || denial.Kind != "forbidden_context" {
		t.Fatalf("fetch inside verify: %v", fetchErr)
	}
	if e.queued(t, webhookplugins.Custom) != 1 {
		t.Fatal("only the verified request is queued")
	}
}

func TestFetchBack(t *testing.T) {
	e := newHookEnv(t)
	event := func(id string) []byte {
		return []byte(`{"value":[{"id":"` + id + `","clientState":"secret-ish","resource":"Users/1/Events/2"}]}`)
	}
	status(t, e.h.Webhook(webhookplugins.Graph, pluginharness.WebhookCall{Body: event("AAMkAD-1"),
		Header: http.Header{"X-Anything": {"dropped"}}}), 202)
	var payload []byte
	var metadata string
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT payload, metadata::text FROM plugin_deliveries WHERE source=$1`, webhookplugins.Graph).Scan(&payload, &metadata); err != nil {
		t.Fatal(err)
	}
	if len(payload) != 0 || strings.Contains(metadata, "clientState") || strings.Contains(metadata, "Users/1") || !strings.Contains(metadata, "AAMkAD-1") {
		t.Fatalf("stored %q %s: only the event ID is kept", payload, metadata)
	}
	e.h.Deliver()
	got := e.hooks.Received(webhookplugins.Graph)
	if len(got) != 1 || got[0].Webhook.EventID != "AAMkAD-1" || got[0].Webhook.Body != nil || got[0].Webhook.Headers != nil {
		t.Fatalf("delivery %+v", got)
	}
	for name, body := range map[string][]byte{
		"pattern":   event("has space"),
		"too long":  event(strings.Repeat("a", 65)),
		"missing":   []byte(`{"value":[]}`),
		"not json":  []byte(`nope`),
		"not plain": event("a/b"),
	} {
		if got := e.h.Webhook(webhookplugins.Graph, pluginharness.WebhookCall{Body: body, RemoteAddr: "198.51.100.1:1"}); got.Status != 400 || got.Code != "invalid_event_id" {
			t.Fatalf("%s: %+v", name, got)
		}
	}
	status(t, e.h.Webhook(webhookplugins.Graph, pluginharness.WebhookCall{Body: event("AAMkAD-1")}), 202)
	if e.queued(t, webhookplugins.Graph) != 0 || len(e.hooks.Received(webhookplugins.Graph)) != 1 {
		t.Fatal("a repeated event ID was queued")
	}
	// The per-address limit, process-local and keyed by the direct address.
	limited := false
	for i := 0; i < 61; i++ {
		got := e.h.Webhook(webhookplugins.Graph, pluginharness.WebhookCall{Body: event(fmt.Sprintf("burst-%d", i)), RemoteAddr: "203.0.113.7:9"})
		if got.Status == 429 {
			limited = i == 60
			if got.RetryAfter == 0 {
				t.Fatal("429 names Retry-After")
			}
		}
	}
	if !limited {
		t.Fatal("the 61st request from one address in a minute was not limited")
	}
	status(t, e.h.Webhook(webhookplugins.Graph, pluginharness.WebhookCall{Body: event("other-address"), RemoteAddr: "203.0.113.8:9"}), 202)
	var addresses int
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM plugin_deliveries WHERE metadata::text LIKE '%203.0.113%'`).Scan(&addresses); err != nil || addresses != 0 {
		t.Fatal("an address was stored")
	}
}

func TestEchoQueryHandshake(t *testing.T) {
	e := newHookEnv(t)
	got := e.h.Webhook(webhookplugins.Graph, pluginharness.WebhookCall{Query: url.Values{"validationToken": {"Validation: Token <b>1</b>"}}})
	status(t, got, 200)
	if string(got.Handshake) != "Validation: Token <b>1</b>" {
		t.Fatalf("handshake %q", got.Handshake)
	}
	status(t, e.h.Webhook(webhookplugins.Graph, pluginharness.WebhookCall{Query: url.Values{"validationToken": {strings.Repeat("a", 513)}}}), 400)
	e.h.Deliver()
	if e.queued(t, webhookplugins.Graph) != 0 || len(e.hooks.Received()) != 0 {
		t.Fatal("a handshake queued work or ran the plugin")
	}
}

func TestPendingBoundPerWebhook(t *testing.T) {
	e := newHookEnv(t)
	token := e.h.CreateWebhookToken(webhookplugins.DoorsTwo, "Bulk")
	if _, err := e.h.Pool.Exec(e.h.Ctx, `INSERT INTO plugin_deliveries(id,plugin_id,definition_version,installed_at,kind,source,subject,payload,due_at,next_attempt_at)
		SELECT gen_random_uuid(),$1,1,(SELECT installed_at FROM plugin_installations WHERE plugin_id=$1),'webhook',$2,'webhook:'||$2,''::bytea,$3,$3
		FROM generate_series(1,$4)`, webhookplugins.ID, webhookplugins.DoorsTwo, e.clock.Now(), plugins.MaxPendingWebhookDeliveries-1); err != nil {
		t.Fatal(err)
	}
	header := http.Header{"Authorization": {"Bearer " + token.Token}}
	status(t, e.h.Webhook(webhookplugins.DoorsTwo, pluginharness.WebhookCall{Header: header, Body: []byte("{}")}), 202)
	full := e.h.Webhook(webhookplugins.DoorsTwo, pluginharness.WebhookCall{Header: header, Body: []byte("{}")})
	status(t, full, 503)
	if e.state(t, webhookplugins.DoorsTwo).LastRefusal != plugins.RefusalQueueFull {
		t.Fatal("queue_full not recorded")
	}
	// Another webhook of the plugin has its own bound.
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("x")), 200)
}

func TestNoAcknowledgementWithoutDurableEnqueue(t *testing.T) {
	e := newHookEnv(t)
	if _, err := e.h.Pool.Exec(e.h.Ctx, `CREATE OR REPLACE FUNCTION harness_refuse_webhook() RETURNS trigger AS $$
		BEGIN RAISE EXCEPTION 'refused'; END $$ LANGUAGE plpgsql;
		CREATE TRIGGER harness_refuse_webhook BEFORE INSERT ON plugin_deliveries FOR EACH ROW EXECUTE FUNCTION harness_refuse_webhook();`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = e.h.Pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS harness_refuse_webhook ON plugin_deliveries; DROP FUNCTION IF EXISTS harness_refuse_webhook()`)
	})
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("rolled-back")), 503)
	if receiptCount(t, e) != 0 || e.state(t, webhookplugins.Changes).AcceptedCount != 0 {
		t.Fatal("a rolled-back request left a receipt or a count")
	}
	if _, err := e.h.Pool.Exec(e.h.Ctx, `DROP TRIGGER harness_refuse_webhook ON plugin_deliveries`); err != nil {
		t.Fatal(err)
	}
	// The provider's retry of the same delivery is accepted.
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("rolled-back")), 200)
	if e.queued(t, webhookplugins.Changes) != 1 {
		t.Fatal("the retry was not queued")
	}
}

func TestWebhookRetryKeepsTheDeliveryID(t *testing.T) {
	e := newHookEnv(t)
	failures := 1
	e.hooks.SetHandle(func(context.Context, plugin.Webhook) error {
		if failures > 0 {
			failures--
			return errors.New("provider down")
		}
		return nil
	})
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("retry")), 200)
	e.h.Deliver()
	e.clock.advance(10 * time.Second)
	e.h.Deliver()
	got := e.hooks.Received(webhookplugins.Changes)
	if len(got) != 2 || got[0].Webhook.DeliveryID != got[1].Webhook.DeliveryID || got[0].Webhook.Attempt != 1 || got[1].Webhook.Attempt != 2 {
		t.Fatalf("attempts %+v", got)
	}
	if e.queued(t, webhookplugins.Changes) != 0 {
		t.Fatal("the delivered request is still queued")
	}
}

func TestUndeclaredWebhookStateIsReconciled(t *testing.T) {
	e := newHookEnv(t)
	for _, statement := range []string{
		`INSERT INTO plugin_webhook_tokens(id,plugin_id,webhook_id,name,public_id,secret_hash) VALUES(gen_random_uuid(),$1,'retired','Old','0123456789abcdef01234567',decode(repeat('00',32),'hex'))`,
		`INSERT INTO plugin_webhook_receipts(plugin_id,webhook_id,external_id,delivery_id,received_at,expires_at) VALUES($1,'retired','x',gen_random_uuid(),now(),now()+interval '1 day')`,
		`INSERT INTO plugin_webhook_status(plugin_id,webhook_id,accepted_count) VALUES($1,'retired',3)`,
		`INSERT INTO plugin_deliveries(id,plugin_id,definition_version,installed_at,kind,source,subject,payload,due_at,next_attempt_at)
			VALUES(gen_random_uuid(),$1,1,(SELECT installed_at FROM plugin_installations WHERE plugin_id=$1),'webhook','retired','webhook:retired','{}'::bytea,now()-interval '1 minute',now()-interval '1 minute')`,
	} {
		if _, err := e.h.Pool.Exec(e.h.Ctx, statement, webhookplugins.ID); err != nil {
			t.Fatal(err)
		}
	}
	e.h.SweepWebhooks()
	for _, table := range []string{"plugin_webhook_tokens", "plugin_webhook_receipts", "plugin_webhook_status"} {
		var count int
		if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM `+table+` WHERE webhook_id='retired'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s keeps a retired webhook", table)
		}
	}
	e.h.Deliver()
	if len(e.hooks.Received()) != 0 || e.queued(t, "retired") != 0 {
		t.Fatal("a delivery of an undeclared webhook ran or stayed")
	}
}

func TestPluginRemovalCleansWebhookState(t *testing.T) {
	e := newHookEnv(t)
	token := e.h.CreateWebhookToken(webhookplugins.Doors, "Panel")
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("before-removal")), 200)
	if err := e.h.Remove(); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"plugin_webhook_tokens", "plugin_webhook_receipts", "plugin_webhook_status", "plugin_deliveries"} {
		var count int
		if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM `+table+` WHERE plugin_id=$1`, webhookplugins.ID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s keeps %d rows after removal", table, count)
		}
	}
	e.h.Install()
	status(t, e.h.Webhook(webhookplugins.Doors, pluginharness.WebhookCall{Body: []byte("{}"),
		Header: http.Header{"Authorization": {"Bearer " + token.Token}, "X-Event-Id": {"x"}}}), 401)
	e.h.Deliver()
	if len(e.hooks.Received()) != 0 {
		t.Fatal("work of the previous installation ran")
	}
	// A delivery ID accepted before removal is new to the reinstallation.
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("before-removal")), 200)
	if e.queued(t, webhookplugins.Changes) != 1 {
		t.Fatal("the reinstallation inherited a receipt")
	}
}

func TestPublicWebhooksAreRefused(t *testing.T) {
	manifest := `{"apiVersion":3,"id":"public_hooks","definitionVersion":1,"name":"Public","description":"x","category":"Workflow",
		"icon":"puzzle","maintainers":["@gbyo"],"instanceNoun":{"singular":"item","plural":"items"},
		"webhooks":[{"id":"photos","title":"Photos","authentication":"public"}]}`
	if _, err := plugin.ParseManifest([]byte(manifest)); err == nil || !strings.Contains(err.Error(), "public") {
		t.Fatalf("public webhook accepted: %v", err)
	}
}

func TestWebhookSecretsStayOutOfLogsStatusAndAudit(t *testing.T) {
	e := newHookEnv(t)
	token := e.h.CreateWebhookToken(webhookplugins.Doors, "Panel")
	secret := token.Token[strings.LastIndex(token.Token, ".")+1:]
	marker := "BODY-MARKER-7731"
	status(t, e.h.Webhook(webhookplugins.Doors, pluginharness.WebhookCall{Body: []byte(`{"m":"` + marker + `"}`),
		Header: http.Header{"Authorization": {"Bearer " + token.Token}, "X-Event-Id": {"1"}}}), 202)
	status(t, e.h.Webhook(webhookplugins.Doors, pluginharness.WebhookCall{Body: []byte(`{"m":"` + marker + `"}`),
		Header: http.Header{"Authorization": {"Bearer tch_" + token.PublicID + ".wrong-" + secret}, "X-Event-Id": {"2"}}}), 401)
	bad := pcoCall("bad")
	signature := bad.Header.Get("X-Pco-Webhooks-Authenticity")
	bad.Body = append(bad.Body, ' ')
	status(t, e.h.Webhook(webhookplugins.Changes, bad), 401)
	status(t, e.h.Webhook(webhookplugins.Changes, pcoCall("good")), 200)

	pluginStatus, _ := json.Marshal(e.h.StatusOf(webhookplugins.ID))
	webhooks, _ := json.Marshal(e.h.Webhooks())
	var audit, metadata string
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT COALESCE(string_agg(metadata::text, ' '),'') FROM audit_logs`).Scan(&audit); err != nil {
		t.Fatal(err)
	}
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT COALESCE(string_agg(metadata::text, ' '),'') FROM plugin_deliveries`).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"logs": e.logs.String(), "status": string(pluginStatus), "webhooks": string(webhooks), "audit": audit, "queue metadata": metadata} {
		for _, sensitive := range []string{secret, token.Token, pcoSecret, signature, marker, "should-never-be-kept", "tilecast_session"} {
			if strings.Contains(text, sensitive) {
				t.Fatalf("%s holds %q", name, sensitive)
			}
		}
	}
	if !strings.Contains(e.logs.String(), "plugin webhook request refused") {
		t.Fatal("a refusal is logged with its code")
	}
}
