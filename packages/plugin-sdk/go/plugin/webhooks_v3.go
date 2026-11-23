package plugin

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Inbound webhooks of Plugin Manifest API 3 (docs/plugin-webhooks.md).
//
// A plugin declares each inbound endpoint. The host owns the endpoint
// /api/v1/hooks/{pluginId}/{webhookId}: it bounds the request, answers a
// declared handshake, authenticates the request, drops a repeated delivery,
// queues the request on the shared delivery engine, and only then answers
// the declared acknowledgement status. HandleWebhook runs later, in the
// system context. A plugin never registers a public HTTP route of its own.

// Webhook authentication modes. Phase 3 refuses the public mode: public
// input needs moderation, which is phase 4.
const (
	WebhookAuthToken     = "token"
	WebhookAuthSignature = "signature"
	WebhookAuthFetchBack = "fetch-back"
	// WebhookAuthPublic is named only so that a declaration of it gets an
	// explicit refusal.
	WebhookAuthPublic = "public"
)

// Signature schemes of a signature webhook.
const (
	SignatureStandardWebhooks = "standard-webhooks"
	SignatureHMACSHA256       = "hmac-sha256"
	// SignatureVerify runs the plugin's VerifyWebhook hook for a provider
	// that fits neither form.
	SignatureVerify = "verify"
)

// Header formats of an hmac-sha256 signature.
const (
	SignatureFormatPlain = "plain"
	SignatureFormatPairs = "pairs"
)

// Signature encodings of an hmac-sha256 signature.
const (
	SignatureEncodingHex    = "hex"
	SignatureEncodingBase64 = "base64"
)

// Signed strings of an hmac-sha256 signature.
const (
	SignedBody          = "body"
	SignedTimestampBody = "timestamp.body"
	SignedURLBody       = "url.body"
)

// Handshake types. The host answers a handshake itself; plugin code does not
// run.
const (
	HandshakeEchoQuery = "echo-query"
	HandshakeEchoJSON  = "echo-json"
)

// Acknowledgement statuses. A provider that retries every answer except 200
// (Planning Center) declares 200; the default is 202.
const (
	WebhookAck200     = 200
	WebhookAck202     = 202
	DefaultWebhookAck = WebhookAck202
)

// Webhook bounds.
const (
	// MaxWebhooks bounds the webhooks of one plugin. Each one is a separate
	// endpoint that anyone can reach, a separate install review item, and a
	// separate card on the Webhooks page. Eight matches the connection
	// bound: a provider integration needs one or two.
	MaxWebhooks = 8
	// MaxWebhookBodyBytes is the absolute raw request body limit. The host
	// stops reading at one byte more.
	MaxWebhookBodyBytes = 64 << 10
	// MaxWebhookHeaders bounds the forwarded headers and the headers a
	// verify hook receives.
	MaxWebhookHeaders = 8
	// MaxWebhookHeaderValueBytes bounds one retained header value.
	MaxWebhookHeaderValueBytes = 512
	// MaxWebhookPointerLength bounds a JSON Pointer of a declaration.
	MaxWebhookPointerLength = 128
	// MaxWebhookDeliveryIDBytes bounds an external delivery ID.
	MaxWebhookDeliveryIDBytes = 200
	// MaxWebhookEventIDBytes bounds a fetch-back event ID.
	MaxWebhookEventIDBytes = 128
	// MaxWebhookHandshakeBytes bounds a handshake value the host echoes.
	MaxWebhookHandshakeBytes = 512
	// MaxWebhookSignatures bounds the candidate signatures of one request,
	// for key rotation.
	MaxWebhookSignatures = 8
	// MaxWebhookSignatureHeaderBytes bounds a signature header.
	MaxWebhookSignatureHeaderBytes = 2048
	// WebhookTimestampTolerance is how far a signed timestamp may be from
	// the host clock, in the past or in the future.
	WebhookTimestampTolerance = 5 * time.Minute
	// WebhookVerifyTimeout is the time limit of a VerifyWebhook call.
	WebhookVerifyTimeout = time.Second
)

