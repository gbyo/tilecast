package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/media"
)

func TestServeDeliveryRangesAndConditions(t *testing.T) {
	path := t.TempDir() + "/asset.bin"
	content := []byte("0123456789abcdef")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	delivery := media.Delivery{Path: path, MIMEType: "video/mp4", Size: int64(len(content)), HashHex: "aabbcc"}
	tests := []struct {
		name, method, rangeHeader string
		status                    int
		body                      string
	}{{"full", "GET", "", 200, string(content)}, {"head", "HEAD", "", 200, ""}, {"initial", "GET", "bytes=0-3", 206, "0123"}, {"middle", "GET", "bytes=4-7", 206, "4567"}, {"suffix", "GET", "bytes=-4", 206, "cdef"}, {"invalid", "GET", "bytes=abc", 416, ""}, {"unsatisfiable", "GET", "bytes=99-100", 416, ""}}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, "/media", nil)
			if tc.rangeHeader != "" {
				request.Header.Set("Range", tc.rangeHeader)
			}
			response := httptest.NewRecorder()
			serveDelivery(response, request, delivery)
			if response.Code != tc.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if tc.body != "" && response.Body.String() != tc.body {
				t.Fatalf("body=%q", response.Body.String())
			}
			if response.Header().Get("Accept-Ranges") != "bytes" {
				t.Fatal("missing Accept-Ranges")
			}
		})
	}
	request := httptest.NewRequest(http.MethodGet, "/media", nil)
	request.Header.Set("If-None-Match", media.ETag(delivery.HashHex))
	response := httptest.NewRecorder()
	serveDelivery(response, request, delivery)
	if response.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match status=%d", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "/media", nil)
	request.Header.Set("Range", "bytes=0-3")
	request.Header.Set("If-Range", `"different"`)
	response = httptest.NewRecorder()
	serveDelivery(response, request, delivery)
	if response.Code != http.StatusOK || response.Body.String() != string(content) {
		t.Fatalf("If-Range response=%d %q", response.Code, response.Body.String())
	}
}
