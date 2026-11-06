package web

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStudioAssetsAndNavigation(t *testing.T) {
	handler := staticHandler(fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte("<!doctype html><title>Studio</title>")},
		"assets/app-hash.js": &fstest.MapFile{Data: []byte("console.log('Studio')")},
	})
	for _, tc := range []struct {
		path, cache, body string
		status            int
	}{
		{"/", "no-cache", "<title>Studio</title>", 200},
		{"/screens/screen-id", "no-cache", "<title>Studio</title>", 200},
		{"/assets/app-hash.js", "public, max-age=31536000, immutable", "console.log", 200},
		{"/assets", "no-cache", "<title>Studio</title>", 200},
		{"/assets/previous-build.js", "no-cache", "404 page not found", 404},
		{"/assets/", "no-cache", "<title>Studio</title>", 200},
	} {
		t.Run(tc.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest("GET", tc.path, nil))
			if response.Code != tc.status || response.Header().Get("Cache-Control") != tc.cache || !strings.Contains(response.Body.String(), tc.body) {
				t.Fatalf("status=%d cache=%q body=%q", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
			}
		})
	}
}
