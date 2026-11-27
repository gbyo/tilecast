package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/apps/server/internal/webhookauth"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Inbound webhooks of Plugin Manifest API 3 (docs/plugin-webhooks.md).
//
// The host owns POST /api/v1/hooks/{pluginId}/{webhookId}. For each request
// it resolves the declaration, answers a host handshake, reads at most
// 64 KiB, authenticates the request in the declared mode, and then, in one
// transaction, inserts the replay receipt and queues the request on the
// shared delivery engine. It answers the declared 200 or 202 only after
// that transaction commits. HandleWebhook runs later in the system context.

// Webhook bounds of the host.
const (
	// MaxPendingWebhookDeliveries bounds the undelivered requests of one
	// webhook. A provider that sends faster than the plugin handles gets
	// 503 and retries; the queue of one endpoint never grows without
	// bound. Five hundred is many minutes of provider traffic at the
	// delivery engine's pace for one subject.
	MaxPendingWebhookDeliveries = 500
	// fetchBackAddressLimit bounds the fetch-back requests of one directly
	// connected address in fetchBackAddressWindow. Fetch-back requests are
	// anonymous, so this keeps one sender from filling the queue.
	fetchBackAddressLimit  = 60
	fetchBackAddressWindow = time.Minute
	// refusalWriteInterval throttles the status write of a refused
	// request, so anonymous junk does not turn into a write for every
	// request.
	refusalWriteInterval = time.Minute
	// webhookUnavailableRetry is the Retry-After of a 503.
	webhookUnavailableRetry = 60
)

// Refusal codes. Status shows them; the HTTP answer of each authentication
// refusal is the same.
const (
	RefusalTokenInvalid            = "token_invalid"
	RefusalSigningSecretUnset      = "signing_secret_unavailable"
	RefusalSigningSecretUnusable   = "signing_secret_unusable"
	RefusalVerifyFailed            = "verify_failed"
	RefusalVerifyTimeout           = "verify_timeout"
	RefusalVerifyPanic             = "verify_panic"
	RefusalEventIDInvalid          = "event_id_invalid"
	RefusalDeliveryIDMissing       = "delivery_id_missing"
	RefusalRateLimited             = "rate_limited"
	RefusalQueueFull               = "queue_full"
	RefusalHeaderTooLarge          = "header_too_large"
	RefusalBodyTooLarge            = "body_too_large"
	RefusalHandshakeValueTooLarge  = "handshake_value_too_large"
	RefusalSignatureMissing        = webhookauth.CodeSignatureMissing
	RefusalSignatureInvalid        = webhookauth.CodeSignatureInvalid
	RefusalTimestampMissing        = webhookauth.CodeTimestampMissing
	RefusalTimestampOutOfRange     = webhookauth.CodeTimestampOutOfSpan
	RefusalStandardDeliveryMissing = webhookauth.CodeDeliveryIDMissing
)

// WebhookRequest is one inbound request as the HTTP handler passes it. The
// handler passes the connection's own remote address and never a proxy
// header.
type WebhookRequest struct {
	PluginID      string
	WebhookID     string
	Method        string
	Header        http.Header
	Query         url.Values
	ContentLength int64
	Body          io.Reader
	RemoteAddr    string
}

// WebhookResponse is the host's answer. Error answers carry a code and a
// message for the JSON error envelope; a handshake answer carries a
// text/plain body; an acknowledgement carries only a status.
type WebhookResponse struct {
	Status     int
	Code       string
	Message    string
	Handshake  []byte
	RetryAfter int
	Allow      string
}

func webhookError(status int, code, message string) WebhookResponse {
	return WebhookResponse{Status: status, Code: code, Message: message}
}

var (
	webhookNotFound = webhookError(http.StatusNotFound, "not_found", "The webhook was not found.")
	// One answer for every authentication failure: a sender learns
	// nothing about how close it was.
	webhookUnauthenticated = webhookError(http.StatusUnauthorized, "unauthenticated", "The webhook request is not authenticated.")
)

func webhookUnavailable(message string) WebhookResponse {
	response := webhookError(http.StatusServiceUnavailable, "webhook_unavailable", message)
	response.RetryAfter = webhookUnavailableRetry
	return response
}

