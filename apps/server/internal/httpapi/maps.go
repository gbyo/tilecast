package httpapi

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

const openFreeMapHost = "tiles.openfreemap.org"

var openFreeMapHTTPClient = &http.Client{
	Timeout: 20 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many OpenFreeMap redirects")
		}
		host := strings.ToLower(req.URL.Hostname())
		if host != openFreeMapHost && host != "assets.openfreemap.com" {
			return errors.New("OpenFreeMap redirected to an untrusted host")
		}
		return nil
	},
}

func (s *server) openFreeMapProxy(w http.ResponseWriter, r *http.Request) {
	if err := proxyOpenFreeMap(w, r, openFreeMapHTTPClient, &url.URL{
		Scheme: "https",
		Host:   openFreeMapHost,
	}); err != nil {
		if s.logger != nil {
			s.logger.WarnContext(r.Context(), "OpenFreeMap proxy request failed", "error", err)
		}
		writeError(w, http.StatusBadGateway, "map_upstream_unavailable", "Map data is temporarily unavailable.")
	}
}

func proxyOpenFreeMap(w http.ResponseWriter, r *http.Request, client *http.Client, upstreamBase *url.URL) error {
	resource := chi.URLParam(r, "*")
	target := *upstreamBase
	target.Path = "/" + strings.TrimPrefix(resource, "/")
	target.RawQuery = r.URL.RawQuery

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Tilecast-Server/0.9 (+https://github.com/gbyo/tilecast)")
	for _, header := range []string{"Accept", "If-None-Match", "If-Modified-Since", "Range"} {
		if value := r.Header.Get(header); value != "" {
			req.Header.Set(header, value)
		}
	}

	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	for _, header := range []string{
		"Content-Type",
		"Content-Encoding",
		"Cache-Control",
		"ETag",
		"Last-Modified",
		"Expires",
		"Accept-Ranges",
		"Vary",
	} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if r.Method == http.MethodHead || response.StatusCode == http.StatusNotModified {
		return nil
	}
	_, err = io.Copy(w, response.Body)
	return err
}
