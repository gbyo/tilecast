package catalog

// Marketplace artwork: listing icons and screenshots.
//
// Studio never loads a catalog image from the origin the catalog names.
// The server fetches each image itself, checks it, and serves it from a
// Tilecast path, so a browser never contacts GitHub or a publisher host
// and a listing can never aim a request at the operator's network.
//
// This is not a general image proxy. A request names a package and an
// artwork slot, never a URL. The server resolves the slot against the
// validated catalog and fetches only the address that listing declares.
// Every fetch is bounded in size, time, and redirects, carries no
// credentials, and refuses non-public addresses at connection time, so a
// hostname that resolves to a private address after validation still
// fails. Artwork is presentation only: a failed or missing image never
// affects listing identity, trust, or install.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

// ErrArtworkUnavailable answers any artwork request the server cannot
// serve: no such listing or slot, a failed fetch, or an image the server
// refuses. Callers treat every cause alike and show a fallback.
var ErrArtworkUnavailable = errors.New("marketplace artwork is unavailable")

const (
	// MaxScreenshots caps the screenshots one listing may declare.
	MaxScreenshots = 5
	// maxArtworkURLLength caps an artwork address.
	maxArtworkURLLength = 512
	// maxScreenshotAltLength caps screenshot alternative text.
	maxScreenshotAltLength = 200
	// MaxArtworkBytes caps one fetched image.
	MaxArtworkBytes = 1 << 20
	// artworkFetchTimeout bounds one artwork fetch end to end.
	artworkFetchTimeout = 10 * time.Second
	// artworkMaxRedirects bounds redirects followed for one fetch.
	artworkMaxRedirects = 3
	// artworkCacheTTL is how long a fetched image serves before the
	// server fetches it again.
	artworkCacheTTL = 24 * time.Hour
	// artworkFailureTTL is how long a failed fetch answers unavailable
	// without another attempt.
	artworkFailureTTL = 5 * time.Minute
	// artworkCacheBytes caps the image bytes the cache holds.
	artworkCacheBytes = 32 << 20
	// artworkCacheEntries caps cache entries, failures included.
	artworkCacheEntries = 256
)

// Artwork is one image the server verified and may serve.
type Artwork struct {
	Body        []byte
	ContentType string
	ETag        string
}

// ArtworkToken is a short stable token for one artwork address. Studio
// adds it to the artwork path so a changed address defeats browser
// caches. It is not a secret and not an integrity value.
func ArtworkToken(src string) string {
	sum := sha256.Sum256([]byte(src))
	return hex.EncodeToString(sum[:6])
}

// validateArtwork checks a listing's presentation metadata. It runs with
// the rest of listing validation, so a malformed icon or screenshot
// rejects the whole catalog document, as any other bad field does.
func validateArtwork(listing Listing) error {
	if listing.Icon != "" && !validArtworkURL(listing.Icon) {
		return errors.New("icon must be a public https image URL of at most 512 characters")
	}
	if len(listing.Screenshots) > MaxScreenshots {
		return fmt.Errorf("screenshots must hold at most %d entries", MaxScreenshots)
	}
	for index, shot := range listing.Screenshots {
		if !validArtworkURL(shot.Src) {
			return fmt.Errorf("screenshot %d src must be a public https image URL of at most 512 characters", index)
		}
		alt := strings.TrimSpace(shot.Alt)
		if alt == "" || utf8.RuneCountInString(alt) > maxScreenshotAltLength {
			return fmt.Errorf("screenshot %d alt must describe the image in 1 to %d characters", index, maxScreenshotAltLength)
		}
		for _, r := range alt {
			if unicode.IsControl(r) {
				return fmt.Errorf("screenshot %d alt must not contain control characters", index)
			}
		}
	}
	return nil
}