// Replay receipt retention. A delivery ID is kept for 24 hours when the
// signature covers a timestamp, because the timestamp check refuses an older
// copy after 5 minutes. Without a signed timestamp it is kept for 7 days.
const (
	ReplayRetentionTimestamped = 24 * time.Hour
	ReplayRetentionUntimed     = 7 * 24 * time.Hour
	ReplayRetentionFetchBack   = 24 * time.Hour
)

// FetchBackEventIDPattern is the broadest event ID a fetch-back webhook
// accepts. The host applies it and the declared pattern, so a declaration
// can only narrow it.
var FetchBackEventIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

var (
	webhookIDPattern       = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	webhookHeaderPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`)
	webhookParamPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)
	webhookPairKeyPattern  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,32}$`)
	webhookPrefixPattern   = regexp.MustCompile(`^[\x21-\x7e]{1,16}$`)
	webhookPointerPattern  = regexp.MustCompile(`^(/([^~/]|~[01])*)+$`)
	webhookSettingPattern  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
	maxFetchBackPatternLen = 200
)

// webhookDeniedHeaders are never forwarded to a plugin or a verify hook:
// credentials, hop-by-hop headers, and proxy headers. The host never derives
// trust or identity from them.
var webhookDeniedHeaders = set("authorization", "proxy-authorization", "cookie", "set-cookie",
	"connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection",
	"proxy-authenticate", "host", "content-length", "forwarded", "via", "x-real-ip", "true-client-ip",
	"cf-connecting-ip", "x-client-ip", "x-cluster-client-ip")

// WebhookHeaderDenied reports whether the host refuses to forward a header.
func WebhookHeaderDenied(name string) bool {
	lower := strings.ToLower(name)
	return webhookDeniedHeaders[lower] || strings.HasPrefix(lower, "x-forwarded-") || strings.HasPrefix(lower, "proxy-")
}

// WebhookDeclaration is one inbound endpoint of a plugin.
type WebhookDeclaration struct {
	// ID is the last segment of the endpoint. It never changes.
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Authentication is token, signature, or fetch-back.
	Authentication string `json:"authentication"`
	// AckStatus is 200 or 202, the status of an accepted or a repeated
	// delivery. The default is 202.
	AckStatus  int                          `json:"ackStatus,omitempty"`
	Handshake  *WebhookHandshake            `json:"handshake,omitempty"`
	Signature  *WebhookSignature            `json:"signature,omitempty"`
	DeliveryID *WebhookDeliveryID           `json:"deliveryId,omitempty"`
	FetchBack  *WebhookFetchBackDeclaration `json:"fetchBack,omitempty"`
	// ForwardHeaders are the request headers the plugin receives. No other
	// header is kept.
	ForwardHeaders []string `json:"forwardHeaders,omitempty"`
}

// WebhookHandshake is an endpoint check the host answers itself.
type WebhookHandshake struct {
	Type string `json:"type"`
	// Parameter is the query parameter an echo-query handshake returns.
	Parameter string `json:"parameter,omitempty"`
	// Pointer is the JSON Pointer of the string an echo-json handshake
	// returns, after the signature is valid.
	Pointer string `json:"pointer,omitempty"`
}

// WebhookSignature declares how the host verifies a signature webhook.
type WebhookSignature struct {
	Scheme string `json:"scheme"`
	// Secret is the key of the organization secret setting that holds the
	// signing secret. The plugin never receives it.
	Secret string `json:"secret,omitempty"`
	// hmac-sha256 members.
	Header          string `json:"header,omitempty"`
	Format          string `json:"format,omitempty"`
	TimestampHeader string `json:"timestampHeader,omitempty"`
	TimestampKey    string `json:"timestampKey,omitempty"`
	SignatureKey    string `json:"signatureKey,omitempty"`
	Prefix          string `json:"prefix,omitempty"`
	Encoding        string `json:"encoding,omitempty"`
	SignedPayload   string `json:"signedPayload,omitempty"`
	// Headers are the request headers a verify hook receives.
	Headers []string `json:"headers,omitempty"`
}

