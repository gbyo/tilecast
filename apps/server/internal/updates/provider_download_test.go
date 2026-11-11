package updates

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

type releaseAssetTestTransport struct {
	base     http.RoundTripper
	endpoint *url.URL
}

func (t releaseAssetTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = t.endpoint.Scheme
	clone.URL.Host = t.endpoint.Host
	return t.base.RoundTrip(clone)
}

func TestGitHubAssetDownloadOutlivesMetadataTimeout(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "[")
		w.(http.Flusher).Flush()
		select {
		case <-time.After(150 * time.Millisecond):
			_, _ = io.WriteString(w, "]")
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	provider := NewGitHubProvider("")
	provider.client.Transport = releaseAssetTestTransport{base: server.Client().Transport, endpoint: endpoint}
	provider.client.Timeout = 50 * time.Millisecond
	provider.apiBase = server.URL

	response, err := provider.Open(t.Context(), "https://api.github.com/repos/gbyo/tilecast/releases/assets/1")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || string(body) != "[]" {
		t.Fatalf("slow asset download: body=%q error=%v", body, err)
	}
	if provider.client.Timeout != 50*time.Millisecond {
		t.Fatal("asset download changed the shared metadata timeout")
	}
	if _, err := provider.Releases(t.Context(), ""); err == nil {
		t.Fatal("metadata requests lost their short timeout")
	}
}

func TestGitHubAssetDownloadHonorsCallerCancellation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "[")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	provider := NewGitHubProvider("")
	provider.client.Transport = releaseAssetTestTransport{base: server.Client().Transport, endpoint: endpoint}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	response, err := provider.Open(ctx, "https://api.github.com/repos/gbyo/tilecast/releases/assets/1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	cancel()
	if _, err := io.ReadAll(response.Body); !errors.Is(err, context.Canceled) {
		t.Fatalf("caller cancellation was not retained: %v", err)
	}
}
