package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestServeDefaultLoginBackground(t *testing.T) {
	t.Parallel()

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		rec := httptest.NewRecorder()
		serveDefaultLoginBackground(rec, httptest.NewRequest(method, "/api/v1/auth/background", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", method, rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); got != "image/webp" {
			t.Fatalf("%s content type = %q, want image/webp", method, got)
		}
		if method == http.MethodGet && rec.Body.Len() != len(defaultLoginBackground) {
			t.Fatalf("GET body = %d bytes, want %d", rec.Body.Len(), len(defaultLoginBackground))
		}
	}
	if len(defaultLoginBackground) < 12 || string(defaultLoginBackground[8:12]) != "WEBP" {
		t.Fatal("embedded default login background is not a WebP image")
	}
}
