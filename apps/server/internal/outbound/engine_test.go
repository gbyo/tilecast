package outbound

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/outbound/outboundtest"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// The tests never touch real DNS or the internet. outboundtest resolves
// host names to chosen addresses and connects each address to a local test
// server, recording what the engine asked to dial.

var (
	publicA  = netip.MustParseAddr("93.184.216.34")
	publicB  = netip.MustParseAddr("93.184.216.35")
	publicV6 = netip.MustParseAddr("2606:2800:220:1::248")
	lanA     = netip.MustParseAddr("192.168.1.20")
	lanB     = netip.MustParseAddr("10.20.30.40")
	ula      = netip.MustParseAddr("fd12:3456:789a::5")
	loopback = netip.MustParseAddr("127.0.0.1")
)

type rig struct {
	network  *outboundtest.Network
	resolver *outboundtest.Resolver
	dialer   *outboundtest.Dialer
	engine   *Engine
}

func newRig(t *testing.T) *rig {
	network := outboundtest.NewNetwork(t, "example.com", "api.example.com", "files.example.com")
	return &rig{network: network, resolver: network.Resolver, dialer: network.Dialer,
		engine: New(Options{Resolver: network.Resolver, Dialer: network.Dialer, RootCAs: network.Roots})}
}

func (r *rig) tlsServer(address netip.Addr, handler http.Handler) *httptest.Server {
	return r.network.HTTPS(address, handler)
}

func (r *rig) plainServer(address netip.Addr, handler http.Handler) *httptest.Server {
	return r.network.HTTP(address, handler)
}

func (r *rig) answer(host string, addresses ...netip.Addr) { r.resolver.Answer(host, addresses...) }

func origin(t *testing.T, raw string) plugin.Origin {
	t.Helper()
	value, err := plugin.ParseOrigin(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func policyFor(t *testing.T, origins ...string) Policy {
	policy := Policy{MaxResponseBytes: 1 << 20, Timeout: 5 * time.Second}
	for _, raw := range origins {
		policy.Origins = append(policy.Origins, origin(t, raw))
	}
	return policy
}

func get(t *testing.T, raw string) Request {
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return Request{Method: http.MethodGet, URL: u}
}

func ok(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }

func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	if got := FailureCode(err); got != code {
		t.Fatalf("got failure %q (%v), want %q", got, err, code)
	}
}

func TestClassify(t *testing.T) {
	cases := map[string]AddressClass{
		"93.184.216.34": ClassPublic, "2606:2800:220:1::248": ClassPublic, "172.32.0.1": ClassPublic, "8.8.8.8": ClassPublic,
		"10.1.2.3": ClassPrivate, "172.16.5.4": ClassPrivate, "172.31.255.255": ClassPrivate, "192.168.1.1": ClassPrivate,
		"fd00::1": ClassPrivate, "fc00::1": ClassPrivate, "::ffff:192.168.1.1": ClassPrivate,
		"127.0.0.1": ClassForbidden, "127.8.9.10": ClassForbidden, "::1": ClassForbidden, "::ffff:127.0.0.1": ClassForbidden,
		"169.254.169.254": ClassForbidden, "169.254.0.1": ClassForbidden, "fe80::1": ClassForbidden, "0.0.0.0": ClassForbidden,
		"::": ClassForbidden, "224.0.0.1": ClassForbidden, "ff02::1": ClassForbidden, "255.255.255.255": ClassForbidden,
		"100.64.0.1": ClassForbidden, "192.0.2.1": ClassForbidden, "198.18.0.1": ClassForbidden, "64:ff9b::a00:1": ClassForbidden,
		"2002:a00:1::1": ClassForbidden, "2001:db8::1": ClassForbidden, "::ffff:169.254.169.254": ClassForbidden,
		"fec0::1": ClassForbidden, "2001::1": ClassForbidden,
	}
	for text, want := range cases {
		if got := Classify(netip.MustParseAddr(text)); got != want {
			t.Errorf("%s: got %s, want %s", text, got, want)
		}
	}
}

func TestPublicHTTPS(t *testing.T) {
	r := newRig(t)
	r.answer("example.com", publicA)
	r.tlsServer(publicA, http.HandlerFunc(ok))
	response, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/v1/items?page=2"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != 200 || string(response.Body) != "ok" {
		t.Fatalf("got %d %q", response.Status, response.Body)
	}
	if dials := r.dialer.Dials(); len(dials) != 1 || dials[0] != "93.184.216.34:443" {
		t.Fatalf("dials %v", dials)
	}
}