// WebhookDeliveryID names the provider's delivery ID: a header, or a JSON
// Pointer into the body. A standard-webhooks signature uses webhook-id.
type WebhookDeliveryID struct {
	Header  string `json:"header,omitempty"`
	Pointer string `json:"pointer,omitempty"`
}

// WebhookFetchBackDeclaration names the event ID of a fetch-back request.
type WebhookFetchBackDeclaration struct {
	// EventID is a JSON Pointer to the event ID in the body.
	EventID string `json:"eventId"`
	// Pattern is an anchored regular expression the event ID must match, in
	// addition to FetchBackEventIDPattern.
	Pattern string `json:"pattern"`
}

// Ack is the declared acknowledgement status.
func (w WebhookDeclaration) Ack() int {
	if w.AckStatus == 0 {
		return DefaultWebhookAck
	}
	return w.AckStatus
}

// RequiresPublicHTTPS reports whether a SaaS provider sends the requests, so
// the endpoint needs a public HTTPS address. A token webhook can serve a
// system on the local network.
func (w WebhookDeclaration) RequiresPublicHTTPS() bool { return w.Authentication != WebhookAuthToken }

// SignedTimestamp reports whether the signature covers a timestamp the host
// checks against its clock.
func (w WebhookDeclaration) SignedTimestamp() bool {
	if w.Authentication != WebhookAuthSignature || w.Signature == nil {
		return false
	}
	return w.Signature.Scheme == SignatureStandardWebhooks ||
		(w.Signature.Scheme == SignatureHMACSHA256 && w.Signature.SignedPayload == SignedTimestampBody)
}

// ReplayRetention is how long the host keeps a delivery ID of the webhook.
func (w WebhookDeclaration) ReplayRetention() time.Duration {
	switch {
	case w.Authentication == WebhookAuthFetchBack:
		return ReplayRetentionFetchBack
	case w.SignedTimestamp():
		return ReplayRetentionTimestamped
	}
	return ReplayRetentionUntimed
}

// SignatureHeaderName is the header that carries the signature, or "" for a
// verify hook.
func (w WebhookDeclaration) SignatureHeaderName() string {
	if w.Signature == nil {
		return ""
	}
	switch w.Signature.Scheme {
	case SignatureStandardWebhooks:
		return "webhook-signature"
	case SignatureHMACSHA256:
		return w.Signature.Header
	}
	return ""
}

// WebhookByID returns a declared webhook.
func (m Manifest) WebhookByID(id string) (WebhookDeclaration, bool) {
	for _, webhook := range m.Webhooks {
		if webhook.ID == id {
			return webhook, true
		}
	}
	return WebhookDeclaration{}, false
}

// ValidWebhookPointer reports whether a JSON Pointer is usable in a webhook
// declaration.
func ValidWebhookPointer(pointer string) bool {
	return len(pointer) <= MaxWebhookPointerLength && webhookPointerPattern.MatchString(pointer)
}

func (m Manifest) validateWebhooks() error {
	if len(m.Webhooks) > MaxWebhooks {
		return fmt.Errorf("webhooks declares %d webhooks; the limit is %d", len(m.Webhooks), MaxWebhooks)
	}
	secrets := map[string]bool{}
	if m.Settings != nil {
		for _, field := range m.Settings.Organization {
			if field.Control == "secret" {
				secrets[field.Key] = true
			}
		}
	}
	seen := map[string]bool{}
	for _, webhook := range m.Webhooks {
		if err := webhook.validate(secrets); err != nil {
			return err
		}
		if seen[webhook.ID] {
			return fmt.Errorf("webhook %q is declared twice", webhook.ID)
		}
		seen[webhook.ID] = true
	}
	return nil
}