// validArtworkURL accepts an https address with a named host: no
// credentials, fragment, whitespace, or control characters, no IP
// literal, no local-looking name, and the default port only. The
// connection-time address check is the real boundary; this rejects
// obviously unusable addresses at review time.
func validArtworkURL(value string) bool {
	if value == "" || len(value) > maxArtworkURLLength {
		return false
	}
	for _, r := range value {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	if u.Path == "" || u.Path == "/" {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	return artworkHostAcceptable(u.Hostname())
}

func artworkHostAcceptable(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || !strings.Contains(host, ".") {
		return false
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return false
	}
	// A bare numeric or hexadecimal host such as 2130706433 is an address
	// in some resolvers; a real host name ends in a letter.
	last := host[strings.LastIndexByte(host, '.')+1:]
	if last == "" || !strings.ContainsFunc(last, unicode.IsLetter) {
		return false
	}
	for _, suffix := range []string{".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"} {
		if strings.HasSuffix(host, suffix) {
			return false
		}
	}
	return true
}

var blockedArtworkPrefixes = func() []netip.Prefix {
	var prefixes []netip.Prefix
	for _, cidr := range []string{
		"0.0.0.0/8",       // this network
		"100.64.0.0/10",   // carrier-grade NAT
		"192.0.0.0/24",    // IETF protocol assignments
		"192.0.2.0/24",    // documentation
		"198.18.0.0/15",   // benchmarking
		"198.51.100.0/24", // documentation
		"203.0.113.0/24",  // documentation
		"240.0.0.0/4",     // reserved and broadcast
		"64:ff9b::/96",    // NAT64: embeds an IPv4 address
		"64:ff9b:1::/48",  // local-use NAT64
		"2001:db8::/32",   // documentation
		"2002::/16",       // 6to4: embeds an IPv4 address
	} {
		prefixes = append(prefixes, netip.MustParsePrefix(cidr))
	}
	return prefixes
}()

// publicAddress reports whether ip is a globally routable unicast address
// the artwork fetch may connect to.
func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, prefix := range blockedArtworkPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

// guardedDialControl runs after name resolution with the address the
// socket is about to connect to, so it holds against DNS answers that
// change between validation and connection.
func guardedDialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("artwork address is malformed")
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !publicAddress(ip) {
		return errors.New("artwork host is not a public address")
	}
	return nil
}

// newArtworkClient builds the fetch client: no proxy, no cookies, no
// credentials, a bounded redirect chain that stays on acceptable https
// addresses, and a dialer that refuses non-public addresses.
func newArtworkClient() *http.Client {
	dialer := &net.Dialer{Timeout: artworkFetchTimeout, Control: guardedDialControl}
	return &http.Client{
		Timeout: artworkFetchTimeout,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			DisableKeepAlives:     true,
			TLSHandshakeTimeout:   artworkFetchTimeout,
			ResponseHeaderTimeout: artworkFetchTimeout,
		},
		CheckRedirect: artworkRedirectPolicy,
	}
}

func artworkRedirectPolicy(req *http.Request, via []*http.Request) error {
	if len(via) > artworkMaxRedirects {
		return errors.New("too many artwork redirects")
	}
	if !validArtworkURL(req.URL.String()) {
		return errors.New("artwork redirected to an unacceptable URL")
	}
	return nil
}

// sniffArtwork returns the canonical content type of a normal web raster
// image, or false. The server trusts its own reading of the bytes, never
// the origin's Content-Type, and serves no SVG: a vector image can carry
// script.
func sniffArtwork(body []byte) (string, bool) {
	head := body
	if len(head) > 512 {
		head = head[:512]
	}
	switch kind := http.DetectContentType(head); kind {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return kind, true
	}
	return "", false
}

type artworkEntry struct {
	artwork  Artwork
	stored   time.Time
	failed   bool
	size     int64
	lastUsed time.Time
}

type artworkCall struct {
	done    chan struct{}
	artwork Artwork
	err     error
}

// artworkCache fetches and holds verified listing images. The cache is
// process-local and rebuildable; a restart refetches on demand, so it
// adds nothing to backups.
type artworkCache struct {
	client *http.Client
	now    func() time.Time

	mu       sync.Mutex
	entries  map[string]*artworkEntry
	total    int64
	inflight map[string]*artworkCall
}

func newArtworkCache() *artworkCache {
	return &artworkCache{
		client:   newArtworkClient(),
		now:      time.Now,
		entries:  map[string]*artworkEntry{},
		inflight: map[string]*artworkCall{},
	}
}

