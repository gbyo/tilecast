// Package serverurl normalizes and verifies the Tilecast server address a
// remote operator connects to. The rules mirror the player manual-entry
// policy: whitespace and one trailing slash go away, an explicit port is
// preserved, only HTTP and HTTPS are allowed, and plain HTTP stays
// confined to loopback, private, link-local, localhost, and .local names.
// Public hosts require HTTPS, and the scheme is never silently downgraded.
package serverurl

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

var (
	ErrEmpty      = errors.New("server address is empty")
	ErrBadScheme  = errors.New("server address must use http or https")
	ErrPublicHTTP = errors.New("plain HTTP is only allowed for local and private addresses; public hosts require https")
	ErrBadHost    = errors.New("server address needs a host name")
)

// Normalize cleans raw user input into the canonical server base URL with
// no trailing slash. A missing scheme means https.
func Normalize(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ErrEmpty
	}
	if !strings.Contains(trimmed, "://") {
		trimmed = "https://" + trimmed
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("parse server address: %w", err)
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", ErrBadScheme
	}
	host := parsed.Hostname()
	if host == "" {
		return "", ErrBadHost
	}
	if scheme == "http" && !localHost(host) {
		return "", ErrPublicHTTP
	}
	parsed.Scheme = scheme
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.User = nil
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

// localHost reports whether plain HTTP may serve the host: loopback,
// private IPv4, link-local, localhost, and .local names.
func localHost(host string) bool {
	lowered := strings.ToLower(strings.TrimSuffix(host, "."))
	if lowered == "localhost" || strings.HasSuffix(lowered, ".localhost") || strings.HasSuffix(lowered, ".local") || lowered == "local" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}
