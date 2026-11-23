// Package outbound is the one hardened engine for outbound connections the
// Server makes on behalf of a plugin: http.fetch@1, OAuth token and
// revocation requests, and feed image imports use it. It owns origin
// checks, DNS and address policy, dialing, TLS, redirects, and limits, and
// it reports failures as stable codes.
//
// For every new socket the engine resolves the host once, checks every
// returned address, and dials one of the addresses it checked. The HTTP
// transport never resolves a name itself, so a resolver cannot answer one
// address for the check and another for the connection. TLS still verifies
// the certificate against the original host name. Environment proxies are
// never used, so a proxy cannot carry a request past the checks.
package outbound

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"time"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Request and redirect bounds.
const (
	// MaxRequestBodyBytes bounds one request body.
	MaxRequestBodyBytes = 1 << 20
	// DefaultMaxRedirects bounds the redirects one request follows.
	DefaultMaxRedirects = 5
	// MaxTimeout bounds the time of one request, redirects included.
	MaxTimeout = 60 * time.Second
	// maxURLBytes bounds the text of a request URL.
	maxURLBytes = 8 << 10
)

// Methods a request may use.
var allowedMethods = map[string]bool{
	http.MethodGet: true, http.MethodHead: true, http.MethodPost: true,
	http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true,
}

// Resolver resolves a host name to addresses. *net.Resolver implements it.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Dialer opens a TCP connection to an address literal. *net.Dialer
// implements it.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

// Options configure an engine. Tests supply a resolver, a dialer, and root
// certificates; production uses the system ones.
type Options struct {
	Resolver Resolver
	Dialer   Dialer
	RootCAs  *x509.CertPool
}

// Engine performs checked outbound requests.
type Engine struct {
	resolver Resolver
	dialer   Dialer
	rootCAs  *x509.CertPool
}

// New builds an engine.
func New(options Options) *Engine {
	engine := &Engine{resolver: options.Resolver, dialer: options.Dialer, rootCAs: options.RootCAs}
	if engine.resolver == nil {
		engine.resolver = &net.Resolver{}
	}
	if engine.dialer == nil {
		engine.dialer = &net.Dialer{KeepAlive: 30 * time.Second}
	}
	return engine
}

// Policy is the security boundary of one request.
type Policy struct {
	// Origins are the approved origins. A request and every redirect must
	// stay on them.
	Origins []plugin.Origin
	// PrivateNetwork lets the request reach private addresses. Set it only
	// when the declaration allows it and the consent is active.
	PrivateNetwork bool
	// PlainHTTP lets the request use an approved http origin on private
	// addresses. Set it only when the declaration allows it, the origin was
	// entered by an operator, and both consents are active.
	PlainHTTP bool
	// MaxResponseBytes bounds the response body.
	MaxResponseBytes int64
	// Timeout bounds the whole request: resolution, connection, TLS,
	// redirects, and the body.
	Timeout time.Duration
	// MaxRedirects bounds redirects. Zero uses DefaultMaxRedirects; a
	// negative value follows none.
	MaxRedirects int
}

// Request is one outbound request.
type Request struct {
	Method  string
	URL     *url.URL
	Headers []RequestHeader
	Body    []byte
}

// Response is a bounded response.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
	// Origin is the origin that answered, after redirects.
	Origin    plugin.Origin
	Redirects int
}

func (p Policy) allows(origin plugin.Origin) *Failure {
	approved := false
	for _, candidate := range p.Origins {
		if candidate == origin {
			approved = true
			break
		}
	}
	if !approved {
		return failure(CodeOriginNotAllowed, nil)
	}
	switch origin.Scheme {
	case plugin.SchemeHTTPS:
		return nil
	case plugin.SchemeHTTP:
		if !p.PlainHTTP || !p.PrivateNetwork {
			return failure(CodePlainHTTPRefused, nil)
		}
		return nil
	default:
		return failure(CodeOriginNotAllowed, nil)
	}
}

// Do sends one request under the policy. It returns a *Failure for every
// refusal and every transport failure.
func (e *Engine) Do(ctx context.Context, policy Policy, request Request) (*Response, error) {
	if policy.Timeout <= 0 || policy.Timeout > MaxTimeout || policy.MaxResponseBytes <= 0 {
		return nil, failure(CodeRequestInvalid, errors.New("policy needs a timeout and a response limit"))
	}
	if !allowedMethods[request.Method] || request.URL == nil || len(request.URL.String()) > maxURLBytes ||
		request.URL.User != nil || len(request.Body) > MaxRequestBodyBytes {
		return nil, failure(CodeRequestInvalid, nil)
	}
	header, sensitive, refused := ValidateHeaders(request.Headers)
	if refused != nil {
		return nil, refused
	}
	maxRedirects := policy.MaxRedirects
	if maxRedirects == 0 {
		maxRedirects = DefaultMaxRedirects
	}
	ctx, cancel := context.WithTimeout(ctx, policy.Timeout)
	defer cancel()

	transport := e.transport(policy)
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		// Redirects are followed below, one checked step at a time.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	current := *request.URL
	current.Fragment, current.RawFragment = "", ""
	method, body := request.Method, request.Body
	origin, err := plugin.OriginOf(&current)
	if err != nil {
		return nil, failure(CodeOriginNotAllowed, nil)
	}
	if refusal := policy.allows(origin); refusal != nil {
		return nil, refusal
	}
	for redirects := 0; ; redirects++ {
		outgoing, err := http.NewRequestWithContext(ctx, method, current.String(), bytes.NewReader(body))
		if err != nil {
			return nil, failure(CodeRequestInvalid, nil)
		}
		outgoing.Header = header.Clone()
		if len(body) == 0 {
			outgoing.Body, outgoing.GetBody, outgoing.ContentLength = http.NoBody, nil, 0
		}
		response, err := client.Do(outgoing)
		if err != nil {
			return nil, transportFailure(ctx, err)
		}
		location := response.Header.Get("Location")
		if !isRedirect(response.StatusCode) || location == "" {
			defer response.Body.Close()
			return readResponse(ctx, response, policy.MaxResponseBytes, origin, redirects)
		}
		response.Body.Close()
		if maxRedirects < 0 || redirects >= maxRedirects {
			return nil, failure(CodeRedirectRefused, errors.New("too many redirects"))
		}
		next, err := current.Parse(location)
		if err != nil || next.User != nil {
			return nil, failure(CodeRedirectRefused, err)
		}
		next.Fragment, next.RawFragment = "", ""
		nextOrigin, err := plugin.OriginOf(next)
		if err != nil {
			return nil, failure(CodeRedirectRefused, err)
		}
		if origin.Scheme == plugin.SchemeHTTPS && nextOrigin.Scheme == plugin.SchemeHTTP {
			return nil, failure(CodeRedirectRefused, errors.New("https to http"))
		}
		if refusal := policy.allows(nextOrigin); refusal != nil {
			return nil, failure(CodeRedirectRefused, refusal)
		}
		if nextOrigin != origin {
			// Credentials never follow a change of origin, even to another
			// approved origin of the same connection.
			for name := range sensitive {
				header.Del(name)
			}
			header.Del("Authorization")
		}
		switch response.StatusCode {
		case http.StatusSeeOther:
			if method != http.MethodHead {
				method = http.MethodGet
			}
			body = nil
		case http.StatusMovedPermanently, http.StatusFound:
			if method == http.MethodPost {
				method, body = http.MethodGet, nil
			}
		}
		if body == nil {
			header.Del("Content-Type")
		}
		current, origin = *next, nextOrigin
	}
}

