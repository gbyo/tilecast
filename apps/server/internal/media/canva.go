package media

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

const canvaResolveTimeout = 5 * time.Second
const canvaMaximumRedirects = 5

// PrepareWebIntegrationPreview uses the same authoring normalization as save.
// Playback compilation stays pure: the resolved design URL is stored in the
// existing URL field, so manifests never depend on the short-link service.
func (s *Service) PrepareWebIntegrationPreview(ctx context.Context, provider string, raw json.RawMessage) (json.RawMessage, error) {
	definition, ok := s.definitions.Widget(provider)
	if !ok || definition.WebIntegration == nil || definition.WebIntegration.Transform != "canva_embed" {
		return raw, nil
	}
	config, err := (webDefinitionWidgetProvider{s, definition}).Normalize(ctx, raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(config)
}

func resolveCanvaShortLink(ctx context.Context, raw string, client *http.Client) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, canvaResolveTimeout)
	defer cancel()
	seen := map[string]bool{}
	for redirects := 0; redirects <= canvaMaximumRedirects; redirects++ {
		u, err := contentdefs.CanvaURL(raw)
		if err != nil {
			return "", err
		}
		if u.Host == "www.canva.com" {
			return u.String(), nil
		}
		if seen[u.String()] || redirects == canvaMaximumRedirects {
			return "", errors.New("Canva short link has too many redirects; copy its public embed link instead")
		}
		seen[u.String()] = true
		// The request authority is fixed independently of the submitted URL.
		// Only the validated short-link path and query are caller-controlled.
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://canva.link/", nil)
		if err != nil {
			return "", errors.New("Canva short link is invalid; copy the link again")
		}
		request.URL.Path = u.Path
		request.URL.RawQuery = u.RawQuery
		// No incoming headers, cookies, credentials, cookie jar, or proxy.
		request.Header.Set("User-Agent", "Tilecast-Canva-Link/1")
		response, err := client.Do(request)
		if err != nil {
			return "", errors.New("Canva short link could not be resolved; try again or paste the public embed link")
		}
		response.Body.Close() // Only Location is needed. Never read or scrape HTML.
		if response.StatusCode != 301 && response.StatusCode != 302 && response.StatusCode != 303 && response.StatusCode != 307 && response.StatusCode != 308 {
			return "", errors.New("Canva short link is unavailable or is not a design link; obtain a public embed link from Canva")
		}
		next, err := response.Location()
		if err != nil {
			return "", errors.New("Canva short link has no valid destination; obtain a new public embed link")
		}
		raw = next.String()
	}
	return "", errors.New("Canva short link could not be resolved")
}

func canvaLinkClient() *http.Client {
	policy := SourceFetchPolicy{Timeout: canvaResolveTimeout}
	transport := sourceHTTPTransport(policy, net.DefaultResolver.LookupIPAddr, (&net.Dialer{Timeout: canvaResolveTimeout}).DialContext)
	transport.MaxResponseHeaderBytes = 16 * 1024
	// Resolve manually and stop at the validated design destination; never
	// fetch a design, login page, arbitrary host, or a response body.
	return &http.Client{Transport: transport, Timeout: canvaResolveTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}