func (w WebhookDeclaration) validate(secrets map[string]bool) error {
	if !webhookIDPattern.MatchString(w.ID) {
		return fmt.Errorf("invalid webhook id %q; use 1 to 40 lowercase letters, digits, and underscores", w.ID)
	}
	where := fmt.Sprintf("webhook %q", w.ID)
	if err := bounded(where+" title", w.Title, 80); err != nil {
		return err
	}
	if len(w.Description) > 280 {
		return fmt.Errorf("%s description is longer than 280 bytes", where)
	}
	if w.AckStatus != 0 && w.AckStatus != WebhookAck200 && w.AckStatus != WebhookAck202 {
		return fmt.Errorf("%s ackStatus must be 200 or 202", where)
	}
	switch w.Authentication {
	case WebhookAuthToken:
		if w.Signature != nil || w.FetchBack != nil {
			return fmt.Errorf("%s uses token authentication and declares signature or fetchBack", where)
		}
	case WebhookAuthSignature:
		if w.Signature == nil || w.FetchBack != nil {
			return fmt.Errorf("%s uses signature authentication; it needs signature and no fetchBack", where)
		}
		if err := w.Signature.validate(where, secrets); err != nil {
			return err
		}
		switch {
		case w.Signature.Scheme == SignatureStandardWebhooks && w.DeliveryID != nil:
			return fmt.Errorf("%s uses standard-webhooks, whose delivery ID is the webhook-id header; it declares no deliveryId", where)
		case w.Signature.Scheme != SignatureStandardWebhooks && w.DeliveryID == nil:
			return fmt.Errorf("%s needs a deliveryId: the host drops a repeated delivery by it", where)
		}
	case WebhookAuthFetchBack:
		if w.FetchBack == nil || w.Signature != nil || w.DeliveryID != nil {
			return fmt.Errorf("%s uses fetch-back authentication; it needs fetchBack and no signature or deliveryId", where)
		}
		if !ValidWebhookPointer(w.FetchBack.EventID) {
			return fmt.Errorf("%s fetchBack.eventId is not a JSON Pointer of at most %d bytes", where, MaxWebhookPointerLength)
		}
		if err := validFetchBackPattern(w.FetchBack.Pattern); err != nil {
			return fmt.Errorf("%s fetchBack.pattern: %v", where, err)
		}
	case WebhookAuthPublic:
		return fmt.Errorf("%s uses public authentication; public webhooks need moderation, which this release does not have", where)
	default:
		return fmt.Errorf("%s has unknown authentication %q", where, w.Authentication)
	}
	if w.DeliveryID != nil {
		id := w.DeliveryID
		switch {
		case (id.Header == "") == (id.Pointer == ""):
			return fmt.Errorf("%s deliveryId names a header or a pointer, not both", where)
		case id.Header != "" && (!webhookHeaderPattern.MatchString(id.Header) || WebhookHeaderDenied(id.Header)):
			return fmt.Errorf("%s deliveryId.header %q is not a header the host reads", where, id.Header)
		case id.Pointer != "" && !ValidWebhookPointer(id.Pointer):
			return fmt.Errorf("%s deliveryId.pointer is not a JSON Pointer of at most %d bytes", where, MaxWebhookPointerLength)
		}
	}
	if h := w.Handshake; h != nil {
		switch h.Type {
		case HandshakeEchoQuery:
			if !webhookParamPattern.MatchString(h.Parameter) || h.Pointer != "" {
				return fmt.Errorf("%s echo-query handshake needs a query parameter name and no pointer", where)
			}
		case HandshakeEchoJSON:
			if w.Authentication != WebhookAuthSignature {
				return fmt.Errorf("%s echo-json handshake needs signature authentication: the host answers it only after a valid signature", where)
			}
			if !ValidWebhookPointer(h.Pointer) || h.Parameter != "" {
				return fmt.Errorf("%s echo-json handshake needs a JSON Pointer and no parameter", where)
			}
		default:
			return fmt.Errorf("%s has unknown handshake %q", where, h.Type)
		}
	}
	if len(w.ForwardHeaders) > MaxWebhookHeaders {
		return fmt.Errorf("%s forwards %d headers; the limit is %d", where, len(w.ForwardHeaders), MaxWebhookHeaders)
	}
	signatureHeader := strings.ToLower(w.SignatureHeaderName())
	forwarded := map[string]bool{}
	for _, name := range w.ForwardHeaders {
		lower := strings.ToLower(name)
		switch {
		case !webhookHeaderPattern.MatchString(name), WebhookHeaderDenied(name):
			return fmt.Errorf("%s cannot forward header %q", where, name)
		case lower == signatureHeader || lower == "webhook-signature":
			return fmt.Errorf("%s cannot forward its signature header", where)
		case forwarded[lower]:
			return fmt.Errorf("%s forwards header %q twice", where, name)
		}
		forwarded[lower] = true
	}
	return nil
}

