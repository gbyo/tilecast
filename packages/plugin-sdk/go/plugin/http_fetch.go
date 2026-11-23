package plugin

import (
	"context"

	"github.com/google/uuid"
)

// Typed shapes of the http.fetch@1 Server service. A plugin sends a request
// through one of its own connection records; the host checks the origin and
// the addresses, adds secret headers, and bounds the body and the time. See
// docs/plugin-connections.md.

// HTTPRequest is one request.
type HTTPRequest struct {
	// Connection is the ID of a connection record of this plugin, usually
	// the value of a connection field.
	Connection uuid.UUID `json:"connection"`
	Method     string    `json:"method"`
	// URL is absolute, or a path and query such as "/v1/items?page=2" when
	// the connection has exactly one origin.
	URL     string       `json:"url"`
	Headers []HTTPHeader `json:"headers,omitempty"`
	// Body is at most 1 MiB.
	Body []byte `json:"body,omitempty"`
}

// HTTPHeader is a plain header or a secret reference.
type HTTPHeader struct {
	Name   string        `json:"name"`
	Value  string        `json:"value,omitempty"`
	Secret *SecretHeader `json:"secret,omitempty"`
}

// SecretHeader names one of the plugin's own secret fields. The host sends
// Prefix, the secret, and Suffix. Plugin code never receives the value.
type SecretHeader struct {
	// Scope is ScopeOrganization, ScopeInstance, or ScopeScreen.
	Scope string `json:"scope"`
	// OwnerID is the instance or screen ID. It is empty for the
	// organization scope.
	OwnerID uuid.UUID `json:"ownerId,omitempty"`
	Key     string    `json:"key"`
	Prefix  string    `json:"prefix,omitempty"`
	Suffix  string    `json:"suffix,omitempty"`
}

// HTTPResponse is a bounded response. Headers holds only the headers the
// host returns: content type, caching, rate limits, links, and a few
// provider headers. Set-Cookie never reaches plugin code.
type HTTPResponse struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
	Body    []byte              `json:"body"`
}

// Header returns the first value of a returned header.
func (r HTTPResponse) Header(name string) string {
	for key, values := range r.Headers {
		if len(values) > 0 && equalFoldASCII(key, name) {
			return values[0]
		}
	}
	return ""
}

func equalFoldASCII(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 'a' - 'A'
		}
		if 'A' <= y && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}

// Stable failure codes of http.fetch@1, returned as *ServiceError.
const (
	FetchOriginNotAllowed       = "origin_not_allowed"
	FetchPrivateNetworkRefused  = "private_network_refused"
	FetchPlainHTTPRefused       = "plain_http_refused"
	FetchPlaintextSecretRefused = "plaintext_secret_refused"
	FetchDNSFailed              = "dns_failed"
	FetchDNSAddressRefused      = "dns_address_refused"
	FetchConnectFailed          = "connect_failed"
	FetchTLSFailed              = "tls_failed"
	FetchRedirectRefused        = "redirect_refused"
	FetchTimeout                = "timeout"
	FetchResponseTooLarge       = "response_too_large"
	FetchConnectionUnavailable  = "connection_unavailable"
	FetchRequestInvalid         = "request_invalid"
	FetchRequestFailed          = "request_failed"
)

// Fetch sends one request through http.fetch@1.
func (s *Services) Fetch(ctx context.Context, request HTTPRequest) (HTTPResponse, error) {
	var response HTTPResponse
	err := s.Call(ctx, "http.fetch@1/request", request, &response)
	return response, err
}
