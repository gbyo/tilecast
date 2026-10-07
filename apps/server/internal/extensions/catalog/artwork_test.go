package catalog

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testPNG(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// artworkTransport answers every artwork request with one handler and
// records what the server sent.
type artworkTransport struct {
	mu       sync.Mutex
	requests []*http.Request
	handler  func(*http.Request) (*http.Response, error)
}

func (a *artworkTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	a.mu.Lock()
	a.requests = append(a.requests, request)
	a.mu.Unlock()
	return a.handler(request)
}

func (a *artworkTransport) count() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.requests)
}

func response(status int, header http.Header, body []byte) *http.Response {
	if header == nil {
		header = http.Header{}
	}
	return &http.Response{
		StatusCode:    status,
		Header:        header,
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

func cacheWith(handler func(*http.Request) (*http.Response, error)) (*artworkCache, *artworkTransport) {
	transport := &artworkTransport{handler: handler}
	cache := newArtworkCache()
	cache.client = &http.Client{Transport: transport, CheckRedirect: artworkRedirectPolicy}
	return cache, transport
}

const testArtworkURL = "https://images.example.com/acme/icon.png"

func TestValidateArtworkAccepts(t *testing.T) {
	listing := validTestListing()
	listing.Icon = testArtworkURL
	listing.Screenshots = []Screenshot{
		{Src: "https://images.example.com/acme/one.png", Alt: "The scoreboard on a lobby display."},
		{Src: "https://cdn.example.org/two.webp?size=large", Alt: "The schedule view."},
	}
	if err := validateListing(listing); err != nil {
		t.Fatalf("listing with artwork rejected: %v", err)
	}
}

func TestValidateArtworkRejects(t *testing.T) {
	screenshot := func(src, alt string) []Screenshot { return []Screenshot{{Src: src, Alt: alt}} }
	tooMany := make([]Screenshot, MaxScreenshots+1)
	for index := range tooMany {
		tooMany[index] = Screenshot{Src: testArtworkURL, Alt: "A screenshot."}
	}
	for name, mutate := range map[string]func(*Listing){
		"http icon":             func(l *Listing) { l.Icon = "http://images.example.com/icon.png" },
		"ftp icon":              func(l *Listing) { l.Icon = "ftp://images.example.com/icon.png" },
		"relative icon":         func(l *Listing) { l.Icon = "/icon.png" },
		"data icon":             func(l *Listing) { l.Icon = "data:image/png;base64,AAAA" },
		"ip literal icon":       func(l *Listing) { l.Icon = "https://203.0.113.9/icon.png" },
		"loopback icon":         func(l *Listing) { l.Icon = "https://127.0.0.1/icon.png" },
		"ipv6 icon":             func(l *Listing) { l.Icon = "https://[::1]/icon.png" },
		"decimal host icon":     func(l *Listing) { l.Icon = "https://2130706433/icon.png" },
		"localhost icon":        func(l *Listing) { l.Icon = "https://localhost/icon.png" },
		"single label icon":     func(l *Listing) { l.Icon = "https://intranet/icon.png" },
		"local suffix icon":     func(l *Listing) { l.Icon = "https://printer.local/icon.png" },
		"internal suffix icon":  func(l *Listing) { l.Icon = "https://metadata.internal/icon.png" },
		"credentialed icon":     func(l *Listing) { l.Icon = "https://user:pass@images.example.com/icon.png" },
		"fragment icon":         func(l *Listing) { l.Icon = "https://images.example.com/icon.png#x" },
		"custom port icon":      func(l *Listing) { l.Icon = "https://images.example.com:8443/icon.png" },
		"bare host icon":        func(l *Listing) { l.Icon = "https://images.example.com" },
		"whitespace icon":       func(l *Listing) { l.Icon = "https://images.example.com/a b.png" },
		"control icon":          func(l *Listing) { l.Icon = "https://images.example.com/a\x00.png" },
		"long icon":             func(l *Listing) { l.Icon = "https://images.example.com/" + strings.Repeat("a", 520) },
		"too many screenshots":  func(l *Listing) { l.Screenshots = tooMany },
		"http screenshot":       func(l *Listing) { l.Screenshots = screenshot("http://images.example.com/a.png", "Alt.") },
		"private screenshot":    func(l *Listing) { l.Screenshots = screenshot("https://10.0.0.5/a.png", "Alt.") },
		"empty screenshot src":  func(l *Listing) { l.Screenshots = screenshot("", "Alt.") },
		"missing alt":           func(l *Listing) { l.Screenshots = screenshot(testArtworkURL, "") },
		"blank alt":             func(l *Listing) { l.Screenshots = screenshot(testArtworkURL, "   ") },
		"long alt":              func(l *Listing) { l.Screenshots = screenshot(testArtworkURL, strings.Repeat("a", 201)) },
		"control character alt": func(l *Listing) { l.Screenshots = screenshot(testArtworkURL, "Line\nbreak") },
	} {
		t.Run(name, func(t *testing.T) {
			listing := validTestListing()
			mutate(&listing)
			if err := validateListing(listing); err == nil {
				t.Fatalf("%s: expected a rejection", name)
			}
		})
	}
}

func TestParseCatalogRejectsUnknownArtworkFields(t *testing.T) {
	for _, listing := range []string{
		`"icon":"https://images.example.com/a.png","screenshots":[{"src":"https://images.example.com/a.png","alt":"A.","caption":"x"}]`,
		`"screenshots":[{"src":"https://images.example.com/a.png","alt":"A.","width":10}]`,
		`"artwork":{"icon":"https://images.example.com/a.png"}`,
	} {
		base := string(encodeTestDocument(t, []Listing{validTestListing()}))
		document := strings.Replace(base, `"featured":true`, `"featured":true,`+listing, 1)
		if _, err := ParseCatalog([]byte(document)); err == nil {
			t.Fatalf("%s: expected a rejection", listing)
		}
	}
}

func TestParseCatalogCarriesArtwork(t *testing.T) {
	listing := validTestListing()
	listing.Icon = testArtworkURL
	listing.Screenshots = []Screenshot{{Src: testArtworkURL, Alt: "A screenshot."}}
	document, err := ParseCatalog(encodeTestDocument(t, []Listing{listing}))
	if err != nil {
		t.Fatal(err)
	}
	if got := document.Listings[0]; got.Icon != testArtworkURL || len(got.Screenshots) != 1 || got.Screenshots[0].Alt != "A screenshot." {
		t.Fatalf("listing = %+v", got)
	}
}

func TestPublicAddress(t *testing.T) {
	for address, want := range map[string]bool{
		"140.82.112.3":        true,
		"185.199.108.133":     true,
		"2606:50c0:8000::154": true,
		"127.0.0.1":           false,
		"10.1.2.3":            false,
		"172.16.0.1":          false,
		"192.168.1.1":         false,
		"169.254.169.254":     false,
		"100.64.0.1":          false,
		"0.0.0.0":             false,
		"224.0.0.1":           false,
		"240.0.0.1":           false,
		"255.255.255.255":     false,
		"198.18.0.1":          false,
		"::1":                 false,
		"::":                  false,
		"fe80::1":             false,
		"fc00::1":             false,
		"ff02::1":             false,
		"::ffff:127.0.0.1":    false,
		"::ffff:10.0.0.1":     false,
		"64:ff9b::7f00:1":     false,
		"2002:7f00:1::1":      false,
		"2001:db8::1":         false,
		"::ffff:140.82.112.3": true,
	} {
		ip := netip.MustParseAddr(address)
		if got := publicAddress(ip); got != want {
			t.Errorf("publicAddress(%s) = %v, want %v", address, got, want)
		}
	}
}

func TestArtworkClientIsolation(t *testing.T) {
	client := newArtworkClient()
	if client.Jar != nil {
		t.Fatal("artwork client must not keep cookies")
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatal("artwork client must not use an environment proxy")
	}
	if client.Timeout <= 0 || client.Timeout > 30*time.Second {
		t.Fatalf("artwork client timeout = %s", client.Timeout)
	}
}

// TestArtworkDialRefusesNonPublicAddress proves the connection-time
// guard: the fetch skips URL validation here, so only the dial check
// stands between the request and a loopback server.
func TestArtworkDialRefusesNonPublicAddress(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write(testPNG(t))
	}))
	defer server.Close()
	cache := newArtworkCache()
	if _, err := cache.fetch(context.Background(), server.URL+"/icon.png"); !errors.Is(err, ErrArtworkUnavailable) {
		t.Fatalf("fetch = %v, want unavailable", err)
	}
	if hits.Load() != 0 {
		t.Fatal("the loopback server received a request")
	}
}