func (s WebhookSignature) validate(where string, secrets map[string]bool) error {
	empty := func(values ...string) bool {
		for _, value := range values {
			if value != "" {
				return false
			}
		}
		return true
	}
	hmacMembers := []string{s.Header, s.Format, s.TimestampHeader, s.TimestampKey, s.SignatureKey, s.Prefix, s.Encoding, s.SignedPayload}
	switch s.Scheme {
	case SignatureStandardWebhooks:
		if !empty(hmacMembers...) || len(s.Headers) > 0 {
			return fmt.Errorf("%s uses standard-webhooks; it declares only the secret", where)
		}
	case SignatureHMACSHA256:
		if len(s.Headers) > 0 {
			return fmt.Errorf("%s uses hmac-sha256; headers is a verify member", where)
		}
		if !webhookHeaderPattern.MatchString(s.Header) || WebhookHeaderDenied(s.Header) {
			return fmt.Errorf("%s signature header %q is not a header the host reads", where, s.Header)
		}
		if s.Encoding != SignatureEncodingHex && s.Encoding != SignatureEncodingBase64 {
			return fmt.Errorf("%s signature encoding must be hex or base64", where)
		}
		switch s.SignedPayload {
		case SignedBody, SignedTimestampBody, SignedURLBody:
		default:
			return fmt.Errorf("%s signedPayload must be body, timestamp.body, or url.body", where)
		}
		timestamped := s.SignedPayload == SignedTimestampBody
		switch s.Format {
		case SignatureFormatPlain:
			if s.TimestampKey != "" || s.SignatureKey != "" {
				return fmt.Errorf("%s plain format takes no timestampKey or signatureKey", where)
			}
			if timestamped != (s.TimestampHeader != "") {
				return fmt.Errorf("%s declares timestampHeader exactly when it signs timestamp.body", where)
			}
			if s.TimestampHeader != "" && (!webhookHeaderPattern.MatchString(s.TimestampHeader) || WebhookHeaderDenied(s.TimestampHeader)) {
				return fmt.Errorf("%s timestampHeader %q is not a header the host reads", where, s.TimestampHeader)
			}
		case SignatureFormatPairs:
			if s.TimestampHeader != "" {
				return fmt.Errorf("%s pairs format reads the timestamp from timestampKey", where)
			}
			if !webhookPairKeyPattern.MatchString(s.SignatureKey) {
				return fmt.Errorf("%s pairs format needs signatureKey", where)
			}
			if timestamped != (s.TimestampKey != "") {
				return fmt.Errorf("%s declares timestampKey exactly when it signs timestamp.body", where)
			}
			if s.TimestampKey != "" && (!webhookPairKeyPattern.MatchString(s.TimestampKey) || s.TimestampKey == s.SignatureKey) {
				return fmt.Errorf("%s timestampKey is invalid", where)
			}
		default:
			return fmt.Errorf("%s signature format must be plain or pairs", where)
		}
		if s.Prefix != "" && (!webhookPrefixPattern.MatchString(s.Prefix) || strings.ContainsAny(s.Prefix, ", ")) {
			return fmt.Errorf("%s signature prefix must be 1 to 16 visible characters without a comma", where)
		}
	case SignatureVerify:
		if !empty(append(hmacMembers, s.Secret)...) {
			return fmt.Errorf("%s uses a verify hook; it declares only headers, and the hook receives no secret from the host", where)
		}
		if len(s.Headers) > MaxWebhookHeaders {
			return fmt.Errorf("%s verify hook reads %d headers; the limit is %d", where, len(s.Headers), MaxWebhookHeaders)
		}
		seen := map[string]bool{}
		for _, name := range s.Headers {
			lower := strings.ToLower(name)
			if !webhookHeaderPattern.MatchString(name) || WebhookHeaderDenied(name) || seen[lower] {
				return fmt.Errorf("%s verify hook cannot read header %q", where, name)
			}
			seen[lower] = true
		}
		return nil
	default:
		return fmt.Errorf("%s has unknown signature scheme %q", where, s.Scheme)
	}
	if !webhookSettingPattern.MatchString(s.Secret) || !secrets[s.Secret] {
		return fmt.Errorf("%s signature secret %q is not a secret field of settings.organization", where, s.Secret)
	}
	return nil
}

