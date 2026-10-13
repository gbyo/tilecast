package contentdefs

import (
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestCanvaURLs(t *testing.T) {
	definition, _ := MustLoad().Widget("canva")
	tests := []struct {
		name          string
		raw           string
		setSlideshow  bool
		slideshow     bool
		wantMode      string
	}{
		{"legacy view stays manual", "https://www.canva.com/design/DAGabcdefgh/view", false, false, "view"},
		{"watch input normalizes manual when disabled", "https://www.canva.com/design/DAGabcdefgh/watch?access=keep", true, false, "view"},
		{"view input becomes watch when enabled", "https://www.canva.com/design/DAGabcdefgh/view?access=keep", true, true, "watch"},
		{"watch stays watch when enabled", "https://www.canva.com/design/DAGabcdefgh/watch?access=keep", true, true, "watch"},
		{"access path and parameters survive", " https://CANVA.COM:443/design/DAGabcdefgh/access-token_123/view/?utm_source=share&access=keep&present=1#page2 ", true, true, "watch"},
		{"encoded design path", "https://www.canva.com/%64esign/DAGabcdefgh/view?embed&access=keep", false, false, "view"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			configuration := map[string]any{"canvaUrl": tc.raw}
			if tc.setSlideshow {
				configuration["slideshow"] = tc.slideshow
			}
			got, hosts, err := WebPresentationURL(definition, configuration)
			if err != nil {
				t.Fatal(err)
			}
			u, _ := url.Parse(got)
			if u.Host != "www.canva.com" || !u.Query().Has("embed") || u.Query().Has("utm_source") || u.Fragment != "" || !reflect.DeepEqual(hosts, []string{"www.canva.com"}) {
				t.Fatalf("%s %v", got, hosts)
			}
			if gotMode := u.Path[strings.LastIndex(u.Path, "/")+1:]; gotMode != tc.wantMode {
				t.Fatalf("mode = %q, want %q (%s)", gotMode, tc.wantMode, got)
			}
			if original, _ := url.Parse(tc.raw); original != nil && original.Query().Get("access") != "" && u.Query().Get("access") != "keep" {
				t.Fatal("access parameter lost")
			}
			againConfiguration := map[string]any{"canvaUrl": got}
			if tc.setSlideshow {
				againConfiguration["slideshow"] = tc.slideshow
			}
			again, _, err := WebPresentationURL(definition, againConfiguration)
			if err != nil || again != got {
				t.Fatalf("not idempotent: %s %v", again, err)
			}
		})
	}
	for _, raw := range []string{
		"http://www.canva.com/design/DAGabcdefgh/view", "https://evil.example/design/DAGabcdefgh/view", "https://www.canva.com.evil.example/design/DAGabcdefgh/view",
		"https://user@www.canva.com/design/DAGabcdefgh/view", "https://www.canva.com:444/design/DAGabcdefgh/view", "https://www.canva.com/design/DAGabcdefgh/edit",
		"https://www.canva.com/design/DAGabcdefgh/present", "https://www.canva.com/design/DAGabcdefgh/view/extra", "https://www.canva.com/design/DAGabcdefgh%2Fview/view",
		"https://www.canva.com/design/DAGabcdefgh/view?access=%zz", "not a URL", "https://www.canva.com/design/DAGabcdefgh/view?x=1;x=2", "https://canva.link/one/two", "https://127.0.0.1/link", "https://www.canva.com./design/DAGabcdefgh/view",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := CanvaURL(raw); err == nil {
				t.Fatal("accepted unsupported URL")
			}
		})
	}
	for _, raw := range []string{
		"https://www.canva.com/design/DAGabcdefgh/view",
		"https://www.canva.com/design/DAGabcdefgh/watch",
	} {
		if _, err := CanvaURL(raw); err != nil {
			t.Fatalf("supported design URL %q: %v", raw, err)
		}
	}
	if u, err := CanvaURL("https://canva.link/abc123"); err != nil || u.Host != "canva.link" {
		t.Fatalf("short URL: %v %v", u, err)
	}
	if _, _, err := WebPresentationURL(definition, map[string]any{"canvaUrl": "https://canva.link/abc123"}); err == nil {
		t.Fatal("unresolved short URL reached playback")
	}
}
