package github

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseRepositoryURL(t *testing.T) {
	for _, raw := range []string{
		"https://github.com/example/tilecast-scoreboard",
		"https://github.com/example/tilecast-scoreboard/",
		"https://github.com/example/tilecast-scoreboard.git",
		"https://github.com/Example/Tilecast-Scoreboard",
		"  https://github.com/example/tilecast-scoreboard  ",
	} {
		repo, err := ParseRepositoryURL(raw)
		if err != nil {
			t.Fatalf("%q: %v", raw, err)
		}
		if repo.Owner != "example" || repo.Name != "tilecast-scoreboard" {
			t.Fatalf("%q: repo = %+v", raw, repo)
		}
		if repo.URL() != "https://github.com/example/tilecast-scoreboard" {
			t.Fatalf("%q: URL = %s", raw, repo.URL())
		}
	}
	for _, raw := range []string{
		"",
		"not a url",
		"http://github.com/example/tilecast-scoreboard",
		"https://user:pass@github.com/example/tilecast-scoreboard",
		"https://gitlab.com/example/tilecast-scoreboard",
		"https://github.com/example",
		"https://github.com/example/tilecast-scoreboard/releases",
		"https://github.com/-/tilecast-scoreboard",
		"https://github.com/example/" + strings.Repeat("n", 101),
	} {
		if _, err := ParseRepositoryURL(raw); !errors.Is(err, ErrRepositoryURL) {
			t.Fatalf("%q: err = %v, want ErrRepositoryURL", raw, err)
		}
	}
}

func TestClientBaseValidation(t *testing.T) {
	if _, err := NewClient("http://example.com", ""); err == nil {
		t.Fatal("expected cleartext base to fail")
	}
	if _, err := NewClient("https://user@example.com", ""); err == nil {
		t.Fatal("expected base with credentials to fail")
	}
	if _, err := NewClient("", ""); err != nil {
		t.Fatalf("default base: %v", err)
	}
}

func githubTestServer(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	return client, server
}

func TestRepo(t *testing.T) {
	ctx := context.Background()
	repo := Repository{Owner: "example", Name: "tilecast-scoreboard"}

	client, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/example/tilecast-scoreboard" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("token was not sent")
		}
		if r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			t.Error("API version header missing")
		}
		w.Write([]byte(`{"default_branch":"main","private":false}`))
	})
	branch, err := client.Repo(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if branch != "main" {
		t.Fatalf("branch = %s", branch)
	}

	private, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"default_branch":"main","private":true}`))
	})
	if _, err := private.Repo(ctx, repo); !errors.Is(err, ErrPrivate) {
		t.Fatalf("private repo err = %v, want ErrPrivate", err)
	}

	missing, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	if _, err := missing.Repo(ctx, repo); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing repo err = %v, want ErrNotFound", err)
	}
}

func TestLatestRelease(t *testing.T) {
	ctx := context.Background()
	repo := Repository{Owner: "example", Name: "tilecast-scoreboard"}

	client, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/example/tilecast-scoreboard/releases/latest" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"tag_name":"v2.4.1","name":"2.4.1","published_at":"2026-01-02T03:04:05Z"}`))
	})
	release, err := client.LatestRelease(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if release.Tag != "v2.4.1" || release.Name != "2.4.1" {
		t.Fatalf("release = %+v", release)
	}
	if release.PublishedAt.Year() != 2026 {
		t.Fatalf("published = %v", release.PublishedAt)
	}

	none, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	if _, err := none.LatestRelease(ctx, repo); !errors.Is(err, ErrNoRelease) {
		t.Fatalf("no release err = %v, want ErrNoRelease", err)
	}

	limited, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
	})
	if _, err := limited.LatestRelease(ctx, repo); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("rate limited err = %v, want ErrRateLimited", err)
	}
}

func TestManifest(t *testing.T) {
	ctx := context.Background()
	repo := Repository{Owner: "example", Name: "tilecast-scoreboard"}
	manifest := `{"apiVersion":1,"packageId":"example.scoreboard"}`
	encoded := base64.StdEncoding.EncodeToString([]byte(manifest))

	client, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/example/tilecast-scoreboard/contents/tilecast.package.json" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("ref") != "v2.4.1" {
			t.Errorf("ref = %s", r.URL.Query().Get("ref"))
		}
		w.Write([]byte(`{"type":"file","encoding":"base64","content":"` + encoded + `"}`))
	})
	raw, err := client.Manifest(ctx, repo, "v2.4.1")
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != manifest {
		t.Fatalf("manifest = %s", raw)
	}

	missing, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	if _, err := missing.Manifest(ctx, repo, "v2.4.1"); !errors.Is(err, ErrNoManifest) {
		t.Fatalf("missing manifest err = %v, want ErrNoManifest", err)
	}

	notFile, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"type":"dir","encoding":"none","content":""}`))
	})
	if _, err := notFile.Manifest(ctx, repo, "v2.4.1"); !errors.Is(err, ErrNoManifest) {
		t.Fatalf("directory manifest err = %v, want ErrNoManifest", err)
	}

	if _, err := client.Manifest(ctx, repo, ""); err == nil {
		t.Fatal("expected empty ref to fail")
	}
}

func TestAttestations(t *testing.T) {
	ctx := context.Background()
	repo := Repository{Owner: "example", Name: "tilecast-scoreboard"}

	client, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/example/tilecast-scoreboard/attestations/sha256:abc123" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"attestations":[{"bundle":{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}},{"bundle":{}}]}`))
	})
	bundles, err := client.Attestations(ctx, repo, "sha256:abc123")
	if err != nil {
		t.Fatal(err)
	}
	if len(bundles) != 2 {
		t.Fatalf("bundles = %d, want 2", len(bundles))
	}

	none, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	bundles, err = none.Attestations(ctx, repo, "sha256:abc123")
	if err != nil || len(bundles) != 0 {
		t.Fatalf("bundles = %d, err = %v, want empty and nil", len(bundles), err)
	}

	if _, err := client.Attestations(ctx, repo, ""); err == nil {
		t.Fatal("expected empty digest to fail")
	}
}

func TestClientRejectsBadRedirect(t *testing.T) {
	client, server := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.com/elsewhere", http.StatusFound)
	})
	_ = server
	_, err := client.Repo(context.Background(), Repository{Owner: "example", Name: "tilecast-scoreboard"})
	if err == nil || !strings.Contains(err.Error(), "unacceptable URL") {
		t.Fatalf("redirect err = %v, want unacceptable URL", err)
	}
}

func TestClientCapsBody(t *testing.T) {
	client, _ := githubTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write(make([]byte, maxBodyBytes+100))
	})
	_, err := client.Repo(context.Background(), Repository{Owner: "example", Name: "tilecast-scoreboard"})
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversize err = %v, want exceeds", err)
	}
}
