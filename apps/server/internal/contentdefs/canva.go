package contentdefs

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var canvaDesignPath = regexp.MustCompile(`^/design/[A-Za-z0-9_-]{8,200}(?:/[A-Za-z0-9_-]{8,200})?/view/?$`)
var canvaShortPath = regexp.MustCompile(`^/[A-Za-z0-9_-]{1,200}/?$`)

// CanvaURL accepts only design view/embed links or a short link awaiting resolution.
// URL validity cannot establish that the owner has published a public embed.
func CanvaURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.User != nil || u.Opaque != "" || (u.Port() != "" && u.Port() != "443") {
		return nil, errors.New("Canva link must use HTTPS without credentials or a custom port")
	}
	host := strings.ToLower(u.Hostname())
	if host != "www.canva.com" && host != "canva.com" && host != "canva.link" {
		return nil, errors.New("Unsupported Canva host; copy a public design or embed link from Canva")
	}
	u.Fragment, u.RawFragment = "", ""
	u.RawPath = ""
	u.Host = host
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, errors.New("Canva link contains an invalid query; copy the link again from Canva")
	}
	if host == "canva.link" {
		if !canvaShortPath.MatchString(u.Path) {
			return nil, errors.New("Unsupported Canva short link; copy the public view or embed link from Canva")
		}
	} else {
		if !canvaDesignPath.MatchString(u.Path) {
			return nil, errors.New("Unsupported Canva URL; use Share > See all > Embed and copy the Smart embed link or the HTML iframe's src URL")
		}
		u.Host = "www.canva.com"
		u.Path = strings.TrimSuffix(u.Path, "/")
		// Preserve access and presentation parameters. Only known marketing fields
		// are removed; no undocumented autoplay or loop parameters are invented.
		for key := range query {
			if strings.HasPrefix(strings.ToLower(key), "utm_") {
				query.Del(key)
			}
		}
		query.Set("embed", "")
	}
	u.RawQuery = query.Encode()
	return u, nil
}
