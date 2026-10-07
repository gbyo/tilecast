// Package github resolves a public GitHub repository to the extension
// package it publishes, without cloning, building, or executing anything.
//
// Resolution follows the published release: the repository must exist and
// be public, its latest published release names the version, and
// tilecast.package.json at that release declares the package identity and
// the OCI repository that carries the bytes. The OCI tag resolved later
// is the release tag verbatim, so author CI publishes images tagged with
// the git tag it builds from.
package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/ghrepo"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

var (
	// ErrRepositoryURL answers input that is not a public GitHub
	// repository address. It aliases the shared parser error so
	// errors.Is matches across both packages.
	ErrRepositoryURL = ghrepo.ErrRepositoryURL
	// ErrNotFound answers a repository, release, or file GitHub does
	// not have.
	ErrNotFound = errors.New("GitHub has no such repository, release, or file")
	// ErrPrivate answers a repository the public API does not serve.
	// Private repositories are out of scope for this release.
	ErrPrivate = errors.New("private GitHub repositories are not supported")
	// ErrNoRelease answers a repository with no published release.
	ErrNoRelease = errors.New("repository has no published release")
	// ErrNoManifest answers a release whose tree holds no readable
	// tilecast.package.json.
	ErrNoManifest = errors.New("release has no tilecast.package.json")
	// ErrRateLimited answers GitHub rate limiting.
	ErrRateLimited = errors.New("GitHub rate limit reached")
)

const (
	// apiVersion pins the GitHub REST API surface this client speaks.
	apiVersion = "2022-11-28"
	// requestTimeout bounds one GitHub request.
	requestTimeout = 30 * time.Second
	// maxBodyBytes caps one GitHub response before it parses. The
	// manifest document itself stays far below this; the cap only stops
	// a hostile or confused upstream from filling memory.
	maxBodyBytes = 1 << 20
)

// Repository is the canonical parsed repository address. The parser lives
// in internal/ghrepo so the marketplace catalog and the installer share
// it; this package re-exports the shared names its callers use.
type Repository = ghrepo.Repository

// ParseRepositoryURL accepts a public GitHub repository address. See
// internal/ghrepo for the accepted forms. No request is made.
func ParseRepositoryURL(raw string) (Repository, error) {
	return ghrepo.ParseRepositoryURL(raw)
}

// Release is the published release resolution pins: the tag that names
// both the git ref the manifest is read from and the OCI tag resolved
// later.
type Release struct {
	Tag         string
	Name        string
	PublishedAt time.Time
}

// Client reads public repository metadata through the GitHub REST API.
// The token is optional and only raises rate limits; it is never
// required and never sent anywhere but the API base.
type Client struct {
	client  *http.Client
	apiBase string
	token   string
}

// NewClient targets apiBase, defaulting to the public GitHub API. A
// custom base must still be https, except loopback for development and
// tests.
func NewClient(apiBase, token string) (*Client, error) {
	base := strings.TrimRight(strings.TrimSpace(apiBase), "/")
	if base == "" {
		base = "https://api.github.com"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.User != nil || parsed.Hostname() == "" {
		return nil, fmt.Errorf("GitHub API base %q is invalid", apiBase)
	}
	if parsed.Scheme != "https" && !loopback(parsed.Hostname()) {
		return nil, fmt.Errorf("GitHub API base %q must be https", apiBase)
	}
	client := &http.Client{Timeout: requestTimeout}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many GitHub redirects")
		}
		if req.URL.Scheme != "https" && !loopback(req.URL.Hostname()) {
			return errors.New("GitHub redirected to an unacceptable URL")
		}
		return nil
	}
	return &Client{client: client, apiBase: base, token: strings.TrimSpace(token)}, nil
}

func loopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Repo confirms the repository exists and is public, and reports its
// default branch. Private repositories answer ErrPrivate: this release
// resolves public repositories only.
func (c *Client) Repo(ctx context.Context, repo Repository) (string, error) {
	var body struct {
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
	}
	if err := c.get(ctx, "/repos/"+repo.Owner+"/"+repo.Name, &body); err != nil {
		return "", err
	}
	if body.Private {
		return "", ErrPrivate
	}
	if body.DefaultBranch == "" {
		return "", fmt.Errorf("GitHub repository %s has no default branch", repo.URL())
	}
	return body.DefaultBranch, nil
}

