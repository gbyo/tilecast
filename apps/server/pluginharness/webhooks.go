package pluginharness

import (
	"bytes"
	"io"
	"net/http"
	"net/url"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
)

// Inbound webhook helpers (docs/plugin-webhooks.md). A test sends a request
// to the host's webhook receiver as the HTTP handler does, with the
// harness's public address https://tilecast.example.

// PublicURL is the TILECAST_PUBLIC_URL of every harness.
const PublicURL = "https://tilecast.example"

// WebhookCall is one inbound request.
type WebhookCall struct {
	Method string
	Header http.Header
	Query  url.Values
	Body   []byte
	// Reader replaces Body, for a body that is not in memory.
	Reader        io.Reader
	ContentLength int64
	// RemoteAddr is the connection's address; the default is
	// 192.0.2.10:40000.
	RemoteAddr string
}

// WebhookEndpoint is the endpoint address Studio shows for a webhook of the
// plugin under test.
func (h *Harness) WebhookEndpoint(webhookID string) string {
	return PublicURL + "/api/v1/hooks/" + h.id + "/" + webhookID
}

// Webhook sends a request to a webhook of the plugin under test.
func (h *Harness) Webhook(webhookID string, call WebhookCall) plugins.WebhookResponse {
	return h.WebhookOf(h.id, webhookID, call)
}

// WebhookOf sends a request to a webhook of any hosted plugin.
func (h *Harness) WebhookOf(pluginID, webhookID string, call WebhookCall) plugins.WebhookResponse {
	if call.Method == "" {
		call.Method = http.MethodPost
	}
	if call.Header == nil {
		call.Header = http.Header{}
	}
	if call.RemoteAddr == "" {
		call.RemoteAddr = "192.0.2.10:40000"
	}
	body := call.Reader
	if body == nil {
		body = bytes.NewReader(call.Body)
		if call.ContentLength == 0 {
			call.ContentLength = int64(len(call.Body))
		}
	}
	return h.service.ReceiveWebhook(h.Ctx, plugins.WebhookRequest{
		PluginID: pluginID, WebhookID: webhookID, Method: call.Method, Header: call.Header,
		Query: call.Query, ContentLength: call.ContentLength, Body: body, RemoteAddr: call.RemoteAddr,
	})
}

// SetOrganizationSecret stores an organization secret setting of the plugin
// under test, as Studio's settings page does.
func (h *Harness) SetOrganizationSecret(key, value string) {
	h.t.Helper()
	err := pgx.BeginFunc(h.Ctx, h.Pool, func(tx pgx.Tx) error {
		return h.Secrets.WriteInTx(h.Ctx, tx, pluginsecrets.SecretRef{PluginID: h.id, OwnerType: pluginsecrets.OwnerOrganization, OwnerID: h.OrgID, Key: key}, value, &h.OwnerID)
	})
	if err != nil {
		h.t.Fatal(err)
	}
}

// LoseOrganizationSecretKey moves a secret to a data key wrapped by a key
// this installation does not hold, as after a restore without the key file
// that sealed it. The secret is stored and cannot be read.
func (h *Harness) LoseOrganizationSecretKey(key string) {
	dek := uuid.New()
	h.exec(`INSERT INTO plugin_secret_deks(id,kek_id,wrapped_key,state) VALUES($1,'restored-elsewhere',$2,'active')`, dek, bytes.Repeat([]byte{7}, 60))
	h.exec(`UPDATE plugin_secrets SET dek_id=$4 WHERE plugin_id=$1 AND owner_type='organization' AND owner_id=$2 AND setting_key=$3`,
		h.id, h.OrgID, key, dek)
}

// CreateWebhookToken creates a token for a token webhook of the plugin under
// test as the Owner, and returns it with its secret.
func (h *Harness) CreateWebhookToken(webhookID, name string) plugins.CreatedWebhookToken {
	h.t.Helper()
	token, err := h.service.CreateWebhookToken(h.Ctx, h.id, webhookID, name, h.OwnerID)
	if err != nil {
		h.t.Fatal(err)
	}
	return token
}

// Webhooks reads the Webhooks page state of the plugin under test.
func (h *Harness) Webhooks() []plugins.WebhookState {
	h.t.Helper()
	states, err := h.service.Webhooks(h.Ctx, h.id)
	if err != nil {
		h.t.Fatal(err)
	}
	return states
}

// SweepWebhooks runs the webhook sweep: expired receipts and the state of
// undeclared webhooks.
func (h *Harness) SweepWebhooks() int64 {
	h.t.Helper()
	removed, err := h.service.SweepWebhooks(h.Ctx)
	if err != nil {
		h.t.Fatal(err)
	}
	return removed
}