func TestPrivateAddressesNeedConsent(t *testing.T) {
	for _, address := range []netip.Addr{lanA, lanB, ula} {
		t.Run(address.String(), func(t *testing.T) {
			r := newRig(t)
			r.answer("example.com", address)
			r.tlsServer(address, http.HandlerFunc(ok))
			_, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/"))
			expectCode(t, err, CodePrivateNetworkRefused)
			if dials := r.dialer.Dials(); len(dials) != 0 {
				t.Fatalf("dialed a refused address: %v", dials)
			}
			policy := policyFor(t, "https://example.com")
			policy.PrivateNetwork = true
			if _, err := r.engine.Do(context.Background(), policy, get(t, "https://example.com/")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestForbiddenAddressesAlwaysRefused(t *testing.T) {
	for _, text := range []string{"127.0.0.1", "::1", "::ffff:127.0.0.1", "169.254.169.254", "fe80::1", "224.0.0.1", "0.0.0.0", "::", "ff02::1"} {
		t.Run(text, func(t *testing.T) {
			r := newRig(t)
			r.answer("example.com", netip.MustParseAddr(text))
			policy := policyFor(t, "https://example.com")
			policy.PrivateNetwork = true
			_, err := r.engine.Do(context.Background(), policy, get(t, "https://example.com/"))
			expectCode(t, err, CodeDNSAddressRefused)
			if len(r.dialer.Dials()) != 0 {
				t.Fatal("dialed a forbidden address")
			}
		})
	}
}

func TestMixedAnswerFailsAsAWhole(t *testing.T) {
	r := newRig(t)
	r.answer("example.com", publicA, loopback)
	r.tlsServer(publicA, http.HandlerFunc(ok))
	_, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/"))
	expectCode(t, err, CodeDNSAddressRefused)

	r = newRig(t)
	r.answer("example.com", publicA, lanA)
	r.tlsServer(publicA, http.HandlerFunc(ok))
	_, err = r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/"))
	expectCode(t, err, CodePrivateNetworkRefused)
	if len(r.dialer.Dials()) != 0 {
		t.Fatal("dialed part of a refused answer")
	}
}

func plainPolicy(t *testing.T, raw string) Policy {
	policy := policyFor(t, raw)
	policy.PrivateNetwork, policy.PlainHTTP = true, true
	return policy
}

func TestPlainHTTPOnPrivateAddresses(t *testing.T) {
	for _, address := range []netip.Addr{lanA, lanB, ula} {
		r := newRig(t)
		r.answer("inverter.lan", address)
		r.plainServer(address, http.HandlerFunc(ok))
		if _, err := r.engine.Do(context.Background(), plainPolicy(t, "http://inverter.lan:8080"), get(t, "http://inverter.lan:8080/status")); err != nil {
			t.Fatalf("%s: %v", address, err)
		}
	}
	r := newRig(t)
	r.answer("inverter.lan", publicA)
	r.plainServer(publicA, http.HandlerFunc(ok))
	_, err := r.engine.Do(context.Background(), plainPolicy(t, "http://inverter.lan:8080"), get(t, "http://inverter.lan:8080/"))
	expectCode(t, err, CodePlainHTTPRefused)

	r = newRig(t)
	r.answer("inverter.lan", lanA, publicA)
	_, err = r.engine.Do(context.Background(), plainPolicy(t, "http://inverter.lan:8080"), get(t, "http://inverter.lan:8080/"))
	expectCode(t, err, CodePlainHTTPRefused)

	r = newRig(t)
	r.answer("inverter.lan", loopback)
	_, err = r.engine.Do(context.Background(), plainPolicy(t, "http://inverter.lan:8080"), get(t, "http://inverter.lan:8080/"))
	expectCode(t, err, CodeDNSAddressRefused)

	// Without both consents a plain HTTP origin is refused before any
	// resolution.
	for _, policy := range []Policy{policyFor(t, "http://inverter.lan:8080"), func() Policy {
		p := policyFor(t, "http://inverter.lan:8080")
		p.PlainHTTP = true
		return p
	}()} {
		r = newRig(t)
		r.answer("inverter.lan", lanA)
		_, err = r.engine.Do(context.Background(), policy, get(t, "http://inverter.lan:8080/"))
		expectCode(t, err, CodePlainHTTPRefused)
		if r.resolver.Count("inverter.lan") != 0 {
			t.Fatal("resolved a refused plain HTTP origin")
		}
	}
}

func TestDialsTheValidatedAddressOnly(t *testing.T) {
	r := newRig(t)
	// The first answer passes the check. A second lookup would answer
	// loopback; the transport must never make it.
	r.answer("example.com", publicA)
	r.answer("example.com", loopback)
	server := r.tlsServer(publicA, http.HandlerFunc(ok))
	r.dialer.Route(loopback, server.Listener.Addr().String())
	if _, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/")); err != nil {
		t.Fatal(err)
	}
	if got := r.resolver.Count("example.com"); got != 1 {
		t.Fatalf("resolved %d times for one socket", got)
	}
	if dials := r.dialer.Dials(); len(dials) != 1 || dials[0] != "93.184.216.34:443" {
		t.Fatalf("dials %v", dials)
	}
	// A new socket resolves and checks again.
	_, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/"))
	expectCode(t, err, CodeDNSAddressRefused)
}

func TestTLSUsesTheOriginalHostName(t *testing.T) {
	r := newRig(t)
	r.answer("example.com", publicA)
	r.answer("other.example", publicA)
	r.tlsServer(publicA, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.WriteString(w, req.Host+" "+req.TLS.ServerName)
	}))
	response, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/"))
	if err != nil {
		t.Fatal(err)
	}
	if string(response.Body) != "example.com example.com" {
		t.Fatalf("Host and SNI: %q", response.Body)
	}
	// The certificate does not name other.example, although the socket
	// reaches the same server.
	_, err = r.engine.Do(context.Background(), policyFor(t, "https://other.example"), get(t, "https://other.example/"))
	expectCode(t, err, CodeTLSFailed)
}

func TestEnvironmentProxyIsNotUsed(t *testing.T) {
	var proxied int
	var mu sync.Mutex
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		proxied++
		mu.Unlock()
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	t.Setenv("https_proxy", proxy.URL)
	t.Setenv("NO_PROXY", "")
	r := newRig(t)
	r.answer("example.com", publicA)
	r.tlsServer(publicA, http.HandlerFunc(ok))
	r.answer("inverter.lan", lanA)
	r.plainServer(lanA, http.HandlerFunc(ok))
	if _, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.engine.Do(context.Background(), plainPolicy(t, "http://inverter.lan"), get(t, "http://inverter.lan/")); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if proxied != 0 {
		t.Fatalf("the proxy received %d requests", proxied)
	}
}

func redirectTo(location string, status int) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/final" {
			_, _ = io.WriteString(w, "final")
			return
		}
		w.Header().Set("Location", location)
		w.WriteHeader(status)
	}
}