func TestArtworkRefusesInvalidAddress(t *testing.T) {
	cache, transport := cacheWith(func(*http.Request) (*http.Response, error) {
		return response(http.StatusOK, nil, testPNG(t)), nil
	})
	for _, src := range []string{"", "http://images.example.com/a.png", "https://127.0.0.1/a.png", "https://images.example.com"} {
		if _, err := cache.get(context.Background(), src); !errors.Is(err, ErrArtworkUnavailable) {
			t.Errorf("get(%q) = %v, want unavailable", src, err)
		}
	}
	if transport.count() != 0 {
		t.Fatal("an invalid address reached the network")
	}
}

func TestArtworkServesVerifiedImageFromCache(t *testing.T) {
	cache, transport := cacheWith(func(*http.Request) (*http.Response, error) {
		// The origin's Content-Type is ignored: the server reads the bytes.
		return response(http.StatusOK, http.Header{"Content-Type": {"application/octet-stream"}}, testPNG(t)), nil
	})
	first, err := cache.get(context.Background(), testArtworkURL)
	if err != nil {
		t.Fatal(err)
	}
	if first.ContentType != "image/png" || first.ETag == "" || len(first.Body) == 0 {
		t.Fatalf("artwork = %+v", first)
	}
	second, err := cache.get(context.Background(), testArtworkURL)
	if err != nil || second.ETag != first.ETag {
		t.Fatalf("second = %+v, %v", second, err)
	}
	if transport.count() != 1 {
		t.Fatalf("origin fetched %d times, want 1", transport.count())
	}
}

