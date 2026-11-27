package plugin

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Origin is the security boundary of an outbound connection: a scheme, a
// host, and an effective port. A path, a query, a fragment, and user
// information are never part of an origin.
//
// The TypeScript half (parseOrigin in src/connections.ts) applies the same
// rules. packages/plugin-sdk/testdata/origins.json runs in both.
type Origin struct {
	Scheme string
	Host   string
	Port   int
}

// Origin schemes. Later phases add stream and socket schemes.
const (
	SchemeHTTPS = "https"
	SchemeHTTP  = "http"
)

// ErrInvalidOrigin answers an origin that is malformed or not canonical.
var ErrInvalidOrigin = errors.New("invalid origin")

var dnsLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// MaxOriginLength bounds the text of one origin.
const MaxOriginLength = 300

func defaultPort(scheme string) int {
	if scheme == SchemeHTTP {
		return 80
	}
	return 443
}

// String returns the canonical text: lower case, no default port, no
// trailing slash. An IPv6 host is bracketed.
func (o Origin) String() string {
	host := o.Host
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if o.Port == defaultPort(o.Scheme) {
		return o.Scheme + "://" + host
	}
	return o.Scheme + "://" + host + ":" + strconv.Itoa(o.Port)
}

// IsZero reports whether the origin is unset.
func (o Origin) IsZero() bool { return o.Scheme == "" }

// HostIsIP reports whether the host is an IP literal.
func (o Origin) HostIsIP() bool {
	_, err := netip.ParseAddr(o.Host)
	return err == nil
}

// Authority is host:port for dialing.
func (o Origin) Authority() string {
	host := o.Host
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return host + ":" + strconv.Itoa(o.Port)
}

// ParseOrigin reads an origin that an operator typed. It accepts any letter
// case, an explicit default port, and one trailing slash, and returns the
// canonical origin. It refuses a path, a query, a fragment, user
// information, a scheme other than http or https, a non-ASCII host, and a
// localhost name, which is always a loopback address.
func ParseOrigin(raw string) (Origin, error) {
	invalid := func(reason string) (Origin, error) {
		return Origin{}, fmt.Errorf("%w: %s", ErrInvalidOrigin, reason)
	}
	text := strings.TrimSpace(raw)
	if text == "" || len(text) > MaxOriginLength {
		return invalid("enter an origin such as https://example.com")
	}
	for _, r := range text {
		if r < 0x21 || r > 0x7e {
			return invalid("an origin holds only printable ASCII characters")
		}
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return invalid("the origin is not a valid URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != SchemeHTTPS && scheme != SchemeHTTP {
		return invalid("the scheme must be https or http")
	}
	if parsed.Opaque != "" || parsed.Host == "" {
		return invalid("the origin needs a host")
	}
	if parsed.User != nil {
		return invalid("an origin cannot hold a user name or password")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || strings.Contains(text, "#") {
		return invalid("an origin cannot hold a query or a fragment")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return invalid("an origin cannot hold a path")
	}
	host := strings.ToLower(parsed.Hostname())
	port := defaultPort(scheme)
	if value := parsed.Port(); value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 1 || number > 65535 || strings.HasPrefix(value, "0") {
			return invalid("the port must be a number from 1 to 65535")
		}
		port = number
	} else if strings.HasSuffix(parsed.Host, ":") {
		return invalid("the port must be a number from 1 to 65535")
	}
	if address, err := netip.ParseAddr(host); err == nil {
		if address.Zone() != "" {
			return invalid("an IPv6 zone is not allowed")
		}
		if address.Is4In6() {
			address = address.Unmap()
		}
		host = address.String()
	} else {
		if strings.Contains(parsed.Host, "[") {
			return invalid("the IPv6 address is not valid")
		}
		host = strings.TrimSuffix(host, ".")
		if len(host) > 253 {
			return invalid("the host name is too long")
		}
		labels := strings.Split(host, ".")
		for _, label := range labels {
			if !dnsLabelPattern.MatchString(label) {
				return invalid("the host name is not valid")
			}
		}
		if allDigits(labels[len(labels)-1]) {
			return invalid("the host name is not valid")
		}
		if host == "localhost" || strings.HasSuffix(host, ".localhost") {
			return invalid("localhost is a loopback address, which a plugin connection never reaches")
		}
	}
	return Origin{Scheme: scheme, Host: host, Port: port}, nil
}

func allDigits(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

// ParseCanonicalOrigin reads an origin that a manifest declares. The text
// must already be canonical: what ParseOrigin returns, written back.
func ParseCanonicalOrigin(raw string) (Origin, error) {
	origin, err := ParseOrigin(raw)
	if err != nil {
		return Origin{}, err
	}
	if origin.String() != raw {
		return Origin{}, fmt.Errorf("%w: write %q as %q", ErrInvalidOrigin, raw, origin.String())
	}
	return origin, nil
}

// OriginOf returns the origin of an absolute URL.
func OriginOf(u *url.URL) (Origin, error) {
	if u == nil || u.Host == "" {
		return Origin{}, fmt.Errorf("%w: the URL is not absolute", ErrInvalidOrigin)
	}
	return ParseOrigin((&url.URL{Scheme: u.Scheme, Host: u.Host}).String())
}