func TestRedirects(t *testing.T) {
	t.Run("same origin", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		r.tlsServer(publicA, redirectTo("/final", http.StatusFound))
		response, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/start"))
		if err != nil || string(response.Body) != "final" || response.Redirects != 1 {
			t.Fatalf("%v %+v", err, response)
		}
	})
	t.Run("another approved origin", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		r.answer("api.example.com", publicB)
		r.tlsServer(publicA, redirectTo("https://api.example.com/final", http.StatusTemporaryRedirect))
		r.tlsServer(publicB, redirectTo("/never", http.StatusFound))
		response, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com", "https://api.example.com"), get(t, "https://example.com/start"))
		if err != nil || string(response.Body) != "final" || response.Origin.Host != "api.example.com" {
			t.Fatalf("%v %+v", err, response)
		}
	})
	t.Run("unapproved origin", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		r.answer("files.example.com", publicB)
		r.tlsServer(publicA, redirectTo("https://files.example.com/final", http.StatusFound))
		r.tlsServer(publicB, http.HandlerFunc(ok))
		_, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/start"))
		expectCode(t, err, CodeRedirectRefused)
		if r.resolver.Count("files.example.com") != 0 {
			t.Fatal("resolved an unapproved redirect")
		}
	})
	t.Run("https to http", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		r.tlsServer(publicA, redirectTo("http://gateway.lan/final", http.StatusFound))
		policy := policyFor(t, "https://example.com", "http://gateway.lan")
		policy.PrivateNetwork, policy.PlainHTTP = true, true
		_, err := r.engine.Do(context.Background(), policy, get(t, "https://example.com/start"))
		expectCode(t, err, CodeRedirectRefused)
	})
	t.Run("local http to approved https", func(t *testing.T) {
		r := newRig(t)
		r.answer("gateway.lan", lanA)
		r.answer("example.com", publicA)
		r.plainServer(lanA, redirectTo("https://example.com/final", http.StatusFound))
		r.tlsServer(publicA, redirectTo("/never", http.StatusFound))
		policy := policyFor(t, "http://gateway.lan", "https://example.com")
		policy.PrivateNetwork, policy.PlainHTTP = true, true
		response, err := r.engine.Do(context.Background(), policy, get(t, "http://gateway.lan/start"))
		if err != nil || string(response.Body) != "final" {
			t.Fatalf("%v %+v", err, response)
		}
	})
	t.Run("destination address checked again", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		r.answer("api.example.com", netip.MustParseAddr("169.254.169.254"))
		r.tlsServer(publicA, redirectTo("https://api.example.com/final", http.StatusFound))
		_, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com", "https://api.example.com"), get(t, "https://example.com/start"))
		expectCode(t, err, CodeDNSAddressRefused)
	})
	t.Run("loop is bounded", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		var hits int
		var mu sync.Mutex
		r.tlsServer(publicA, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			hits++
			mu.Unlock()
			w.Header().Set("Location", "/again")
			w.WriteHeader(http.StatusFound)
		}))
		_, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/"))
		expectCode(t, err, CodeRedirectRefused)
		mu.Lock()
		defer mu.Unlock()
		if hits != DefaultMaxRedirects+1 {
			t.Fatalf("followed %d requests", hits)
		}
	})
	t.Run("credentials do not follow a change of origin", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		r.answer("api.example.com", publicB)
		seen := make(chan http.Header, 2)
		r.tlsServer(publicA, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			seen <- req.Header.Clone()
			w.Header().Set("Location", "https://api.example.com/final")
			w.WriteHeader(http.StatusTemporaryRedirect)
		}))
		r.tlsServer(publicB, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			seen <- req.Header.Clone()
			_, _ = io.WriteString(w, "final")
		}))
		request := get(t, "https://example.com/start")
		request.Headers = []RequestHeader{
			{Name: "Authorization", Value: "Bearer abc"},
			{Name: "X-Api-Key", Value: "key-123", Sensitive: true},
			{Name: "Accept", Value: "application/json"},
		}
		if _, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com", "https://api.example.com"), request); err != nil {
			t.Fatal(err)
		}
		first, second := <-seen, <-seen
		if first.Get("Authorization") == "" || first.Get("X-Api-Key") == "" {
			t.Fatal("the first origin did not receive its credentials")
		}
		if second.Get("Authorization") != "" || second.Get("X-Api-Key") != "" || second.Get("Accept") != "application/json" {
			t.Fatalf("headers after the origin change: %v", second)
		}
	})
	t.Run("303 becomes GET without a body", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		r.tlsServer(publicA, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == "/final" {
				body, _ := io.ReadAll(req.Body)
				_, _ = fmt.Fprintf(w, "%s %d", req.Method, len(body))
				return
			}
			w.Header().Set("Location", "/final")
			w.WriteHeader(http.StatusSeeOther)
		}))
		request := get(t, "https://example.com/start")
		request.Method, request.Body = http.MethodPost, []byte(`{"a":1}`)
		response, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), request)
		if err != nil || string(response.Body) != "GET 0" {
			t.Fatalf("%v %+v", err, response)
		}
	})
}

