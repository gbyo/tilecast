// Package webhookplugins holds a test-only Plugin Manifest API 3 plugin for
// inbound webhook conformance tests (docs/plugin-webhooks.md). It declares
// one webhook of each mode and scheme and records every delivery. It is
// never bundled with a release.
package webhookplugins

import (
	"context"
	"errors"
	"sync"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ID is the plugin ID.
const ID = "harness_hooks"

// Webhook IDs.
const (
	Doors    = "doors"
	DoorsTwo = "doors_two"
	Standard = "standard"
	Changes  = "changes"
	Pairs    = "pairs"
	Square   = "square"
	Custom   = "custom"
	Graph    = "graph"
)

// Secret settings.
const (
	SigningSecret  = "signingSecret"
	StandardSecret = "standardSecret"
)

const manifest = `{
  "apiVersion": 3,
  "id": "harness_hooks",
  "definitionVersion": 1,
  "name": "Harness Hooks",
  "description": "A test plugin with one inbound webhook of each mode.",
  "category": "Workflow",
  "icon": "webhook",
  "maintainers": ["@gbyo"],
  "instanceNoun": { "singular": "item", "plural": "items" },
  "server": { "entrypoint": "./plugin.go" },
  "services": ["http.fetch@1"],
  "settings": {
    "organization": [
      { "key": "signingSecret", "label": "Signing secret", "control": "secret" },
      { "key": "standardSecret", "label": "Standard Webhooks secret", "control": "secret" }
    ]
  },
  "connections": [{
    "id": "provider", "title": "Provider", "type": "http",
    "origins": ["https://provider.example"]
  }],
  "webhooks": [
    { "id": "doors", "title": "Doors", "authentication": "token",
      "deliveryId": { "header": "X-Event-Id" }, "forwardHeaders": ["X-Event-Type"] },
    { "id": "doors_two", "title": "Second doors", "authentication": "token" },
    { "id": "standard", "title": "Standard", "authentication": "signature",
      "signature": { "scheme": "standard-webhooks", "secret": "standardSecret" } },
    { "id": "changes", "title": "Changes", "authentication": "signature", "ackStatus": 200,
      "signature": { "scheme": "hmac-sha256", "secret": "signingSecret", "header": "X-PCO-Webhooks-Authenticity",
        "format": "plain", "encoding": "hex", "signedPayload": "body" },
      "deliveryId": { "pointer": "/data/0/id" }, "forwardHeaders": ["X-PCO-Webhooks-Event"] },
    { "id": "pairs", "title": "Pairs", "authentication": "signature",
      "signature": { "scheme": "hmac-sha256", "secret": "signingSecret", "header": "Example-Signature",
        "format": "pairs", "timestampKey": "t", "signatureKey": "v1", "encoding": "hex", "signedPayload": "timestamp.body" },
      "deliveryId": { "pointer": "/id" }, "handshake": { "type": "echo-json", "pointer": "/challenge" } },
    { "id": "square", "title": "URL signed", "authentication": "signature",
      "signature": { "scheme": "hmac-sha256", "secret": "signingSecret", "header": "x-square-hmacsha256-signature",
        "format": "plain", "encoding": "base64", "signedPayload": "url.body" },
      "deliveryId": { "pointer": "/event_id" } },
    { "id": "custom", "title": "Custom", "authentication": "signature",
      "signature": { "scheme": "verify", "headers": ["X-Custom-Signature"] },
      "deliveryId": { "header": "X-Custom-Delivery" } },
    { "id": "graph", "title": "Fetch back", "authentication": "fetch-back",
      "fetchBack": { "eventId": "/value/0/id", "pattern": "^[A-Za-z0-9-]{1,64}$" },
      "handshake": { "type": "echo-query", "parameter": "validationToken" } }
  ]
}`

// Received is one HandleWebhook call.
type Received struct {
	Webhook   plugin.Webhook
	Principal bool
	Deadline  bool
}

// Hooks records every webhook delivery. SetHandle and SetVerify decide
// deliveries and custom verifications.
type Hooks struct {
	plugin.Bundle
	mu       sync.Mutex
	services *plugin.Services
	received []Received
	verified int
	handle   func(ctx context.Context, webhook plugin.Webhook) error
	verify   func(ctx context.Context, services *plugin.Services, request plugin.WebhookVerification) error
}

// SetHandle decides each later delivery.
func (h *Hooks) SetHandle(handle func(ctx context.Context, webhook plugin.Webhook) error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.handle = handle
}

// SetVerify decides each later custom verification.
func (h *Hooks) SetVerify(verify func(ctx context.Context, services *plugin.Services, request plugin.WebhookVerification) error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.verify = verify
}

var (
	_ plugin.ServiceConsumer = (*Hooks)(nil)
	_ plugin.WebhookHandler  = (*Hooks)(nil)
	_ plugin.WebhookVerifier = (*Hooks)(nil)
)

// New returns the plugin.
func New() *Hooks { return &Hooks{Bundle: plugin.NewBundle([]byte(manifest), nil)} }

// UseServices receives the typed service client.
func (h *Hooks) UseServices(services *plugin.Services) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.services = services
}

// HandleWebhook records the delivery and runs the SetHandle function.
func (h *Hooks) HandleWebhook(ctx context.Context, webhook plugin.Webhook) error {
	_, principal := plugin.PrincipalFrom(ctx)
	_, deadline := ctx.Deadline()
	h.mu.Lock()
	h.received = append(h.received, Received{Webhook: webhook, Principal: principal, Deadline: deadline})
	handle := h.handle
	h.mu.Unlock()
	if handle != nil {
		return handle(ctx, webhook)
	}
	return nil
}

// ErrNotAuthentic is the default verifier's refusal.
var ErrNotAuthentic = errors.New("not authentic")

// VerifyWebhook runs the SetVerify function, or accepts X-Custom-Signature "valid".
func (h *Hooks) VerifyWebhook(ctx context.Context, request plugin.WebhookVerification) error {
	h.mu.Lock()
	h.verified++
	verify, services := h.verify, h.services
	h.mu.Unlock()
	if verify != nil {
		return verify(ctx, services, request)
	}
	if request.Headers.Get("X-Custom-Signature") != "valid" {
		return ErrNotAuthentic
	}
	return nil
}

// Received returns the deliveries so far, optionally of one webhook.
func (h *Hooks) Received(webhooks ...string) []Received {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []Received{}
	for _, item := range h.received {
		if len(webhooks) == 0 {
			out = append(out, item)
			continue
		}
		for _, id := range webhooks {
			if item.Webhook.WebhookID == id {
				out = append(out, item)
			}
		}
	}
	return out
}

// Verified counts VerifyWebhook calls.
func (h *Hooks) Verified() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.verified
}

// Reset forgets the deliveries and verifications so far.
func (h *Hooks) Reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.received, h.verified = nil, 0
}