// webhookMetadata is the queue metadata of a webhook delivery. It never
// holds a credential, a signature, or an address.
type webhookMetadata struct {
	ReceivedAt time.Time         `json:"receivedAt"`
	ExternalID string            `json:"externalId,omitempty"`
	EventID    string            `json:"eventId,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
}

// ReceiveWebhook handles one inbound request.
func (s *Service) ReceiveWebhook(ctx context.Context, request WebhookRequest) WebhookResponse {
	hosted, ok := s.hostedPlugin(request.PluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return webhookNotFound
	}
	declaration, ok := hosted.manifest.WebhookByID(request.WebhookID)
	if _, handles := hosted.plugin.(plugin.WebhookHandler); !ok || !handles {
		return webhookNotFound
	}
	if request.Method != http.MethodPost {
		response := webhookError(http.StatusMethodNotAllowed, "method_not_allowed", "A webhook takes POST.")
		response.Allow = http.MethodPost
		return response
	}
	installed, err := s.pluginInstalled(ctx, request.PluginID)
	if err != nil {
		return webhookUnavailable("The webhook is temporarily unavailable.")
	}
	if !installed {
		return webhookNotFound
	}
	receiver := webhookReceiver{service: s, hosted: hosted, declaration: declaration, request: request}
	return receiver.receive(ctx)
}

type webhookReceiver struct {
	service     *Service
	hosted      hostedPlugin
	declaration plugin.WebhookDeclaration
	request     WebhookRequest
}

func (r webhookReceiver) receive(ctx context.Context) WebhookResponse {
	d := r.declaration
	// An echo-query handshake carries no authentication and runs no plugin
	// code: the host returns the one declared query parameter.
	if d.Handshake != nil && d.Handshake.Type == plugin.HandshakeEchoQuery && r.request.Query.Has(d.Handshake.Parameter) {
		value := r.request.Query.Get(d.Handshake.Parameter)
		if value == "" || len(value) > plugin.MaxWebhookHandshakeBytes || !utf8.ValidString(value) {
			return r.refuse(ctx, RefusalHandshakeValueTooLarge, webhookError(http.StatusBadRequest, "invalid_handshake", "The handshake value is missing or too long."))
		}
		return WebhookResponse{Status: http.StatusOK, Handshake: []byte(value)}
	}
	if r.request.ContentLength > plugin.MaxWebhookBodyBytes {
		return r.refuse(ctx, RefusalBodyTooLarge, bodyTooLarge())
	}
	body, err := readWebhookBody(r.request.Body, r.request.ContentLength)
	if errors.Is(err, errWebhookBodyTooLarge) {
		return r.refuse(ctx, RefusalBodyTooLarge, bodyTooLarge())
	}
	if err != nil {
		return webhookError(http.StatusBadRequest, "invalid_body", "The request body could not be read.")
	}
	forwarded, ok := r.forwardedHeaders()
	if !ok {
		return r.refuse(ctx, RefusalHeaderTooLarge, webhookError(http.StatusBadRequest, "header_too_large", "A forwarded header is too long."))
	}
	var externalID, eventID string
	switch d.Authentication {
	case plugin.WebhookAuthToken:
		if !r.service.authenticateWebhookToken(ctx, r.hosted.manifest.ID, d.ID, r.request.Header.Get("Authorization")) {
			return r.refuse(ctx, RefusalTokenInvalid, webhookUnauthenticated)
		}
	case plugin.WebhookAuthSignature:
		id, refusal, response := r.verifySignature(ctx, body)
		if refusal != "" {
			return r.refuse(ctx, refusal, response)
		}
		externalID = id
		// An echo-json handshake is answered only after a valid
		// signature, and runs no plugin code.
		if h := d.Handshake; h != nil && h.Type == plugin.HandshakeEchoJSON {
			if value, found := webhookauth.Pointer(body, h.Pointer); found {
				if len(value) > plugin.MaxWebhookHandshakeBytes || !utf8.ValidString(value) {
					return r.refuse(ctx, RefusalHandshakeValueTooLarge, webhookError(http.StatusBadRequest, "invalid_handshake", "The handshake value is too long."))
				}
				return WebhookResponse{Status: http.StatusOK, Handshake: []byte(value)}
			}
		}
	case plugin.WebhookAuthFetchBack:
		if !r.service.fetchBackAddresses().allow(directAddress(r.request.RemoteAddr), r.service.clock.Now()) {
			response := webhookError(http.StatusTooManyRequests, "rate_limited", "Too many webhook requests. Try again later.")
			response.RetryAfter = int(fetchBackAddressWindow / time.Second)
			return r.refuse(ctx, RefusalRateLimited, response)
		}
		id, found := webhookauth.Pointer(body, d.FetchBack.EventID)
		if !found || !d.FetchBack.FetchBackEventIDValid(id) {
			return r.refuse(ctx, RefusalEventIDInvalid, webhookError(http.StatusBadRequest, "invalid_event_id", "The request carries no valid event ID."))
		}
		// The host keeps the event ID and nothing else of an anonymous
		// request.
		eventID, externalID, body, forwarded = id, id, nil, nil
	default:
		return webhookNotFound
	}
	if externalID == "" && d.DeliveryID != nil {
		externalID = r.deliveryID(body)
		if externalID == "" {
			return r.refuse(ctx, RefusalDeliveryIDMissing, webhookError(http.StatusBadRequest, "delivery_id_missing", "The request carries no valid delivery ID."))
		}
	}
	return r.accept(ctx, externalID, eventID, body, forwarded)
}

func bodyTooLarge() WebhookResponse {
	return webhookError(http.StatusRequestEntityTooLarge, "body_too_large", fmt.Sprintf("A webhook body is at most %d bytes.", plugin.MaxWebhookBodyBytes))
}

var errWebhookBodyTooLarge = errors.New("webhook body too large")

// readWebhookBody reads at most MaxWebhookBodyBytes. It stops reading at
// one byte more, and it never allocates beyond the limit, whatever the
// request declares.
func readWebhookBody(body io.Reader, declared int64) ([]byte, error) {
	if body == nil {
		return []byte{}, nil
	}
	capacity := int64(4096)
	if declared > 0 && declared <= plugin.MaxWebhookBodyBytes {
		capacity = declared
	}
	buffer := make([]byte, 0, capacity)
	limited := io.LimitReader(body, plugin.MaxWebhookBodyBytes+1)
	for {
		if len(buffer) == cap(buffer) {
			grown := min(2*cap(buffer), plugin.MaxWebhookBodyBytes+1)
			buffer = append(make([]byte, 0, grown), buffer...)
		}
		n, err := limited.Read(buffer[len(buffer):cap(buffer)])
		buffer = buffer[:len(buffer)+n]
		if len(buffer) > plugin.MaxWebhookBodyBytes {
			return nil, errWebhookBodyTooLarge
		}
		if errors.Is(err, io.EOF) {
			return buffer, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

// forwardedHeaders keeps the declared forwardHeaders the request carries.
// A value longer than the bound refuses the request.
func (r webhookReceiver) forwardedHeaders() (map[string]string, bool) {
	if len(r.declaration.ForwardHeaders) == 0 {
		return nil, true
	}
	out := map[string]string{}
	for _, name := range r.declaration.ForwardHeaders {
		value := r.request.Header.Get(name)
		if value == "" {
			continue
		}
		if len(value) > plugin.MaxWebhookHeaderValueBytes || !utf8.ValidString(value) {
			return nil, false
		}
		out[http.CanonicalHeaderKey(name)] = value
	}
	return out, true
}

func (r webhookReceiver) deliveryID(body []byte) string {
	id := r.declaration.DeliveryID
	var value string
	if id.Header != "" {
		value = strings.TrimSpace(r.request.Header.Get(id.Header))
	} else {
		value, _ = webhookauth.Pointer(body, id.Pointer)
	}
	if !webhookauth.ValidDeliveryID(value) {
		return ""
	}
	return value
}

// verifySignature authenticates a signature webhook. It returns the
// provider's delivery ID of a standard-webhooks request, or a refusal code
// and its answer.
func (r webhookReceiver) verifySignature(ctx context.Context, body []byte) (string, string, WebhookResponse) {
	signature := r.declaration.Signature
	now := r.service.clock.Now()
	if signature.Scheme == plugin.SignatureVerify {
		if refusal := r.service.runVerifier(ctx, r.hosted, r.declaration, body, r.request.Header); refusal != "" {
			return "", refusal, webhookUnauthenticated
		}
		return "", "", WebhookResponse{}
	}
	secret, err := r.service.webhookSecret(ctx, r.hosted.manifest.ID, signature.Secret)
	if err != nil {
		// Unset, cleared, or not readable after a restore: fail closed and
		// let the provider retry until an operator enters it.
		return "", RefusalSigningSecretUnset, webhookUnavailable("The webhook's signing secret is not set.")
	}
	var id string
	switch signature.Scheme {
	case plugin.SignatureStandardWebhooks:
		id, err = webhookauth.Standard(secret, r.request.Header, body, now)
	default:
		endpoint, _ := r.service.webhookEndpoint(r.hosted.manifest.ID, r.declaration.ID)
		err = webhookauth.HMAC(*signature, secret, r.request.Header, endpoint, body, now)
	}
	var failure *webhookauth.Failure
	switch {
	case err == nil:
		return id, "", WebhookResponse{}
	case errors.As(err, &failure):
		return "", failure.Code, webhookUnauthenticated
	case errors.Is(err, webhookauth.ErrSecretUnusable):
		return "", RefusalSigningSecretUnusable, webhookUnavailable("The webhook's signing secret cannot be used.")
	}
	return "", RefusalSignatureInvalid, webhookUnauthenticated
}

// webhookSecret reads an organization secret setting of the plugin.
func (s *Service) webhookSecret(ctx context.Context, pluginID, key string) (string, error) {
	if s.secrets == nil {
		return "", pluginsecrets.ErrUnavailable
	}
	organizationID, err := s.organizationID(ctx)
	if err != nil {
		return "", err
	}
	value, err := s.secrets.Read(ctx, s.db, pluginsecrets.SecretRef{PluginID: pluginID, OwnerType: pluginsecrets.OwnerOrganization, OwnerID: organizationID, Key: key})
	if err != nil || value == "" {
		return "", pluginsecrets.ErrUnavailable
	}
	return value, nil
}

func (s *Service) organizationID(ctx context.Context) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&id)
	return id, err
}

func (s *Service) pluginInstalled(ctx context.Context, pluginID string) (bool, error) {
	var installed bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plugin_installations WHERE plugin_id=$1)`, pluginID).Scan(&installed)
	return installed, err
}