func TestRequestHeaders(t *testing.T) {
	refused := []RequestHeader{
		{Name: "Host", Value: "evil.example"}, {Name: "host", Value: "x"}, {Name: "Cookie", Value: "a=b"},
		{Name: "Connection", Value: "close"}, {Name: "Proxy-Connection", Value: "x"}, {Name: "Keep-Alive", Value: "1"},
		{Name: "TE", Value: "trailers"}, {Name: "Trailer", Value: "x"}, {Name: "Transfer-Encoding", Value: "chunked"},
		{Name: "Upgrade", Value: "h2c"}, {Name: "Proxy-Authorization", Value: "Basic x"}, {Name: "Content-Length", Value: "3"},
		{Name: "X-Forwarded-For", Value: "1.2.3.4"}, {Name: "Bad Name", Value: "x"}, {Name: "X-Ok", Value: "a\r\nInjected: 1"},
	}
	for _, header := range refused {
		_, _, err := ValidateHeaders([]RequestHeader{header})
		if err == nil || err.Code != CodeRequestInvalid {
			t.Errorf("%q: accepted", header.Name)
		}
		if err != nil && strings.Contains(err.Error(), header.Value) {
			t.Errorf("%q: the failure repeats the value", header.Name)
		}
	}
	many := []RequestHeader{}
	for i := 0; i < MaxRequestHeaders; i++ {
		many = append(many, RequestHeader{Name: fmt.Sprintf("X-H%d", i), Value: "v"})
	}
	if _, _, err := ValidateHeaders(many); err != nil {
		t.Fatalf("%d headers refused: %v", MaxRequestHeaders, err)
	}
	many = append(many, RequestHeader{Name: "X-One-More", Value: "v"})
	if _, _, err := ValidateHeaders(many); err == nil {
		t.Fatalf("%d headers accepted", len(many))
	}
	large := []RequestHeader{}
	for i := 0; i < 5; i++ {
		large = append(large, RequestHeader{Name: fmt.Sprintf("X-L%d", i), Value: strings.Repeat("a", MaxHeaderValueBytes)})
	}
	if _, _, err := ValidateHeaders(large); err == nil {
		t.Fatal("headers over the total bound accepted")
	}
	if _, _, err := ValidateHeaders([]RequestHeader{{Name: "X-Big", Value: strings.Repeat("a", MaxHeaderValueBytes+1)}}); err == nil {
		t.Fatal("an oversized value accepted")
	}
	header, sensitive, err := ValidateHeaders([]RequestHeader{{Name: "authorization", Value: "Bearer x"}, {Name: "x-key", Value: "k", Sensitive: true}})
	if err != nil || header.Get("Authorization") == "" || !sensitive["Authorization"] || !sensitive["X-Key"] {
		t.Fatalf("%v %v %v", header, sensitive, err)
	}
}