func validFetchBackPattern(pattern string) error {
	if len(pattern) < 2 || len(pattern) > maxFetchBackPatternLen || !strings.HasPrefix(pattern, "^") || !strings.HasSuffix(pattern, "$") {
		return fmt.Errorf("use an anchored pattern of at most %d bytes", maxFetchBackPatternLen)
	}
	if _, err := regexp.Compile(pattern); err != nil {
		return fmt.Errorf("does not compile")
	}
	return nil
}

// FetchBackEventIDValid reports whether an event ID matches the broadest
// pattern and the declared one.
func (f WebhookFetchBackDeclaration) FetchBackEventIDValid(id string) bool {
	if !FetchBackEventIDPattern.MatchString(id) {
		return false
	}
	declared, err := regexp.Compile(f.Pattern)
	return err == nil && declared.MatchString(id)
}

// Webhook is one accepted inbound request, delivered to HandleWebhook.
// Delivery is at least once: the same DeliveryID can arrive again after a
// crash, a timeout, or an error. The host already dropped a request whose
// external delivery ID repeated.
type Webhook struct {
	// DeliveryID is the host's stable ID of this delivery.
	DeliveryID string `json:"deliveryId"`
	// WebhookID is the declaration's ID.
	WebhookID  string    `json:"webhookId"`
	ReceivedAt time.Time `json:"receivedAt"`
	// ExternalID is the provider's delivery ID, when the declaration names
	// one.
	ExternalID string `json:"externalId,omitempty"`
	// Body is the exact raw request body of a token or signature webhook.
	// A fetch-back webhook receives no body.
	Body []byte `json:"body,omitempty"`
	// Headers are the declared forwardHeaders the request carried, keyed by
	// their canonical names.
	Headers map[string]string `json:"headers,omitempty"`
	// EventID is the event ID of a fetch-back request. The plugin reads the
	// event from the provider through an authenticated connection.
	EventID string `json:"eventId,omitempty"`
	// Attempt is 1 for the first delivery.
	Attempt int `json:"attempt"`
}

// WebhookHandler is implemented by a bundled Plugin Manifest API 3 plugin
// that declares webhooks. The host calls HandleWebhook in the system
// context, with no operator, for at most 30 seconds. A returned error
// retries the delivery; after 8 failures the host parks it.
type WebhookHandler interface {
	HandleWebhook(ctx context.Context, webhook Webhook) error
}

// WebhookVerification is the input of a verify hook.
type WebhookVerification struct {
	WebhookID string
	// Body is the exact raw request body.
	Body []byte
	// Headers are the declared signature.headers the request carried.
	Headers http.Header
	// EndpointURL is the endpoint address Studio shows, built from
	// TILECAST_PUBLIC_URL and never from request headers.
	EndpointURL string
}

// WebhookVerifier is implemented by a bundled plugin with a webhook of
// signature scheme verify. VerifyWebhook returns nil only for an authentic
// request. The host gives it 1 second, refuses its network service calls,
// and treats an error, a panic, or the time limit as a failed verification.
type WebhookVerifier interface {
	VerifyWebhook(ctx context.Context, request WebhookVerification) error
}