func TestArtworkSendsNoCredentials(t *testing.T) {
	cache, transport := cacheWith(func(*http.Request) (*http.Response, error) {
		return response(http.StatusOK, nil, testPNG(t)), nil
	})
	ctx := context.Background()
	if _, err := cache.get(ctx, testArtworkURL); err != nil {
		t.Fatal(err)
	}
	header := transport.requests[0].Header
	for _, name := range []string{"Cookie", "Authorization", "Proxy-Authorization", "X-Csrf-Token"} {
		if header.Get(name) != "" {
			t.Errorf("artwork request carried %s", name)
		}
	}
}

func TestArtworkRefusesUnsafeResponses(t *testing.T) {
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	html := []byte("<!doctype html><html><body>not an image</body></html>")
	oversized := append(testPNG(t), make([]byte, MaxArtworkBytes)...)
	for name, reply := range map[string]func() (*http.Response, error){
		"svg": func() (*http.Response, error) {
			return response(200, http.Header{"Content-Type": {"image/svg+xml"}}, svg), nil
		},
		"html as image": func() (*http.Response, error) {
			return response(200, http.Header{"Content-Type": {"image/png"}}, html), nil
		},
		"empty":           func() (*http.Response, error) { return response(200, nil, nil), nil },
		"oversized":       func() (*http.Response, error) { return response(200, nil, oversized), nil },
		"not found":       func() (*http.Response, error) { return response(404, nil, testPNG(t)), nil },
		"server error":    func() (*http.Response, error) { return response(500, nil, nil), nil },
		"transport error": func() (*http.Response, error) { return nil, errors.New("dial failed") },
		"declared too big": func() (*http.Response, error) {
			r := response(200, nil, testPNG(t))
			r.ContentLength = MaxArtworkBytes + 1
			return r, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			cache, _ := cacheWith(func(*http.Request) (*http.Response, error) { return reply() })
			if _, err := cache.get(context.Background(), testArtworkURL); !errors.Is(err, ErrArtworkUnavailable) {
				t.Fatalf("get = %v, want unavailable", err)
			}
		})
	}
}