func TestResponseHeadersAreFiltered(t *testing.T) {
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	header.Set("Set-Cookie", "session=1")
	header.Set("Etag", `"v1"`)
	header.Set("Connection", "Etag")
	got := SafeResponseHeaders(header)
	if _, ok := got["Set-Cookie"]; ok {
		t.Fatal("Set-Cookie returned")
	}
	if _, ok := got["Etag"]; ok {
		t.Fatal("a header named by Connection returned")
	}
	if got["Content-Type"][0] != "application/json" {
		t.Fatal("Content-Type missing")
	}
}

func TestBodyBounds(t *testing.T) {
	r := newRig(t)
	r.answer("example.com", publicA)
	received := make(chan int, 4)
	r.tlsServer(publicA, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		received <- len(body)
		switch req.URL.Path {
		case "/exact":
			_, _ = w.Write(bytes.Repeat([]byte("a"), 1024))
		case "/over":
			_, _ = w.Write(bytes.Repeat([]byte("a"), 1025))
		case "/over-chunked":
			w.(http.Flusher).Flush()
			_, _ = w.Write(bytes.Repeat([]byte("a"), 1025))
		}
	}))
	policy := policyFor(t, "https://example.com")
	policy.MaxResponseBytes = 1024
	request := get(t, "https://example.com/exact")
	request.Method, request.Body = http.MethodPost, bytes.Repeat([]byte("b"), MaxRequestBodyBytes)
	response, err := r.engine.Do(context.Background(), policy, request)
	if err != nil || len(response.Body) != 1024 || <-received != MaxRequestBodyBytes {
		t.Fatalf("%v", err)
	}
	request.Body = append(request.Body, 'b')
	_, err = r.engine.Do(context.Background(), policy, request)
	expectCode(t, err, CodeRequestInvalid)
	for _, path := range []string{"/over", "/over-chunked"} {
		_, err = r.engine.Do(context.Background(), policy, get(t, "https://example.com"+path))
		expectCode(t, err, CodeResponseTooLarge)
	}
}

