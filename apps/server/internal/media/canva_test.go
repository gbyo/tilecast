package media

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestCanvaLiveShortLink(t *testing.T) {
	link := os.Getenv("TILECAST_CANVA_LIVE_URL")
	if link == "" {
		t.Skip("set TILECAST_CANVA_LIVE_URL to a non-sensitive public design short link")
	}
	client := canvaLinkClient()
	defer client.CloseIdleConnections()
	canonical, err := resolveCanvaShortLink(context.Background(), link, client)
	if err != nil {
		t.Fatal(err)
	}
	u, err := contentdefs.CanvaURL(canonical)
	if err != nil || u.Host != "www.canva.com" || !u.Query().Has("embed") {
		t.Fatal("live link did not resolve to a supported embed URL")
	}
}

type canvaRoundTrip func(*http.Request) (*http.Response, error)

func (f canvaRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCanvaShortResolution(t *testing.T) {
	for _, tc := range []struct {
		name, destination string
		status            int
		success           bool
	}{
		{"design", "https://www.canva.com/design/DAGabcdefgh/token_123456/view?access=keep&utm_source=share", 301, true},
		{"relative loop", "/abc", 302, false},
		{"excessive", "/next", 307, false},
		{"private", "https://127.0.0.1/", 302, false},
		{"metadata", "https://169.254.169.254/", 302, false},
		{"untrusted", "https://evil.example/", 302, false},
		{"http", "http://www.canva.com/design/DAGabcdefgh/view", 302, false},
		{"login", "https://www.canva.com/login", 302, false},
		{"missing", "", 404, false},
		{"website", "", 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			client := canvaLinkClient()
			client.Transport = canvaRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Host != "canva.link" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Fatal("unsafe request")
				}
				location := tc.destination
				if tc.name == "excessive" {
					location += strings.Repeat("x", calls)
				}
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Location": []string{location}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			})
			got, err := resolveCanvaShortLink(context.Background(), "https://canva.link/abc", client)
			if (err == nil) != tc.success {
				t.Fatalf("got %s, err %v", got, err)
			}
			if tc.success && got != "https://www.canva.com/design/DAGabcdefgh/token_123456/view?access=keep&embed=" {
				t.Fatalf("got %s", got)
			}
			if calls > canvaMaximumRedirects {
				t.Fatalf("unbounded requests: %d", calls)
			}
		})
	}
}

func TestCanvaResolutionPinsPublicDNSOnly(t *testing.T) {
	for _, addresses := range [][]net.IPAddr{
		{{IP: net.ParseIP("127.0.0.1")}}, {{IP: net.ParseIP("169.254.169.254")}}, {{IP: net.ParseIP("10.0.0.1")}}, {{IP: net.ParseIP("::1")}}, {{IP: net.ParseIP("100.64.0.1")}},
		{{IP: net.ParseIP("1.1.1.1")}},
	} {
		dialed := ""
		transport := sourceHTTPTransport(SourceFetchPolicy{Timeout: canvaResolveTimeout}, func(context.Context, string) ([]net.IPAddr, error) { return addresses, nil }, func(_ context.Context, _, address string) (net.Conn, error) {
			dialed = address
			return nil, errors.New("fixture")
		})
		_, _ = transport.DialContext(context.Background(), "tcp", "canva.link:443")
		if isPrivateSourceIP(addresses[0].IP) && dialed != "" {
			t.Fatalf("dialed forbidden address %s", dialed)
		}
		if !isPrivateSourceIP(addresses[0].IP) && dialed != "1.1.1.1:443" {
			t.Fatalf("DNS result not pinned: %s", dialed)
		}
	}
	// Rebinding between requests is checked again at connection time.
	lookups, dials := 0, 0
	transport := sourceHTTPTransport(SourceFetchPolicy{Timeout: canvaResolveTimeout}, func(context.Context, string) ([]net.IPAddr, error) {
		lookups++
		ip := "1.1.1.1"
		if lookups > 1 {
			ip = "10.0.0.1"
		}
		return []net.IPAddr{{IP: net.ParseIP(ip)}}, nil
	}, func(context.Context, string, string) (net.Conn, error) { dials++; return nil, errors.New("fixture") })
	for range 2 {
		_, _ = transport.DialContext(context.Background(), "tcp", "canva.link:443")
	}
	if dials != 1 {
		t.Fatal("rebound private IP was dialed")
	}
}

func TestCanvaAuthoringStoresCanonicalURL(t *testing.T) {
	s := &Service{definitions: contentdefs.MustLoad()}
	raw := json.RawMessage(`{"canvaUrl":"https://www.canva.com/design/DAGabcdefgh/view?access=keep&utm_source=share","refreshIntervalSeconds":1800}`)
	got, err := s.PrepareWebIntegrationPreview(context.Background(), "canva", raw)
	var config map[string]any
	decodeErr := json.Unmarshal(got, &config)
	if err != nil || decodeErr != nil || config["canvaUrl"] != "https://www.canva.com/design/DAGabcdefgh/view?access=keep&embed=" {
		t.Fatalf("%s %v", got, err)
	}
	other, err := s.PrepareWebIntegrationPreview(context.Background(), "google-slides", raw)
	if err != nil || string(other) != string(raw) {
		t.Fatal("other integration changed")
	}
}
