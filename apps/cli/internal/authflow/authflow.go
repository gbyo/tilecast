// Package authflow runs the CLI's authorization-code login against a
// Tilecast server: PKCE S256, random loopback redirect, system browser,
// code exchange, and refresh rotation. It speaks only the supported HTTP
// API; it holds no server internals and no domain logic.
package authflow

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ClientID is the built-in first-party client name the server
// auto-provisions. There is no embedded secret; PKCE is the client
// authentication.
const ClientID = "tilecast-cli"

const (
	// CallbackPath is the loopback path the server redirects to.
	CallbackPath = "/callback"
	// WaitTimeout bounds the whole browser wait.
	WaitTimeout = 5 * time.Minute
	// httpTimeout bounds each API call.
	httpTimeout = 20 * time.Second
)

var (
	ErrAccessDenied  = errors.New("the authorization request was denied in the browser")
	ErrStateMismatch = errors.New("the authorization response state does not match this login attempt")
	ErrNoCode        = errors.New("the authorization response carried no code")
	ErrTokenRejected = errors.New("the server rejected the token request")
)

// Tokens is one issuance. Only these strings cross into the credential
// store; they never reach logs, errors, or the config file.
type Tokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

// Expired reports whether the access token needs rotation, with a
// thirty-second clock-skew margin.
func (t Tokens) Expired() bool {
	return time.Now().Add(30 * time.Second).After(t.ExpiresAt)
}

// Identity is the public installation identity login verifies first.
type Identity struct {
	Product          string `json:"product"`
	InstallationID   string `json:"installationId"`
	OrganizationName string `json:"organizationName"`
	APIVersion       string `json:"apiVersion"`
}

// StatusUser is the signed-in user inside an auth status answer.
type StatusUser struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Role     string `json:"role"`
}

// Status is the auth status answer, for setup detection and whoami.
type Status struct {
	SetupRequired bool       `json:"setupRequired"`
	Authenticated bool       `json:"authenticated"`
	User          StatusUser `json:"user"`
	AuthMethod    string     `json:"authMethod"`
	EnrollMFA     bool       `json:"mfaEnrollmentRequired"`
}

// NewVerifier builds a PKCE code verifier: 32 random bytes, base64url.
func NewVerifier() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate PKCE verifier: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// Challenge derives the S256 code challenge for a verifier.
func Challenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

// NewState builds the request state that binds the callback to this
// login attempt.
func NewState() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate OAuth state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// AuthorizeURL builds the approval URL the browser opens.
func AuthorizeURL(serverURL, redirectURI, scopes, state, challenge string) string {
	query := url.Values{
		"client_id":             {ClientID},
		"redirect_uri":          {redirectURI},
		"scope":                 {scopes},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	return strings.TrimSuffix(serverURL, "/") + "/api/v1/oauth/authorize?" + query.Encode()
}

// Listen opens the loopback listener the server redirects to. The port is
// always ephemeral; the redirect URI is derived from the listener.
func Listen() (net.Listener, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("open loopback listener: %w", err)
	}
	return listener, nil
}

// RedirectURI derives the redirect URI from the loopback listener.
func RedirectURI(listener net.Listener) string {
	return "http://" + listener.Addr().String() + CallbackPath
}

// WaitForCode serves the single callback and returns its code. It refuses
// anything that is not the expected state, reports an explicit denial,
// and stops at the context deadline.
func WaitForCode(ctx context.Context, listener net.Listener, state string) (string, error) {
	type outcome struct {
		code string
		err  error
	}
	results := make(chan outcome, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if denied := query.Get("error"); denied != "" {
			results <- outcome{err: fmt.Errorf("%w: %s", ErrAccessDenied, denied)}
		} else if query.Get("state") != state {
			results <- outcome{err: ErrStateMismatch}
		} else if query.Get("code") == "" {
			results <- outcome{err: ErrNoCode}
		} else {
			results <- outcome{code: query.Get("code")}
		}
		_, _ = io.WriteString(w, "Tilecast authorization complete. You can close this tab and return to the terminal.")
	})}
	go func() {
		_ = server.Serve(listener)
	}()
	defer func() { _ = server.Close() }()
	select {
	case <-ctx.Done():
		return "", fmt.Errorf("wait for browser authorization: %w", ctx.Err())
	case result := <-results:
		return result.code, result.err
	}
}