func TestTimeoutCoversEveryStep(t *testing.T) {
	t.Run("resolution", func(t *testing.T) {
		r := newRig(t)
		r.resolver.Block = true
		policy := policyFor(t, "https://example.com")
		policy.Timeout = 150 * time.Millisecond
		_, err := r.engine.Do(context.Background(), policy, get(t, "https://example.com/"))
		expectCode(t, err, CodeTimeout)
	})
	t.Run("body", func(t *testing.T) {
		r := newRig(t)
		r.answer("example.com", publicA)
		release := make(chan struct{})
		defer close(release)
		r.tlsServer(publicA, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "partial")
			w.(http.Flusher).Flush()
			select {
			case <-release:
			case <-time.After(5 * time.Second):
			}
		}))
		policy := policyFor(t, "https://example.com")
		policy.Timeout = 300 * time.Millisecond
		started := time.Now()
		_, err := r.engine.Do(context.Background(), policy, get(t, "https://example.com/"))
		expectCode(t, err, CodeTimeout)
		if time.Since(started) > 3*time.Second {
			t.Fatal("the timeout did not cover the body")
		}
	})
}

func TestRequestShape(t *testing.T) {
	r := newRig(t)
	policy := policyFor(t, "https://example.com")
	for _, request := range []Request{
		{Method: "TRACE", URL: &url.URL{Scheme: "https", Host: "example.com"}},
		{Method: "CONNECT", URL: &url.URL{Scheme: "https", Host: "example.com"}},
		{Method: http.MethodGet, URL: &url.URL{Scheme: "https", Host: "example.com", User: url.UserPassword("a", "b")}},
	} {
		_, err := r.engine.Do(context.Background(), policy, request)
		expectCode(t, err, CodeRequestInvalid)
	}
	_, err := r.engine.Do(context.Background(), policy, get(t, "https://example.com:8443/"))
	expectCode(t, err, CodeOriginNotAllowed)
	_, err = r.engine.Do(context.Background(), policy, get(t, "https://localhost/"))
	expectCode(t, err, CodeOriginNotAllowed)
}

func TestFailuresDoNotCarryTransportDetail(t *testing.T) {
	r := newRig(t)
	_, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/"))
	expectCode(t, err, CodeDNSFailed)
	var failure *Failure
	errors.As(err, &failure)
	if strings.Contains(failure.Message(), "internal-resolver-detail") {
		t.Fatal("the message carries resolver text")
	}
}

func TestPublicIPv6(t *testing.T) {
	r := newRig(t)
	r.answer("example.com", publicV6)
	r.tlsServer(publicV6, http.HandlerFunc(ok))
	if _, err := r.engine.Do(context.Background(), policyFor(t, "https://example.com"), get(t, "https://example.com/")); err != nil {
		t.Fatal(err)
	}
	if dials := r.dialer.Dials(); dials[0] != "[2606:2800:220:1::248]:443" {
		t.Fatalf("dials %v", dials)
	}
}
