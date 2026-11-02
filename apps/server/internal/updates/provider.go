package updates

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	GitHubOwner = "gbyo"
	GitHubRepo  = "tilecast"
)

type Asset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

type ProviderRelease struct {
	ID          int64     `json:"id"`
	Tag         string    `json:"tag_name"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	PublishedAt time.Time `json:"published_at"`
	Assets      []Asset   `json:"assets"`
}

type ProviderResult struct {
	Releases    []ProviderRelease
	ETag        string
	NotModified bool
	RateReset   *time.Time
}

type Provider interface {
	Releases(context.Context, string) (ProviderResult, error)
	Download(context.Context, string, int64) ([]byte, error)
	Open(context.Context, string) (*http.Response, error)
}

type GitHubProvider struct {
	client    *http.Client
	apiBase   string
	oauthBase string
	mu        sync.RWMutex
	token     string
}

type DeviceAuthorization struct {
	DeviceCode      string
	UserCode        string
	VerificationURI string
	ExpiresIn       time.Duration
	Interval        time.Duration
}

type DeviceTokenResult struct {
	AccessToken string
	Status      string
	SlowDown    bool
}

func NewGitHubProvider(token string) *GitHubProvider {
	client := &http.Client{Timeout: 30 * time.Second}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many GitHub redirects")
		}
		host := strings.ToLower(req.URL.Hostname())
		if host != "github.com" && host != "api.github.com" && !strings.HasSuffix(host, ".githubusercontent.com") {
			return errors.New("GitHub asset redirected to an untrusted host")
		}
		return nil
	}
	return &GitHubProvider{client: client, apiBase: "https://api.github.com", oauthBase: "https://github.com", token: strings.TrimSpace(token)}
}

const (
	releasesPageSize = 100
	// maxReleasePages bounds one check at 500 releases. The repository also
	// publishes Server and WPE releases, so the newest player release is not
	// always on the first page, and an old one can be several pages deep.
	maxReleasePages     = 5
	maxReleasePageBytes = 8 << 20
)

// Releases lists published GitHub releases, newest first, across up to
// maxReleasePages pages. Only the first page is conditional: GitHub's ETag
// covers one page, and a new release always lands on the first. A 304 on the
// first page therefore means nothing changed.
func (p *GitHubProvider) Releases(ctx context.Context, etag string) (ProviderResult, error) {
	var result ProviderResult
	for page := 1; page <= maxReleasePages; page++ {
		pageResult, count, err := p.releasesPage(ctx, page, etag)
		if page == 1 {
			result.ETag, result.RateReset, result.NotModified = pageResult.ETag, pageResult.RateReset, pageResult.NotModified
		}
		if err != nil {
			return result, err
		}
		if result.NotModified {
			return result, nil
		}
		result.Releases = append(result.Releases, pageResult.Releases...)
		if count < releasesPageSize {
			break
		}
	}
	return result, nil
}

func (p *GitHubProvider) releasesPage(ctx context.Context, page int, etag string) (ProviderResult, int, error) {
	pageURL := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=%d&page=%d", p.apiBase, GitHubOwner, GitHubRepo, releasesPageSize, page)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	p.headers(req)
	if etag != "" && page == 1 {
		req.Header.Set("If-None-Match", etag)
	}
	response, err := p.client.Do(req)
	if err != nil {
		return ProviderResult{}, 0, fmt.Errorf("GitHub release request failed: %w", err)
	}
	defer response.Body.Close()
	result := ProviderResult{ETag: response.Header.Get("ETag")}
	if reset, parseErr := strconv.ParseInt(response.Header.Get("X-RateLimit-Reset"), 10, 64); parseErr == nil && reset > 0 {
		value := time.Unix(reset, 0).UTC()
		result.RateReset = &value
	}
	if response.StatusCode == http.StatusNotModified {
		result.NotModified = true
		return result, 0, nil
	}
	if response.StatusCode == http.StatusForbidden && response.Header.Get("X-RateLimit-Remaining") == "0" {
		return result, 0, errors.New("GitHub API rate limit reached")
	}
	if response.StatusCode != http.StatusOK {
		return result, 0, fmt.Errorf("GitHub Releases returned HTTP %d", response.StatusCode)
	}
	var releases []ProviderRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, maxReleasePageBytes)).Decode(&releases); err != nil {
		return result, 0, errors.New("GitHub returned an invalid release response")
	}
	for _, release := range releases {
		if !release.Draft {
			result.Releases = append(result.Releases, release)
		}
	}
	return result, len(releases), nil
}

func (p *GitHubProvider) Download(ctx context.Context, rawURL string, maximum int64) ([]byte, error) {
	response, err := p.Open(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub asset returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maximum {
		return nil, errors.New("GitHub asset exceeds the allowed size")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, errors.New("GitHub asset download failed")
	}
	if int64(len(body)) > maximum {
		return nil, errors.New("GitHub asset exceeds the allowed size")
	}
	return body, nil
}

func (p *GitHubProvider) Open(ctx context.Context, rawURL string) (*http.Response, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "api.github.com" || !strings.HasPrefix(parsed.Path, "/repos/"+GitHubOwner+"/"+GitHubRepo+"/releases/assets/") {
		return nil, errors.New("untrusted GitHub release asset URL")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	p.headers(req)
	req.Header.Set("Accept", "application/octet-stream")
	return p.client.Do(req)
}

func (p *GitHubProvider) headers(req *http.Request) {
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "Tilecast-Server/0.9 (+https://github.com/gbyo/tilecast)")
	if token := p.currentToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

func (p *GitHubProvider) currentToken() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.token
}

func (p *GitHubProvider) SetToken(token string) {
	p.mu.Lock()
	p.token = strings.TrimSpace(token)
	p.mu.Unlock()
}

func (p *GitHubProvider) BeginDeviceAuthorization(ctx context.Context, clientID string) (DeviceAuthorization, error) {
	form := url.Values{"client_id": {clientID}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.oauthBase+"/login/device/code", bytes.NewBufferString(form.Encode()))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "Tilecast-Server/0.9 (+https://github.com/gbyo/tilecast)")
	response, err := p.client.Do(req)
	if err != nil {
		return DeviceAuthorization{}, fmt.Errorf("GitHub authorization request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return DeviceAuthorization{}, fmt.Errorf("GitHub authorization returned HTTP %d", response.StatusCode)
	}
	var body struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&body); err != nil {
		return DeviceAuthorization{}, errors.New("GitHub returned an invalid authorization response")
	}
	verification, err := url.Parse(body.VerificationURI)
	if err != nil || verification.Scheme != "https" || verification.Hostname() != "github.com" || verification.Path != "/login/device" || body.DeviceCode == "" || len(body.DeviceCode) > 1024 || body.UserCode == "" || len(body.UserCode) > 64 || len(body.VerificationURI) > 2048 || body.ExpiresIn <= 0 || body.ExpiresIn > 3600 {
		return DeviceAuthorization{}, errors.New("GitHub returned an invalid authorization response")
	}
	interval := time.Duration(body.Interval) * time.Second
	if interval < 5*time.Second {
		interval = 5 * time.Second
	}
	return DeviceAuthorization{DeviceCode: body.DeviceCode, UserCode: body.UserCode, VerificationURI: body.VerificationURI, ExpiresIn: time.Duration(body.ExpiresIn) * time.Second, Interval: interval}, nil
}

func (p *GitHubProvider) PollDeviceAuthorization(ctx context.Context, clientID, deviceCode string) (DeviceTokenResult, error) {
	form := url.Values{"client_id": {clientID}, "device_code": {deviceCode}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.oauthBase+"/login/oauth/access_token", bytes.NewBufferString(form.Encode()))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "Tilecast-Server/0.9 (+https://github.com/gbyo/tilecast)")
	response, err := p.client.Do(req)
	if err != nil {
		return DeviceTokenResult{}, fmt.Errorf("GitHub authorization poll failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return DeviceTokenResult{}, fmt.Errorf("GitHub authorization poll returned HTTP %d", response.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&body); err != nil {
		return DeviceTokenResult{}, errors.New("GitHub returned an invalid authorization response")
	}
	if body.AccessToken != "" {
		if !validGitHubAccessToken(body.AccessToken) {
			return DeviceTokenResult{}, errors.New("GitHub returned an invalid access token")
		}
		return DeviceTokenResult{AccessToken: body.AccessToken, Status: "connected"}, nil
	}
	switch body.Error {
	case "authorization_pending":
		return DeviceTokenResult{Status: "pending"}, nil
	case "slow_down":
		return DeviceTokenResult{Status: "pending", SlowDown: true}, nil
	case "expired_token":
		return DeviceTokenResult{Status: "expired"}, nil
	case "access_denied":
		return DeviceTokenResult{Status: "denied"}, nil
	default:
		return DeviceTokenResult{}, errors.New("GitHub authorization could not be completed")
	}
}

func validGitHubAccessToken(token string) bool {
	if len(token) < 8 || len(token) > 1024 {
		return false
	}
	for _, character := range token {
		if character <= 0x20 || character >= 0x7f {
			return false
		}
	}
	return true
}

func (p *GitHubProvider) Viewer(ctx context.Context, token string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.apiBase+"/user", nil)
	p.headers(req)
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("GitHub account request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("GitHub did not accept the authorized account")
	}
	var body struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&body); err != nil || strings.TrimSpace(body.Login) == "" || len(body.Login) > 100 {
		return "", errors.New("GitHub returned an invalid account response")
	}
	return strings.TrimSpace(body.Login), nil
}