func TestArtworkRedirects(t *testing.T) {
	redirect := func(location string) func(*http.Request) (*http.Response, error) {
		return func(request *http.Request) (*http.Response, error) {
			if request.URL.String() == testArtworkURL {
				return response(http.StatusFound, http.Header{"Location": {location}}, nil), nil
			}
			return response(http.StatusOK, nil, testPNG(t)), nil
		}
	}
	t.Run("same-scheme redirect to another host is followed", func(t *testing.T) {
		cache, _ := cacheWith(redirect("https://cdn.example.net/icon.png"))
		if _, err := cache.get(context.Background(), testArtworkURL); err != nil {
			t.Fatalf("get = %v", err)
		}
	})
	for name, location := range map[string]string{
		"downgrade to http":     "http://cdn.example.net/icon.png",
		"redirect to loopback":  "https://127.0.0.1/icon.png",
		"redirect to metadata":  "https://169.254.169.254/latest/meta-data",
		"redirect to localhost": "https://localhost/icon.png",
	} {
		t.Run(name, func(t *testing.T) {
			cache, transport := cacheWith(redirect(location))
			if _, err := cache.get(context.Background(), testArtworkURL); !errors.Is(err, ErrArtworkUnavailable) {
				t.Fatalf("get = %v, want unavailable", err)
			}
			if transport.count() != 1 {
				t.Fatalf("followed the redirect: %d requests", transport.count())
			}
		})
	}
	t.Run("redirect loop is bounded", func(t *testing.T) {
		cache, transport := cacheWith(func(*http.Request) (*http.Response, error) {
			return response(http.StatusFound, http.Header{"Location": {testArtworkURL}}, nil), nil
		})
		if _, err := cache.get(context.Background(), testArtworkURL); !errors.Is(err, ErrArtworkUnavailable) {
			t.Fatalf("get = %v, want unavailable", err)
		}
		if transport.count() > artworkMaxRedirects+1 {
			t.Fatalf("%d requests for a redirect loop", transport.count())
		}
	})
}

func TestArtworkFailureIsCachedBriefly(t *testing.T) {
	clock := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	failing := true
	cache, transport := cacheWith(func(*http.Request) (*http.Response, error) {
		if failing {
			return response(http.StatusBadGateway, nil, nil), nil
		}
		return response(http.StatusOK, nil, testPNG(t)), nil
	})
	cache.now = func() time.Time { return clock }
	ctx := context.Background()
	for range 3 {
		if _, err := cache.get(ctx, testArtworkURL); !errors.Is(err, ErrArtworkUnavailable) {
			t.Fatalf("get = %v", err)
		}
	}
	if transport.count() != 1 {
		t.Fatalf("a dead host was fetched %d times within the failure window", transport.count())
	}
	clock = clock.Add(artworkFailureTTL + time.Second)
	failing = false
	if _, err := cache.get(ctx, testArtworkURL); err != nil {
		t.Fatalf("recovery get = %v", err)
	}
	clock = clock.Add(artworkCacheTTL + time.Second)
	if _, err := cache.get(ctx, testArtworkURL); err != nil || transport.count() != 3 {
		t.Fatalf("expired entry refetch: err=%v requests=%d", err, transport.count())
	}
}

func TestArtworkSharesConcurrentFetches(t *testing.T) {
	release := make(chan struct{})
	cache, transport := cacheWith(func(*http.Request) (*http.Response, error) {
		<-release
		return response(http.StatusOK, nil, testPNG(t)), nil
	})
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := cache.get(context.Background(), testArtworkURL); err != nil {
				t.Errorf("get = %v", err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if transport.count() != 1 {
		t.Fatalf("concurrent requests fetched %d times, want 1", transport.count())
	}
}

func TestArtworkCacheStaysBounded(t *testing.T) {
	cache := newArtworkCache()
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for index := range artworkCacheEntries + 40 {
		cache.record("https://images.example.com/"+strings.Repeat("a", index%7)+string(rune('a'+index%26))+"/"+strconv.Itoa(index), Artwork{Body: []byte{1}}, nil)
	}
	if len(cache.entries) > artworkCacheEntries {
		t.Fatalf("cache holds %d entries, cap %d", len(cache.entries), artworkCacheEntries)
	}
	big := make([]byte, MaxArtworkBytes)
	for index := range 60 {
		cache.record("https://big.example.com/"+strconv.Itoa(index), Artwork{Body: big}, nil)
	}
	if cache.total > artworkCacheBytes {
		t.Fatalf("cache holds %d bytes, cap %d", cache.total, artworkCacheBytes)
	}
}

func TestTokenChangesWithAddress(t *testing.T) {
	if ArtworkToken(testArtworkURL) == ArtworkToken(testArtworkURL+"?v=2") {
		t.Fatal("token ignores the address")
	}
	if ArtworkToken(testArtworkURL) != ArtworkToken(testArtworkURL) {
		t.Fatal("token is unstable")
	}
}