// get serves src from the cache or fetches it. Concurrent requests for
// one address share one fetch. A fetch failure is cached briefly so a
// dead host is not retried on every page view.
func (c *artworkCache) get(ctx context.Context, src string) (Artwork, error) {
	if !validArtworkURL(src) {
		return Artwork{}, ErrArtworkUnavailable
	}
	c.mu.Lock()
	if entry, ok := c.entries[src]; ok {
		age := c.now().Sub(entry.stored)
		if entry.failed && age < artworkFailureTTL {
			c.mu.Unlock()
			return Artwork{}, ErrArtworkUnavailable
		}
		if !entry.failed && age < artworkCacheTTL {
			entry.lastUsed = c.now()
			artwork := entry.artwork
			c.mu.Unlock()
			return artwork, nil
		}
	}
	if call, ok := c.inflight[src]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.artwork, call.err
		case <-ctx.Done():
			return Artwork{}, ErrArtworkUnavailable
		}
	}
	call := &artworkCall{done: make(chan struct{})}
	c.inflight[src] = call
	c.mu.Unlock()

	// The fetch outlives a requester that goes away, so one canceled page
	// load neither wastes the work nor records a false failure.
	fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), artworkFetchTimeout)
	defer cancel()
	artwork, err := c.fetch(fetchCtx, src)

	c.mu.Lock()
	delete(c.inflight, src)
	c.record(src, artwork, err)
	c.mu.Unlock()
	call.artwork, call.err = artwork, err
	close(call.done)
	return artwork, err
}

// record stores a fetch outcome and evicts the oldest entries beyond the
// cache bounds. The caller holds c.mu.
func (c *artworkCache) record(src string, artwork Artwork, err error) {
	if old, ok := c.entries[src]; ok {
		c.total -= old.size
		delete(c.entries, src)
	}
	now := c.now()
	entry := &artworkEntry{stored: now, lastUsed: now}
	if err != nil {
		entry.failed = true
	} else {
		entry.artwork = artwork
		entry.size = int64(len(artwork.Body))
	}
	c.entries[src] = entry
	c.total += entry.size
	for c.total > artworkCacheBytes || len(c.entries) > artworkCacheEntries {
		var oldest string
		var oldestUsed time.Time
		for key, candidate := range c.entries {
			if key == src {
				continue
			}
			if oldest == "" || candidate.lastUsed.Before(oldestUsed) {
				oldest, oldestUsed = key, candidate.lastUsed
			}
		}
		if oldest == "" {
			return
		}
		c.total -= c.entries[oldest].size
		delete(c.entries, oldest)
	}
}

func (c *artworkCache) fetch(ctx context.Context, src string) (Artwork, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return Artwork{}, ErrArtworkUnavailable
	}
	request.Header.Set("User-Agent", "Tilecast-Server (+https://github.com/gbyo/tilecast)")
	request.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/webp")
	response, err := c.client.Do(request)
	if err != nil {
		return Artwork{}, ErrArtworkUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > MaxArtworkBytes {
		return Artwork{}, ErrArtworkUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxArtworkBytes+1))
	if err != nil || len(body) == 0 || len(body) > MaxArtworkBytes {
		return Artwork{}, ErrArtworkUnavailable
	}
	contentType, ok := sniffArtwork(body)
	if !ok {
		return Artwork{}, ErrArtworkUnavailable
	}
	sum := sha256.Sum256(body)
	return Artwork{
		Body:        body,
		ContentType: contentType,
		ETag:        `"` + hex.EncodeToString(sum[:8]) + `"`,
	}, nil
}

// SetArtworkTransport replaces the artwork fetch transport. Tests use it
// to serve images without the network; production keeps the guarded
// default. Address validation still applies to every URL.
func (s *Service) SetArtworkTransport(transport http.RoundTripper) {
	s.artwork.client = &http.Client{
		Timeout:       artworkFetchTimeout,
		Transport:     transport,
		CheckRedirect: artworkRedirectPolicy,
	}
}

// IconArtwork serves a listing's icon.
func (s *Service) IconArtwork(ctx context.Context, packageID string) (Artwork, error) {
	listing, _, err := s.ListingFor(ctx, packageID)
	if err != nil || listing.Icon == "" {
		return Artwork{}, ErrArtworkUnavailable
	}
	return s.artwork.get(ctx, listing.Icon)
}

// ScreenshotArtwork serves one of a listing's screenshots.
func (s *Service) ScreenshotArtwork(ctx context.Context, packageID string, index int) (Artwork, error) {
	listing, _, err := s.ListingFor(ctx, packageID)
	if err != nil || index < 0 || index >= len(listing.Screenshots) {
		return Artwork{}, ErrArtworkUnavailable
	}
	return s.artwork.get(ctx, listing.Screenshots[index].Src)
}
