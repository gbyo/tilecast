package contentdefs

import (
	"net/url"
	"reflect"
	"testing"
)

func TestCanvaURLs(t *testing.T) {
	definition, _ := MustLoad().Widget("canva")
	for _, raw := range []string{
		"https://www.canva.com/design/DAGabcdefgh/view",
		" https://CANVA.COM:443/design/DAGabcdefgh/access-token_123/view/?utm_source=share&access=keep&present=1#page2 ",
		"https://www.canva.com/%64esign/DAGabcdefgh/view?embed&access=keep",
	} {
		t.Run(raw, func(t *testing.T) {
			got, hosts, err := WebPresentationURL(definition, map[string]any{"canvaUrl": raw})
			if err != nil {
				t.Fatal(err)
			}
			u, _ := url.Parse(got)
			if u.Host != "www.canva.com" || !u.Query().Has("embed") || u.Query().Has("utm_source") || u.Fragment != "" || !reflect.DeepEqual(hosts, []string{"www.canva.com"}) {
				t.Fatalf("%s %v", got, hosts)
			}
			if original, _ := url.Parse(raw); original != nil && original.Query().Get("access") != "" && u.Query().Get("access") != "keep" {
				t.Fatal("access parameter lost")
			}
			again, _, err := WebPresentationURL(definition, map[string]any{"canvaUrl": got})
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
	if u, err := CanvaURL("https://canva.link/abc123"); err != nil || u.Host != "canva.link" {
		t.Fatalf("short URL: %v %v", u, err)
	}
	if _, _, err := WebPresentationURL(definition, map[string]any{"canvaUrl": "https://canva.link/abc123"}); err == nil {
		t.Fatal("unresolved short URL reached playback")
	}
}