// LatestRelease reports the latest published release. GitHub excludes
// drafts and prereleases from this endpoint. A repository with no
// published release answers ErrNoRelease.
func (c *Client) LatestRelease(ctx context.Context, repo Repository) (Release, error) {
	var body struct {
		TagName     string `json:"tag_name"`
		Name        string `json:"name"`
		PublishedAt string `json:"published_at"`
	}
	if err := c.get(ctx, "/repos/"+repo.Owner+"/"+repo.Name+"/releases/latest", &body); err != nil {
		if errors.Is(err, ErrNotFound) {
			return Release{}, ErrNoRelease
		}
		return Release{}, err
	}
	if body.TagName == "" {
		return Release{}, fmt.Errorf("GitHub release for %s has no tag", repo.URL())
	}
	release := Release{Tag: body.TagName, Name: body.Name}
	if body.PublishedAt != "" {
		published, err := time.Parse(time.RFC3339, body.PublishedAt)
		if err != nil {
			return Release{}, fmt.Errorf("GitHub release for %s has an unreadable publish time", repo.URL())
		}
		release.PublishedAt = published
	}
	return release, nil
}

// Attestations fetches the Sigstore bundles GitHub holds for an artifact
// digest. Each bundle is returned as raw JSON for the provenance
// verifier. An artifact with no attestations answers an empty list, not
// an error: absence of provenance is a verification decision, not a
// fetch failure.
func (c *Client) Attestations(ctx context.Context, repo Repository, artifactDigest string) ([][]byte, error) {
	if strings.TrimSpace(artifactDigest) == "" {
		return nil, errors.New("attestation digest must not be empty")
	}
	var body struct {
		Attestations []struct {
			Bundle json.RawMessage `json:"bundle"`
		} `json:"attestations"`
	}
	path := "/repos/" + repo.Owner + "/" + repo.Name + "/attestations/" + url.PathEscape(artifactDigest)
	if err := c.get(ctx, path, &body); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	bundles := make([][]byte, 0, len(body.Attestations))
	for _, attestation := range body.Attestations {
		if len(attestation.Bundle) == 0 {
			continue
		}
		bundles = append(bundles, bytes.Clone(attestation.Bundle))
		// A handful of bundles is plenty: author CI attests once per
		// artifact, and the verifier tries each in turn.
		if len(bundles) >= 8 {
			break
		}
	}
	return bundles, nil
}

// Manifest reads tilecast.package.json at ref, usually a release tag. A
// missing or unreadable file answers ErrNoManifest. The bytes are
// returned unparsed: manifest validation owns their meaning.
func (c *Client) Manifest(ctx context.Context, repo Repository, ref string) (json.RawMessage, error) {
	if strings.TrimSpace(ref) == "" {
		return nil, errors.New("manifest ref must not be empty")
	}
	var body struct {
		Type     string `json:"type"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
	}
	path := "/repos/" + repo.Owner + "/" + repo.Name + "/contents/tilecast.package.json?ref=" + url.QueryEscape(ref)
	if err := c.get(ctx, path, &body); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, ErrNoManifest
		}
		return nil, err
	}
	if body.Type != "file" || body.Encoding != "base64" || body.Content == "" {
		return nil, ErrNoManifest
	}
	raw, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(body.Content), ""))
	if err != nil {
		return nil, fmt.Errorf("%w: manifest content is not base64", ErrNoManifest)
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("%w: manifest content is not JSON", ErrNoManifest)
	}
	return json.RawMessage(bytes.Clone(raw)), nil
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiBase+path, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", apiVersion)
	request.Header.Set("User-Agent", "Tilecast-Server/"+version.Display()+" (+https://github.com/gbyo/tilecast)")
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("GitHub request failed: %w", err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusForbidden, http.StatusTooManyRequests:
		if rateLimited(response) {
			return ErrRateLimited
		}
		return fmt.Errorf("GitHub answered HTTP %d", response.StatusCode)
	default:
		return fmt.Errorf("GitHub answered HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes+1))
	if err != nil {
		return fmt.Errorf("GitHub request failed: %w", err)
	}
	if int64(len(raw)) > maxBodyBytes {
		return fmt.Errorf("GitHub response exceeds %d bytes", maxBodyBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(out); err != nil {
		return fmt.Errorf("GitHub response is not JSON: %w", err)
	}
	return nil
}

// rateLimited reads the rate-limit signal GitHub sends: a zero
// remaining budget, or a retry-After on a 403.
func rateLimited(response *http.Response) bool {
	if response.Header.Get("X-RateLimit-Remaining") == "0" {
		return true
	}
	return response.StatusCode == http.StatusForbidden && response.Header.Get("Retry-After") != ""
}