type envelope struct {
	Data  json.RawMessage `json:"data"`
	Error *apiError       `json:"error"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func get(ctx context.Context, serverURL, path, bearer string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(serverURL, "/")+path, nil)
	if err != nil {
		return err
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("reach Tilecast server: %w", err)
	}
	defer response.Body.Close()
	return decode(response, out)
}

func post(ctx context.Context, serverURL, path string, body any, out any) error {
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(serverURL, "/")+path, strings.NewReader(string(raw)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("reach Tilecast server: %w", err)
	}
	defer response.Body.Close()
	return decode(response, out)
}

func decode(response *http.Response, out any) error {
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		// Some endpoints (revoke) answer success with no body.
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return nil
		}
		return fmt.Errorf("%w: status %d with an empty body", ErrTokenRejected, response.StatusCode)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("read Tilecast response (status %d): %w", response.StatusCode, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || env.Error != nil {
		code := ""
		message := ""
		if env.Error != nil {
			code, message = env.Error.Code, env.Error.Message
		}
		return fmt.Errorf("%w: status %d code %q: %s", ErrTokenRejected, response.StatusCode, code, message)
	}
	if out != nil {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("decode Tilecast response: %w", err)
		}
	}
	return nil
}

// FetchIdentity reads the public installation identity. Login calls this
// first; anything that is not a Tilecast server stops here.
func FetchIdentity(ctx context.Context, serverURL string) (Identity, error) {
	var identity Identity
	if err := get(ctx, serverURL, "/api/v1/system/identity", "", &identity); err != nil {
		return Identity{}, err
	}
	if identity.Product != "tilecast" {
		return Identity{}, fmt.Errorf("not a Tilecast server (product %q)", identity.Product)
	}
	return identity, nil
}

// FetchStatus reads the auth status, anonymously or as a bearer holder.
func FetchStatus(ctx context.Context, serverURL, bearer string) (Status, error) {
	var status Status
	if err := get(ctx, serverURL, "/api/v1/auth/status", bearer, &status); err != nil {
		return Status{}, err
	}
	return status, nil
}

type tokenAnswer struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// Exchange trades the authorization code and verifier for tokens.
func Exchange(ctx context.Context, serverURL, code, redirectURI, verifier string) (Tokens, error) {
	var answer tokenAnswer
	err := post(ctx, serverURL, "/api/v1/oauth/token", map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     ClientID,
		"code":          code,
		"redirect_uri":  redirectURI,
		"code_verifier": verifier,
	}, &answer)
	if err != nil {
		return Tokens{}, err
	}
	if answer.AccessToken == "" || answer.RefreshToken == "" {
		return Tokens{}, fmt.Errorf("%w: incomplete issuance", ErrTokenRejected)
	}
	return Tokens{AccessToken: answer.AccessToken, RefreshToken: answer.RefreshToken, ExpiresAt: answer.ExpiresAt}, nil
}

// Rotate trades a refresh token for a fresh pair. Rotation is single-use
// server-side: reusing a rotated secret revokes the whole grant, so the
// caller must persist the answer before using it.
func Rotate(ctx context.Context, serverURL, refreshToken string) (Tokens, error) {
	var answer tokenAnswer
	err := post(ctx, serverURL, "/api/v1/oauth/token", map[string]string{
		"grant_type":    "refresh_token",
		"client_id":     ClientID,
		"refresh_token": refreshToken,
	}, &answer)
	if err != nil {
		return Tokens{}, err
	}
	if answer.AccessToken == "" || answer.RefreshToken == "" {
		return Tokens{}, fmt.Errorf("%w: incomplete rotation", ErrTokenRejected)
	}
	return Tokens{AccessToken: answer.AccessToken, RefreshToken: answer.RefreshToken, ExpiresAt: answer.ExpiresAt}, nil
}

// Revoke asks the server to retire the grant behind either token. The
// caller still deletes the local credential afterwards: revocation is
// best-effort at logout, local forgetting is not.
func Revoke(ctx context.Context, serverURL, token string) error {
	return post(ctx, serverURL, "/api/v1/oauth/revoke", map[string]string{"token": token}, nil)
}
