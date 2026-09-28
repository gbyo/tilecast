package media

import (
	"context"
	"testing"
)

func websiteService(allow bool) *Service {
	return &Service{cfg: Config{Website: WebsitePolicy{AllowPrivateHTTP: allow, DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500}}}
}
func validWebsite() WebsiteInput {
	return WebsiteInput{Name: "Public site", WebsiteConfig: WebsiteConfig{URL: "https://example.com/signage", JavaScriptEnabled: true, DOMStorageEnabled: true, CookiePolicy: "first_party", ReloadPolicy: "on_each_activation", LoadTimeoutSeconds: 20, ZoomPercent: 100, BackgroundColor: "#13231E", FailureBehavior: "placeholder"}}
}
func TestWebsiteURLAndHostPolicy(t *testing.T) {
	s := websiteService(false)
	in := validWebsite()
	got, err := s.normalizeWebsite(context.Background(), in)
	if err != nil || len(got.AllowedHosts) != 1 || got.AllowedHosts[0] != "example.com" {
		t.Fatalf("normalize=%#v %v", got, err)
	}
	bad := []string{"http://example.com", "file:///tmp/a", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com:8443"}
	for _, raw := range bad {
		in = validWebsite()
		in.URL = raw
		if _, err = s.normalizeWebsite(context.Background(), in); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	in = validWebsite()
	in.URL = "http://192.168.1.5/page"
	if _, err = websiteService(true).normalizeWebsite(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	in.URL = "http://203.0.113.2/page"
	if _, err = websiteService(true).normalizeWebsite(context.Background(), in); err == nil {
		t.Fatal("accepted public HTTP")
	}
}

func TestWebsiteRejectsIPv6Literals(t *testing.T) {
	// IPv6 navigation is out of scope for M11 remote web: the runtime
	// normalization and the helper policy refuse IPv6, so authoring must
	// fail explicitly rather than producing content no player can show.
	s := websiteService(true)
	urls := []string{
		"http://[::1]/page",
		"http://[fd00::1]/page",
		"http://[fe80::1]/page",
		"http://[::ffff:10.0.0.5]/page",
		"https://[2001:db8::1]/page",
		"http://[::1/page",
	}
	for _, raw := range urls {
		in := validWebsite()
		in.URL = raw
		if _, err := s.normalizeWebsite(context.Background(), in); err == nil {
			t.Errorf("accepted IPv6 website URL %s", raw)
		}
	}
	in := validWebsite()
	in.AllowedHosts = []string{"::1"}
	if _, err := s.normalizeWebsite(context.Background(), in); err == nil {
		t.Error("accepted IPv6 allowed host")
	}
	in = validWebsite()
	in.AllowedHosts = []string{"[fd00::1]"}
	if _, err := s.normalizeWebsite(context.Background(), in); err == nil {
		t.Error("accepted bracketed IPv6 allowed host")
	}
	// DNS names and IPv4 literals still pass.
	in = validWebsite()
	in.URL = "http://intranet.local/page"
	in.AllowedHosts = []string{"intranet.local", "10.0.0.5"}
	if _, err := s.normalizeWebsite(context.Background(), in); err != nil {
		t.Fatalf("rejected DNS/IPv4 website: %v", err)
	}
}
func TestWebsiteSettingsLimits(t *testing.T) {
	s := websiteService(false)
	in := validWebsite()
	in.CustomUserAgent = "bad\nagent"
	if _, err := s.normalizeWebsite(context.Background(), in); err == nil {
		t.Fatal("accepted control character")
	}
	in = validWebsite()
	in.ReloadPolicy = "interval"
	fast := 10
	in.RefreshIntervalSeconds = &fast
	if _, err := s.normalizeWebsite(context.Background(), in); err == nil {
		t.Fatal("accepted fast refresh")
	}
	in = validWebsite()
	in.ZoomPercent = 201
	if _, err := s.normalizeWebsite(context.Background(), in); err == nil {
		t.Fatal("accepted zoom")
	}
}
