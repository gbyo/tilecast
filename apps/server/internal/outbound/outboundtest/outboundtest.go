// Package outboundtest supplies a fake resolver, a fake dialer, and test
// certificates for tests of the outbound engine and its users. Tests never
// touch real DNS or the internet: a host name resolves to chosen addresses,
// and each chosen address connects to a local test server.
package outboundtest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"
)

// Resolver answers host names with chosen addresses. Each lookup of a host
// returns the next answer; the last one repeats.
type Resolver struct {
	mu      sync.Mutex
	answers map[string][][]netip.Addr
	calls   map[string]int
	// Block makes every lookup wait until its context ends.
	Block bool
}

// Answer adds one answer for a host.
func (r *Resolver) Answer(host string, addresses ...netip.Addr) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.answers == nil {
		r.answers = map[string][][]netip.Addr{}
	}
	r.answers[host] = append(r.answers[host], addresses)
}

// LookupNetIP implements the engine's resolver.
func (r *Resolver) LookupNetIP(ctx context.Context, _, host string) ([]netip.Addr, error) {
	if r.Block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.calls == nil {
		r.calls = map[string]int{}
	}
	answers := r.answers[host]
	if len(answers) == 0 {
		return nil, errors.New("no such host internal-resolver-detail")
	}
	index := r.calls[host]
	r.calls[host]++
	if index >= len(answers) {
		index = len(answers) - 1
	}
	return answers[index], nil
}

// Count returns how many lookups a host had.
func (r *Resolver) Count(host string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls[host]
}

// Dialer connects chosen addresses to local listeners and records every
// address it was asked to dial.
type Dialer struct {
	mu     sync.Mutex
	routes map[netip.Addr]string
	dialed []string
}

// Route connects an address to a local listener address.
func (d *Dialer) Route(address netip.Addr, local string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.routes == nil {
		d.routes = map[netip.Addr]string{}
	}
	d.routes[address] = local
}

// DialContext implements the engine's dialer. It refuses anything but an
// address literal, so a test fails if the engine ever dials a name.
func (d *Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	d.dialed = append(d.dialed, address)
	local, routed := "", false
	target, err := netip.ParseAddrPort(address)
	if err == nil {
		local, routed = d.routes[target.Addr()]
	}
	d.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("the engine dialed a name, not a checked address: %q", address)
	}
	if !routed {
		return nil, errors.New("connection refused")
	}
	return (&net.Dialer{}).DialContext(ctx, network, local)
}

// Dials returns the addresses dialed so far.
func (d *Dialer) Dials() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.dialed...)
}

// Certificates makes a test CA and a server certificate for the names.
func Certificates(t testing.TB, names ...string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Tilecast test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true,
		KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: names[0]}, DNSNames: names,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	return tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}, pool
}

// Network is a resolver, a dialer, and certificates for a set of names.
type Network struct {
	t        testing.TB
	Resolver *Resolver
	Dialer   *Dialer
	Roots    *x509.CertPool
	cert     tls.Certificate
}

// NewNetwork builds a network whose test certificate names the hosts.
func NewNetwork(t testing.TB, names ...string) *Network {
	cert, roots := Certificates(t, names...)
	return &Network{t: t, Resolver: &Resolver{}, Dialer: &Dialer{}, Roots: roots, cert: cert}
}

// HTTPS starts an HTTPS server that the address reaches.
func (n *Network) HTTPS(address netip.Addr, handler http.Handler) *httptest.Server {
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{n.cert}}
	server.StartTLS()
	n.t.Cleanup(server.Close)
	n.Dialer.Route(address, server.Listener.Addr().String())
	return server
}

// HTTP starts a plain HTTP server that the address reaches.
func (n *Network) HTTP(address netip.Addr, handler http.Handler) *httptest.Server {
	server := httptest.NewServer(handler)
	n.t.Cleanup(server.Close)
	n.Dialer.Route(address, server.Listener.Addr().String())
	return server
}
