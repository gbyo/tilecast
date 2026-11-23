package outbound

import (
	"net/http"
	"net/textproto"
	"strings"
)

// Request header bounds. A provider API needs a handful of headers; 32
// leaves room for vendor headers without letting one call build a large
// request head.
const (
	MaxRequestHeaders       = 32
	MaxHeaderNameBytes      = 64
	MaxHeaderValueBytes     = 4096
	MaxRequestHeaderBytes   = 16 << 10
	MaxResponseHeaderBytes  = 64 << 10
	maxReturnedHeaderValues = 8
)

// refusedRequestHeaders are headers the host owns: the destination, the
// connection management, cookies, and proxy credentials. Header names are
// canonical.
var refusedRequestHeaders = map[string]bool{
	"Host":                true,
	"Cookie":              true,
	"Cookie2":             true,
	"Connection":          true,
	"Proxy-Connection":    true,
	"Keep-Alive":          true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
	"Proxy-Authorization": true,
	"Proxy-Authenticate":  true,
	"Content-Length":      true,
	"Expect":              true,
	"Http2-Settings":      true,
	"Forwarded":           true,
	"X-Forwarded-For":     true,
	"X-Forwarded-Host":    true,
	"X-Forwarded-Proto":   true,
	"Via":                 true,
}

// RequestHeader is one header a caller asks to send.
type RequestHeader struct {
	Name  string
	Value string
	// Sensitive marks a header whose value comes from a secret or a token.
	// The engine never carries it across a change of origin.
	Sensitive bool
}

// ValidateHeaders checks request headers and returns them as an
// http.Header and the canonical names of the sensitive ones. The value of
// a refused header never appears in the failure.
func ValidateHeaders(headers []RequestHeader) (http.Header, map[string]bool, *Failure) {
	if len(headers) > MaxRequestHeaders {
		return nil, nil, failure(CodeRequestInvalid, nil)
	}
	out := http.Header{}
	sensitive := map[string]bool{}
	total := 0
	for _, header := range headers {
		if header.Name == "" || len(header.Name) > MaxHeaderNameBytes || !validHeaderName(header.Name) {
			return nil, nil, failure(CodeRequestInvalid, nil)
		}
		if len(header.Value) > MaxHeaderValueBytes || !validHeaderValue(header.Value) {
			return nil, nil, failure(CodeRequestInvalid, nil)
		}
		name := textproto.CanonicalMIMEHeaderKey(header.Name)
		if refusedRequestHeaders[name] || strings.HasPrefix(name, "Sec-") || strings.HasPrefix(name, "Proxy-") {
			return nil, nil, failure(CodeRequestInvalid, nil)
		}
		total += len(name) + len(header.Value) + 4
		if total > MaxRequestHeaderBytes {
			return nil, nil, failure(CodeRequestInvalid, nil)
		}
		out.Add(name, header.Value)
		if header.Sensitive || name == "Authorization" {
			sensitive[name] = true
		}
	}
	return out, sensitive, nil
}

func validHeaderName(name string) bool {
	for i := 0; i < len(name); i++ {
		c := name[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0) {
			return false
		}
	}
	return true
}

func validHeaderValue(value string) bool {
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == '\r' || c == '\n' || c == 0 || c == 0x7f || (c < 0x20 && c != '\t') {
			return false
		}
	}
	return true
}

// returnedResponseHeaders are the response headers plugin code may read.
// Set-Cookie and every transport header stay with the host.
var returnedResponseHeaders = map[string]bool{
	"Content-Type":          true,
	"Content-Language":      true,
	"Etag":                  true,
	"Last-Modified":         true,
	"Cache-Control":         true,
	"Expires":               true,
	"Date":                  true,
	"Retry-After":           true,
	"Link":                  true,
	"Location":              true,
	"X-Ratelimit-Limit":     true,
	"X-Ratelimit-Remaining": true,
	"X-Ratelimit-Reset":     true,
	"Ratelimit-Limit":       true,
	"Ratelimit-Remaining":   true,
	"Ratelimit-Reset":       true,
	"Square-Version":        true,
}

// SafeResponseHeaders returns the headers plugin code may read, each with
// at most a few bounded values.
func SafeResponseHeaders(header http.Header) map[string][]string {
	// A header the response names in Connection is hop-by-hop even when its
	// name is on the list.
	hop := map[string]bool{}
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			hop[textproto.CanonicalMIMEHeaderKey(strings.TrimSpace(token))] = true
		}
	}
	out := map[string][]string{}
	for name, values := range header {
		canonical := textproto.CanonicalMIMEHeaderKey(name)
		if !returnedResponseHeaders[canonical] || hop[canonical] {
			continue
		}
		kept := []string{}
		for _, value := range values {
			if len(kept) == maxReturnedHeaderValues {
				break
			}
			if len(value) > MaxHeaderValueBytes {
				value = value[:MaxHeaderValueBytes]
			}
			kept = append(kept, value)
		}
		out[textproto.CanonicalMIMEHeaderKey(name)] = kept
	}
	return out
}