func isRedirect(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

func readResponse(ctx context.Context, response *http.Response, limit int64, origin plugin.Origin, redirects int) (*Response, error) {
	if response.ContentLength > limit {
		return nil, failure(CodeResponseTooLarge, nil)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, transportFailure(ctx, err)
	}
	if int64(len(data)) > limit {
		return nil, failure(CodeResponseTooLarge, nil)
	}
	return &Response{Status: response.StatusCode, Header: response.Header, Body: data, Origin: origin, Redirects: redirects}, nil
}

// transportFailure maps a transport error to a stable code.
func transportFailure(ctx context.Context, err error) *Failure {
	var known *Failure
	switch {
	case errors.As(err, &known):
		if ctx.Err() != nil && known.Code == CodeConnectFailed {
			return failure(CodeTimeout, err)
		}
		return known
	case errors.Is(err, context.DeadlineExceeded), ctx.Err() != nil:
		return failure(CodeTimeout, err)
	default:
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() {
			return failure(CodeTimeout, err)
		}
		return failure(CodeRequestFailed, err)
	}
}

// transport builds an HTTP transport whose every new socket goes through
// the checked dial. It is used for one request and its redirects.
func (e *Engine) transport(policy Policy) *http.Transport {
	return &http.Transport{
		Proxy: nil,
		// A plain HTTP connection: every address must be private.
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			if !policy.PlainHTTP || !policy.PrivateNetwork {
				return nil, failure(CodePlainHTTPRefused, nil)
			}
			conn, _, err := e.dial(ctx, address, addressPolicy{privateNetwork: true, plainHTTP: true})
			return conn, err
		},
		// An HTTPS connection: the checked dial, then TLS verified against
		// the original host name.
		DialTLSContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			conn, host, err := e.dial(ctx, address, addressPolicy{privateNetwork: policy.PrivateNetwork})
			if err != nil {
				return nil, err
			}
			client := tls.Client(conn, &tls.Config{
				ServerName: host,
				RootCAs:    e.rootCAs,
				MinVersion: tls.VersionTLS12,
				NextProtos: []string{"h2", "http/1.1"},
			})
			if err := client.HandshakeContext(ctx); err != nil {
				conn.Close()
				if ctx.Err() != nil {
					return nil, failure(CodeTimeout, err)
				}
				return nil, failure(CodeTLSFailed, err)
			}
			return client, nil
		},
		ForceAttemptHTTP2:      true,
		MaxResponseHeaderBytes: MaxResponseHeaderBytes,
		ResponseHeaderTimeout:  policy.Timeout,
		ExpectContinueTimeout:  time.Second,
		MaxIdleConns:           4,
		IdleConnTimeout:        30 * time.Second,
	}
}

// dial resolves the host once, checks every address, and connects to a
// checked address. It returns the host name for TLS.
func (e *Engine) dial(ctx context.Context, address string, policy addressPolicy) (net.Conn, string, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, "", failure(CodeRequestInvalid, err)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return nil, "", failure(CodeRequestInvalid, err)
	}
	var addresses []netip.Addr
	if literal, err := netip.ParseAddr(host); err == nil {
		addresses = []netip.Addr{literal}
	} else {
		addresses, err = e.resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			if ctx.Err() != nil {
				return nil, "", failure(CodeTimeout, err)
			}
			return nil, "", failure(CodeDNSFailed, err)
		}
	}
	checked, refusal := checkAddresses(addresses, policy)
	if refusal != nil {
		return nil, "", refusal
	}
	var last error
	for _, candidate := range checked {
		conn, err := e.dialer.DialContext(ctx, "tcp", netip.AddrPortFrom(candidate, uint16(port)).String())
		if err == nil {
			return conn, host, nil
		}
		last = err
		if ctx.Err() != nil {
			break
		}
	}
	if ctx.Err() != nil {
		return nil, "", failure(CodeTimeout, last)
	}
	return nil, "", failure(CodeConnectFailed, last)
}