// runVerifier runs a verify hook for at most the verify time limit, in a
// system invocation that may not reach the network. An error, a panic, or
// the time limit refuses the request.
func (s *Service) runVerifier(ctx context.Context, hosted hostedPlugin, declaration plugin.WebhookDeclaration, body []byte, header http.Header) string {
	verifier, ok := hosted.plugin.(plugin.WebhookVerifier)
	if !ok {
		return RefusalVerifyFailed
	}
	headers := http.Header{}
	for _, name := range declaration.Signature.Headers {
		value := header.Get(name)
		if value == "" {
			continue
		}
		if len(value) > plugin.MaxWebhookSignatureHeaderBytes {
			return RefusalHeaderTooLarge
		}
		headers.Set(name, value)
	}
	endpoint, _ := s.webhookEndpoint(hosted.manifest.ID, declaration.ID)
	timeout := s.verifyTimeout
	if timeout <= 0 {
		timeout = plugin.WebhookVerifyTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	invocation, done := s.restrictedSystemInvocation(ctx, hosted.manifest.ID, InvocationRestrictions{DenyNetwork: true})
	// The invocation ends when this function returns, so a hook that
	// outlives its time limit can no longer call a service.
	defer done()
	result := make(chan string, 1)
	go func() {
		defer func() {
			if recover() != nil {
				result <- RefusalVerifyPanic
			}
		}()
		input := plugin.WebhookVerification{WebhookID: declaration.ID, Body: append([]byte(nil), body...), Headers: headers, EndpointURL: endpoint}
		if err := verifier.VerifyWebhook(invocation, input); err != nil {
			result <- RefusalVerifyFailed
			return
		}
		result <- ""
	}()
	select {
	case refusal := <-result:
		return refusal
	case <-ctx.Done():
		return RefusalVerifyTimeout
	}
}

var errWebhookQueueFull = errors.New("webhook queue full")

// accept stores the receipt and queues the delivery in one transaction,
// and answers the declared status only after it commits. A repeated
// external delivery ID answers the same status and queues nothing.
func (r webhookReceiver) accept(ctx context.Context, externalID, eventID string, body []byte, headers map[string]string) WebhookResponse {
	s, d := r.service, r.declaration
	pluginID := r.hosted.manifest.ID
	now := s.clock.Now().UTC()
	deliveryID := uuid.New()
	metadata, err := json.Marshal(webhookMetadata{ReceivedAt: now, ExternalID: externalID, EventID: eventID, Headers: headers})
	if err != nil {
		return webhookUnavailable("The webhook is temporarily unavailable.")
	}
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		// One accepting transaction of a webhook at a time, across every
		// Server process, so the pending bound holds.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('plugin-webhook:' || $1 || '/' || $2, 0))`, pluginID, d.ID); err != nil {
			return err
		}
		if externalID != "" {
			var stored uuid.UUID
			err := tx.QueryRow(ctx, `INSERT INTO plugin_webhook_receipts(plugin_id,webhook_id,external_id,delivery_id,received_at,expires_at)
				VALUES($1,$2,$3,$4,$5,$6)
				ON CONFLICT (plugin_id,webhook_id,external_id) DO UPDATE
				SET delivery_id=EXCLUDED.delivery_id, received_at=EXCLUDED.received_at, expires_at=EXCLUDED.expires_at
				WHERE plugin_webhook_receipts.expires_at <= EXCLUDED.received_at
				RETURNING delivery_id`, pluginID, d.ID, externalID, deliveryID, now, now.Add(d.ReplayRetention())).Scan(&stored)
			if errors.Is(err, pgx.ErrNoRows) {
				// A repeated delivery: count it and answer success.
				_, err = tx.Exec(ctx, `INSERT INTO plugin_webhook_status(plugin_id,webhook_id,duplicate_count,last_duplicate_at) VALUES($1,$2,1,$3)
					ON CONFLICT (plugin_id,webhook_id) DO UPDATE SET duplicate_count=plugin_webhook_status.duplicate_count+1, last_duplicate_at=EXCLUDED.last_duplicate_at`,
					pluginID, d.ID, now)
				return err
			}
			if err != nil {
				return err
			}
		}
		var pending int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM plugin_deliveries WHERE plugin_id=$1 AND kind=$2 AND source=$3 AND state='pending'`,
			pluginID, plugindelivery.KindWebhook, d.ID).Scan(&pending); err != nil {
			return err
		}
		if pending >= MaxPendingWebhookDeliveries {
			return errWebhookQueueFull
		}
		queued, err := plugindelivery.Enqueue(ctx, tx, plugindelivery.Item{
			ID: deliveryID, PluginID: pluginID, DefinitionVersion: r.hosted.manifest.DefinitionVersion,
			Kind: plugindelivery.KindWebhook, Source: d.ID, Subject: d.ID,
			Payload: body, Metadata: metadata, DueAt: now,
		})
		if err != nil {
			return err
		}
		if !queued {
			return ErrPluginNotFound
		}
		_, err = tx.Exec(ctx, `INSERT INTO plugin_webhook_status(plugin_id,webhook_id,accepted_count,last_accepted_at) VALUES($1,$2,1,$3)
			ON CONFLICT (plugin_id,webhook_id) DO UPDATE SET accepted_count=plugin_webhook_status.accepted_count+1, last_accepted_at=EXCLUDED.last_accepted_at`,
			pluginID, d.ID, now)
		return err
	})
	switch {
	case err == nil:
		return WebhookResponse{Status: d.Ack()}
	case errors.Is(err, errWebhookQueueFull):
		return r.refuse(ctx, RefusalQueueFull, webhookUnavailable("The webhook has too much undelivered work. Try again later."))
	case errors.Is(err, ErrPluginNotFound):
		return webhookNotFound
	}
	s.logger.Error("plugin webhook could not be queued", "plugin", pluginID, "webhook", d.ID, "error", err)
	return webhookUnavailable("The webhook is temporarily unavailable.")
}

// refuse records a refusal in the webhook's status, at most once a minute
// for the same code, and returns the answer.
func (r webhookReceiver) refuse(ctx context.Context, code string, response WebhookResponse) WebhookResponse {
	now := r.service.clock.Now().UTC()
	tag, err := r.service.db.Exec(ctx, `INSERT INTO plugin_webhook_status(plugin_id,webhook_id,last_refused_at,last_refusal) VALUES($1,$2,$3,$4)
		ON CONFLICT (plugin_id,webhook_id) DO UPDATE SET last_refused_at=EXCLUDED.last_refused_at, last_refusal=EXCLUDED.last_refusal
		WHERE plugin_webhook_status.last_refused_at IS NULL OR plugin_webhook_status.last_refusal IS DISTINCT FROM EXCLUDED.last_refusal
			OR plugin_webhook_status.last_refused_at < EXCLUDED.last_refused_at - $5::interval`,
		r.hosted.manifest.ID, r.declaration.ID, now, code, fmt.Sprintf("%d seconds", int(refusalWriteInterval/time.Second)))
	if err == nil && tag.RowsAffected() > 0 {
		// Logged at most once a minute for each code: never the body, a
		// header, a token, or the address.
		r.service.logger.Info("plugin webhook request refused", "plugin", r.hosted.manifest.ID, "webhook", r.declaration.ID, "reason", code)
	}
	return response
}

// webhookEndpoint is the exact public address of a webhook, built from
// TILECAST_PUBLIC_URL and never from a request header. It also reports
// whether that address is HTTPS.
func (s *Service) webhookEndpoint(pluginID, webhookID string) (string, bool) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(s.publicURL), "/"))
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(base.Scheme != "https" && base.Scheme != "http") {
		return "", false
	}
	return base.String() + "/api/v1/hooks/" + pluginID + "/" + webhookID, base.Scheme == "https"
}

// directAddress is the connection's own address without its port.
func directAddress(remote string) string {
	if addrPort, err := netip.ParseAddrPort(remote); err == nil {
		return addrPort.Addr().String()
	}
	return remote
}

// addressLimiter is a process-local fixed-window limit per address. It is
// never persisted, so no address is stored.
type addressLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	entries map[string]addressWindow
	swept   time.Time
}

type addressWindow struct {
	count   int
	resetAt time.Time
}

func (l *addressLimiter) allow(address string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = map[string]addressWindow{}
	}
	if !now.Before(l.swept.Add(l.window)) {
		for key, entry := range l.entries {
			if !now.Before(entry.resetAt) {
				delete(l.entries, key)
			}
		}
		l.swept = now
	}
	entry, ok := l.entries[address]
	if !ok || !now.Before(entry.resetAt) {
		l.entries[address] = addressWindow{count: 1, resetAt: now.Add(l.window)}
		return true
	}
	if entry.count >= l.limit {
		return false
	}
	entry.count++
	l.entries[address] = entry
	return true
}

func (s *Service) fetchBackAddresses() *addressLimiter {
	s.webhookLimiterOnce.Do(func() {
		if s.fetchBackLimiter == nil {
			s.fetchBackLimiter = &addressLimiter{limit: fetchBackAddressLimit, window: fetchBackAddressWindow}
		}
	})
	return s.fetchBackLimiter
}

// webhookDelivery turns a queued webhook into the hook's argument.
func webhookDelivery(delivery plugindelivery.Delivery) (plugin.Webhook, error) {
	var metadata webhookMetadata
	if err := json.Unmarshal(delivery.Metadata, &metadata); err != nil {
		return plugin.Webhook{}, err
	}
	webhook := plugin.Webhook{
		DeliveryID: delivery.ID.String(), WebhookID: delivery.Source, ReceivedAt: metadata.ReceivedAt,
		ExternalID: metadata.ExternalID, Headers: metadata.Headers, EventID: metadata.EventID, Attempt: delivery.Attempt,
	}
	if metadata.EventID == "" {
		webhook.Body = delivery.Payload
	}
	return webhook, nil
}
