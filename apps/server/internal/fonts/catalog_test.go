package fonts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const testList = `[
 {"id":"inter","family":"Inter","subsets":["cyrillic","latin"],"weights":[100,400,900],"styles":["italic","normal"],"defSubset":"latin","variable":true,"category":"sans-serif","license":"OFL-1.1","type":"google"},
 {"id":"lobster","family":"Lobster","subsets":["latin"],"weights":[400],"styles":["normal"],"defSubset":"latin","variable":false,"category":"display","license":"OFL-1.1","type":"google"},
 {"id":"not-google","family":"Other","subsets":["latin"],"weights":[400],"styles":["normal"],"defSubset":"latin","variable":false,"category":"display","license":"OFL-1.1","type":"other"},
 {"id":"Bad ID","family":"Bad","subsets":["latin"],"weights":[400],"styles":["normal"],"defSubset":"latin","variable":false,"category":"serif","license":"OFL-1.1","type":"google"}
]`

func catalogServer(t *testing.T, requests *int32) (*Catalog, *httptest.Server) {
	t.Helper()
	mux := http.NewServeMux()
	var server *httptest.Server
	mux.HandleFunc("/v1/fonts", func(w http.ResponseWriter, r *http.Request) {
		if requests != nil {
			atomic.AddInt32(requests, 1)
		}
		if r.URL.Query().Get("type") != "google" {
			t.Errorf("listing must ask for Google families, got %q", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(testList))
	})
	mux.HandleFunc("/v1/fonts/inter", func(w http.ResponseWriter, r *http.Request) {
		cdn := server.URL + "/cdn/"
		_, _ = w.Write([]byte(`{"id":"inter","family":"Inter","subsets":["cyrillic","latin"],"weights":[100,400,900],"styles":["italic","normal"],"defSubset":"latin","variable":true,"category":"sans-serif","license":"OFL-1.1","type":"google","npmVersion":"5.3.0",
		 "unicodeRange":{"latin":"U+0000-00FF,U+0131","cyrillic":"U+0400-045F"},
		 "variants":{"400":{"normal":{"latin":{"url":{"woff2":"` + cdn + `inter@5.3.0/latin-400-normal.woff2"}},"cyrillic":{"url":{"woff2":"` + cdn + `inter@5.3.0/cyrillic-400-normal.woff2"}}},
		                    "italic":{"latin":{"url":{"woff2":"` + cdn + `inter@5.3.0/latin-400-italic.woff2"}},"cyrillic":{"url":{"woff2":"` + cdn + `inter@5.3.0/cyrillic-400-italic.woff2"}}}}}}`))
	})
	mux.HandleFunc("/v1/variable/inter", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"family":"Inter","axes":{"wght":{"default":"400","min":"100","max":"900","step":"1"}}}`))
	})
	mux.HandleFunc("/v1/fonts/lobster", func(w http.ResponseWriter, r *http.Request) {
		cdn := server.URL + "/cdn/"
		_, _ = w.Write([]byte(`{"id":"lobster","family":"Lobster","subsets":["latin"],"weights":[400],"styles":["normal"],"defSubset":"latin","variable":false,"category":"display","license":"OFL-1.1","type":"google","npmVersion":"5.2.1",
		 "unicodeRange":{"latin":"U+0000-00FF"},
		 "variants":{"400":{"normal":{"latin":{"url":{"woff2":"` + cdn + `lobster@5.2.1/latin-400-normal.woff2"}}}}}}`))
	})
	mux.HandleFunc("/v1/fonts/noto-sans-jp", func(w http.ResponseWriter, r *http.Request) {
		cdn := server.URL + "/cdn/"
		_, _ = w.Write([]byte(`{"id":"noto-sans-jp","family":"Noto Sans JP","subsets":["japanese","latin"],"weights":[400],"styles":["normal"],"defSubset":"japanese","variable":false,"category":"sans-serif","license":"OFL-1.1","type":"google","npmVersion":"5.2.5",
		 "unicodeRange":{"[0]":"U+25ee8,U+25f23","[1]":"U+1f235-1f23b","[10]":"U+9fa0-9fff","latin":"U+0000-00FF"},
		 "variants":{"400":{"normal":{"0":{"url":{"woff2":"` + cdn + `noto-sans-jp@5.2.5/0-400-normal.woff2"}},"1":{"url":{"woff2":"` + cdn + `noto-sans-jp@5.2.5/1-400-normal.woff2"}},"10":{"url":{"woff2":"` + cdn + `noto-sans-jp@5.2.5/10-400-normal.woff2"}},"latin":{"url":{"woff2":"` + cdn + `noto-sans-jp@5.2.5/latin-400-normal.woff2"}}}}}}`))
	})
	mux.HandleFunc("/v1/variable/", http.NotFound)
	mux.HandleFunc("/cdn/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "not-woff2") {
			_, _ = w.Write([]byte("<html>"))
			return
		}
		_, _ = w.Write([]byte("wOF2" + strings.Repeat("x", 32)))
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	catalog := NewCatalog(false)
	catalog.APIBase = server.URL
	catalog.CDNBase = server.URL + "/cdn/"
	catalog.Client = server.Client()
	return catalog, server
}

func TestCatalogSearchKeepsValidGoogleFamiliesAndCaches(t *testing.T) {
	var requests int32
	catalog, _ := catalogServer(t, &requests)
	page, err := catalog.Search(context.Background(), "", "", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || page.Families[0].ID != "inter" || page.Families[1].ID != "lobster" {
		t.Fatalf("unexpected listing %+v", page)
	}
	page, err = catalog.Search(context.Background(), "LOB", "display", 10, 0)
	if err != nil || page.Total != 1 || page.Families[0].Family != "Lobster" {
		t.Fatalf("filtered listing %+v %v", page, err)
	}
	if got := atomic.LoadInt32(&requests); got != 1 {
		t.Fatalf("listing must be cached, fetched %d times", got)
	}
}

func TestCatalogDisabledMakesNoRequests(t *testing.T) {
	var requests int32
	catalog, _ := catalogServer(t, &requests)
	catalog.Disabled = true
	if _, err := catalog.Search(context.Background(), "", "", 0, 0); !errors.Is(err, ErrCatalogDisabled) {
		t.Fatalf("want disabled, got %v", err)
	}
	if _, err := catalog.Detail(context.Background(), "inter"); !errors.Is(err, ErrCatalogDisabled) {
		t.Fatalf("want disabled, got %v", err)
	}
	if requests != 0 {
		t.Fatal("a disabled catalog must not contact the network")
	}
}

func TestPlanVariableImportUsesOneFilePerSubsetAndStyle(t *testing.T) {
	catalog, server := catalogServer(t, nil)
	detail, err := catalog.Detail(context.Background(), "inter")
	if err != nil {
		t.Fatal(err)
	}
	if detail.WeightRange == nil || detail.WeightRange[0] != 100 || detail.WeightRange[1] != 900 {
		t.Fatalf("variable axis not read: %+v", detail.WeightRange)
	}
	files, subsets, err := planGoogleImport(detail, catalog.CDNBase, GoogleImport{SourceID: "inter", Subsets: []string{"latin", "cyrillic"}, Styles: []string{"normal", "italic"}, Weights: []int{700}})
	if err != nil {
		t.Fatal(err)
	}
	if len(subsets) != 2 || len(files) != 4 {
		t.Fatalf("want 4 files for 2 subsets x 2 styles, got %d", len(files))
	}
	first := files[0]
	if first.URL != server.URL+"/cdn/inter:vf@5.3.0/latin-wght-normal.woff2" || first.WeightMin != 100 || first.WeightMax != 900 || first.UnicodeRange != "U+0000-00FF,U+0131" {
		t.Fatalf("unexpected variable file %+v", first)
	}
}

func TestPlanStaticImportDefaultsToRegularAndRejectsUnknownSelections(t *testing.T) {
	catalog, server := catalogServer(t, nil)
	detail, err := catalog.Detail(context.Background(), "lobster")
	if err != nil {
		t.Fatal(err)
	}
	files, _, err := planGoogleImport(detail, catalog.CDNBase, GoogleImport{SourceID: "lobster"})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].URL != server.URL+"/cdn/lobster@5.2.1/latin-400-normal.woff2" || files[0].WeightMin != 400 || files[0].Style != "normal" {
		t.Fatalf("unexpected static plan %+v", files)
	}
	for _, request := range []GoogleImport{
		{Subsets: []string{"greek"}},
		{Styles: []string{"italic"}},
		{Weights: []int{700}},
		{Styles: []string{"oblique"}},
	} {
		if _, _, err := planGoogleImport(detail, catalog.CDNBase, request); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%+v: want invalid selection, got %v", request, err)
		}
	}
}

func TestPlanSlicedSubsetTakesEveryNumberedSlice(t *testing.T) {
	catalog, _ := catalogServer(t, nil)
	detail, err := catalog.Detail(context.Background(), "noto-sans-jp")
	if err != nil {
		t.Fatal(err)
	}
	files, _, err := planGoogleImport(detail, catalog.CDNBase, GoogleImport{Subsets: []string{"japanese"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 {
		t.Fatalf("want the three numbered slices, got %d", len(files))
	}
	if !strings.HasSuffix(files[2].URL, "/10-400-normal.woff2") || files[2].UnicodeRange != "U+9fa0-9fff" {
		t.Fatalf("slices must be in numeric order with their ranges: %+v", files[2])
	}
}

func TestDownloadRefusesOtherHostsAndNonWOFF2(t *testing.T) {
	catalog, server := catalogServer(t, nil)
	if _, err := catalog.download(context.Background(), "https://example.com/font.woff2", 1<<20); !errors.Is(err, ErrCatalogUnavailable) {
		t.Fatalf("want refusal for another host, got %v", err)
	}
	if _, err := catalog.download(context.Background(), catalog.CDNBase+"../escape.woff2", 1<<20); !errors.Is(err, ErrCatalogUnavailable) {
		t.Fatalf("want refusal for a traversal, got %v", err)
	}
	if _, err := catalog.download(context.Background(), server.URL+"/cdn/not-woff2.woff2", 1<<20); !errors.Is(err, ErrCatalogUnavailable) {
		t.Fatalf("want refusal for a non-WOFF2 body, got %v", err)
	}
	if _, err := catalog.download(context.Background(), server.URL+"/cdn/ok.woff2", 8); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want size limit, got %v", err)
	}
	data, err := catalog.download(context.Background(), server.URL+"/cdn/ok.woff2", 1<<20)
	if err != nil || string(data[:4]) != "wOF2" {
		t.Fatalf("valid download failed: %v", err)
	}
}

func TestPreviewUsesRegularDefaultSubset(t *testing.T) {
	catalog, _ := catalogServer(t, nil)
	data, err := catalog.Preview(context.Background(), "inter")
	if err != nil || string(data[:4]) != "wOF2" {
		t.Fatalf("preview failed: %v", err)
	}
	if _, err := catalog.Detail(context.Background(), "../etc"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invalid IDs must not reach the network, got %v", err)
	}
}

func TestDownloadFollowsOnlyRedirectsInsideTheCDN(t *testing.T) {
	var outsideHits int32
	outside := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&outsideHits, 1)
		_, _ = w.Write([]byte("wOF2" + strings.Repeat("x", 32)))
	}))
	t.Cleanup(outside.Close)
	mux := http.NewServeMux()
	mux.HandleFunc("/cdn/inside.woff2", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/cdn/ok.woff2", http.StatusFound)
	})
	mux.HandleFunc("/cdn/away.woff2", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, outside.URL+"/steal.woff2", http.StatusFound)
	})
	mux.HandleFunc("/cdn/ok.woff2", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("wOF2" + strings.Repeat("x", 32)))
	})
	cdn := httptest.NewServer(mux)
	t.Cleanup(cdn.Close)
	catalog := NewCatalog(false)
	catalog.APIBase = cdn.URL
	catalog.CDNBase = cdn.URL + "/cdn/"
	catalog.Client = cdn.Client()

	if _, err := catalog.download(context.Background(), cdn.URL+"/cdn/inside.woff2", 1<<20); err != nil {
		t.Fatalf("a redirect inside the CDN must work: %v", err)
	}
	if _, err := catalog.download(context.Background(), cdn.URL+"/cdn/away.woff2", 1<<20); !errors.Is(err, ErrCatalogUnavailable) {
		t.Fatalf("a redirect to another host must be refused, got %v", err)
	}
	if hits := atomic.LoadInt32(&outsideHits); hits != 0 {
		t.Fatalf("the other host was contacted %d times", hits)
	}
	if catalog.Client.CheckRedirect != nil {
		t.Fatal("the supplied client must not be changed")
	}
}
