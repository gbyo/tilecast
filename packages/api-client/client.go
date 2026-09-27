// Package client is the handwritten transport layer over the generated
// OpenAPI client (internal/generated, reproduced with go generate from
// docs/openapi.yaml). The generated code owns request shapes and routing;
// this layer owns everything credential: the server URL, bearer headers,
// per-request IDs, typed API errors, revision conflicts, pagination, bulk
// idempotency keys, streaming bodies, and version/capability detection.
// It carries no domain or business logic: callers interpret payloads.
package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	gen "github.com/tilecast/tilecast/packages/api-client/internal/generated"
)

//go:generate go tool oapi-codegen -generate types,client -package generated -o internal/generated/client.gen.go ../../docs/openapi.yaml

const (
	// UserAgent identifies API automation in server logs.
	UserAgent = "tilecast-api-client"
	// RequestIDHeader carries the per-request ID used for log correlation.
	RequestIDHeader = "X-Request-ID"
	// httpTimeout bounds each call.
	httpTimeout = 30 * time.Second
)

// BearerFunc supplies the bearer credential for a request. Returning an
// empty string sends the request anonymously.
type BearerFunc func(ctx context.Context) (string, error)

// Client is a Tilecast server client with transport concerns handled.
type Client struct {
	inner  *gen.ClientWithResponses
	server string
	bearer BearerFunc
	agent  string
}

// New builds a client for serverURL. The bearer func is consulted on
// every request so rotation stays the caller's business.
func New(serverURL string, bearer BearerFunc) (*Client, error) {
	inner, err := gen.NewClientWithResponses(strings.TrimSuffix(serverURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("build API client: %w", err)
	}
	return &Client{inner: inner, server: strings.TrimSuffix(serverURL, "/"), bearer: bearer, agent: UserAgent}, nil
}

// WithAgent names the calling program in the User-Agent header.
func (c *Client) WithAgent(agent string) *Client {
	clone := *c
	clone.agent = agent
	return &clone
}

// editor attaches the bearer credential, request ID, and user agent.
func (c *Client) editor(ctx context.Context) (gen.RequestEditorFn, error) {
	var bearer string
	if c.bearer != nil {
		token, err := c.bearer(ctx)
		if err != nil {
			return nil, err
		}
		bearer = token
	}
	return func(_ context.Context, req *http.Request) error {
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		req.Header.Set("User-Agent", c.agent)
		if req.Header.Get(RequestIDHeader) == "" {
			id, err := uuid.NewRandom()
			if err != nil {
				return fmt.Errorf("generate request ID: %w", err)
			}
			req.Header.Set(RequestIDHeader, id.String())
		}
		return nil
	}, nil
}

// APIError is a decoded server error envelope with its HTTP status.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("tilecast: status %d code %q: %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("tilecast: status %d: %s", e.Status, e.Message)
}

// ConflictError is a 409 revision conflict. Expected and Current carry
// the decoded conflicting revisions when the server sent them.
type ConflictError struct {
	APIError
	Expected any
	Current  any
}

func (e *ConflictError) Error() string { return e.APIError.Error() }

type envelope struct {
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// DecodeBody decodes one raw response body: data into out on success, a
// typed APIError (or ConflictError on 409) otherwise.
func DecodeBody(status int, body []byte, out any) error {
	if status == http.StatusNoContent || len(bytes.TrimSpace(body)) == 0 {
		if status >= 200 && status < 300 {
			return nil
		}
		return &APIError{Status: status, Message: "empty response"}
	}
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return &APIError{Status: status, Message: fmt.Sprintf("unreadable response: %v", err)}
	}
	if status < 200 || status >= 300 || env.Error != nil {
		code, message := "", ""
		if env.Error != nil {
			code, message = env.Error.Code, env.Error.Message
		}
		apiErr := &APIError{Status: status, Code: code, Message: message}
		if status == http.StatusConflict {
			conflict := &ConflictError{APIError: *apiErr}
			var detail struct {
				ExpectedRevision any `json:"expectedRevision"`
				CurrentRevision  any `json:"currentRevision"`
			}
			if json.Unmarshal(env.Data, &detail) == nil {
				conflict.Expected, conflict.Current = detail.ExpectedRevision, detail.CurrentRevision
			}
			return conflict
		}
		return apiErr
	}
	if out != nil {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return &APIError{Status: status, Message: fmt.Sprintf("unreadable payload: %v", err)}
		}
	}
	return nil
}

// DecodeData decodes the named member of a data envelope, for list
// responses shaped like {"screens": [...]}.
func DecodeData(status int, body []byte, member string, out any) error {
	var data map[string]json.RawMessage
	if err := DecodeBody(status, body, &data); err != nil {
		return err
	}
	raw, ok := data[member]
	if !ok {
		return &APIError{Status: 200, Message: fmt.Sprintf("response has no %q member", member)}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &APIError{Status: 200, Message: fmt.Sprintf("unreadable %q: %v", member, err)}
	}
	return nil
}

// Capabilities is what version detection learns about a server.
type Capabilities struct {
	Product        string
	APIVersion     string
	InstallationID string
	Organization   string
	Authenticated  bool
	Username       string
	Role           string
	EnrollMFA      bool
}

// Probe reads the public identity and, when a bearer is configured, the
// auth status. It fails when the far end is not a Tilecast server.
func (c *Client) Probe(ctx context.Context) (Capabilities, error) {
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	editor, err := c.editor(ctx)
	if err != nil {
		return Capabilities{}, err
	}
	identity, err := c.inner.InstallationIdentityWithResponse(ctx, editor)
	if err != nil {
		return Capabilities{}, fmt.Errorf("reach Tilecast server: %w", err)
	}
	var decoded struct {
		Product          string `json:"product"`
		APIVersion       string `json:"apiVersion"`
		InstallationID   string `json:"installationId"`
		OrganizationName string `json:"organizationName"`
	}
	if err := DecodeBody(identity.StatusCode(), identity.Body, &decoded); err != nil {
		return Capabilities{}, err
	}
	if decoded.Product != "tilecast" {
		return Capabilities{}, fmt.Errorf("not a Tilecast server (product %q)", decoded.Product)
	}
	caps := Capabilities{
		Product: decoded.Product, APIVersion: decoded.APIVersion,
		InstallationID: decoded.InstallationID, Organization: decoded.OrganizationName,
	}
	status, err := c.inner.AuthStatusWithResponse(ctx, editor)
	if err != nil {
		return Capabilities{}, fmt.Errorf("read Tilecast auth status: %w", err)
	}
	// The envelope is transport framing, so it decodes here rather than
	// in the generated payload type.
	var who struct {
		Authenticated bool `json:"authenticated"`
		EnrollMFA     bool `json:"mfaEnrollmentRequired"`
		User          *struct {
			Username string `json:"username"`
			Role     string `json:"role"`
		} `json:"user"`
	}
	if err := DecodeBody(status.StatusCode(), status.Body, &who); err != nil {
		return Capabilities{}, err
	}
	caps.Authenticated = who.Authenticated
	caps.EnrollMFA = who.EnrollMFA
	if who.User != nil {
		caps.Username, caps.Role = who.User.Username, who.User.Role
	}
	return caps, nil
}

// Identity returns the public installation identity through the generated route.
func (c *Client) Identity(ctx context.Context) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.InstallationIdentity(ctx, editor)
		if err != nil {
			return 0, nil, err
		}
		return readRawResponse(response)
	})
}

// AuthStatus returns the current principal, if any, through the generated route.
func (c *Client) AuthStatus(ctx context.Context) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.AuthStatus(ctx, editor)
		if err != nil {
			return 0, nil, err
		}
		return readRawResponse(response)
	})
}

// IssueOAuthTokens exchanges an authorization code or rotates a refresh token.
func (c *Client) IssueOAuthTokens(ctx context.Context, grantType, clientID, code, redirectURI, verifier, refreshToken string) (int, []byte, error) {
	body := gen.IssueOAuthTokensJSONRequestBody{GrantType: gen.OAuthTokenRequestGrantType(grantType), ClientId: &clientID}
	if code != "" {
		body.Code = &code
	}
	if redirectURI != "" {
		body.RedirectUri = &redirectURI
	}
	if verifier != "" {
		body.CodeVerifier = &verifier
	}
	if refreshToken != "" {
		body.RefreshToken = &refreshToken
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.IssueOAuthTokens(ctx, body, editor)
		if err != nil {
			return 0, nil, err
		}
		return readRawResponse(response)
	})
}

// RevokeOAuthCredential revokes the grant behind the supplied credential.
func (c *Client) RevokeOAuthCredential(ctx context.Context, token string) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.RevokeOAuthCredential(ctx, gen.RevokeOAuthCredentialJSONRequestBody{Token: token}, editor)
		if err != nil {
			return 0, nil, err
		}
		return readRawResponse(response)
	})
}

func readRawResponse(response *http.Response) (int, []byte, error) {
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, body, err
}

// RequireAPIVersion fails unless the server speaks the wanted API version.
func (caps Capabilities) RequireAPIVersion(want string) error {
	if caps.APIVersion != want {
		return fmt.Errorf("server speaks API %q, this client needs %q", caps.APIVersion, want)
	}
	return nil
}

// PageParams builds the conventional page/pageSize query for list calls
// that support them.
func PageParams(page, pageSize int) map[string]string {
	return map[string]string{"page": itoa(page), "pageSize": itoa(pageSize)}
}

func itoa(n int) string {
	return fmt.Sprintf("%d", n)
}

// NewIdempotencyKey mints the caller-supplied key bulk operations accept
// for safe retries. It is transport randomness, not domain logic.
func NewIdempotencyKey() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate idempotency key: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

// rawCall runs one generated call and returns its status and body. The
// helpers below keep the generated types inside this module: callers work
// in strings and generic payloads, never in generated shapes.
func (c *Client) rawCall(ctx context.Context, call func(editor gen.RequestEditorFn) (int, []byte, error)) (int, []byte, error) {
	editor, err := c.editor(ctx)
	if err != nil {
		return 0, nil, err
	}
	return call(editor)
}

// ListScreens returns the raw screens list payload.
func (c *Client) ListScreens(ctx context.Context) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ListScreensWithResponse(ctx, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// parseID validates a UUID path parameter into the generated ID type.
func parseID(raw string) (gen.ResourceID, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return gen.ResourceID{}, fmt.Errorf("invalid ID %q: not a UUID", raw)
	}
	var out gen.ResourceID
	copy(out[:], id[:])
	return out, nil
}

// GetScreen returns the raw payload for one screen.
func (c *Client) GetScreen(ctx context.Context, id string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetScreenWithResponse(ctx, parsed, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// GetEffectivePolicy returns the raw effective player policy for a screen.
func (c *Client) GetEffectivePolicy(ctx context.Context, id string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetEffectivePolicyWithResponse(ctx, parsed, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// GetSettings returns the raw organization settings document.
func (c *Client) GetSettings(ctx context.Context) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetSettingsWithResponse(ctx, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// UpdateSettings submits values against the expected revision and returns
// the raw answer. A 409 surfaces as *ConflictError through DecodeBody.
func (c *Client) UpdateSettings(ctx context.Context, revision int64, values map[string]any) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.UpdateSettingsWithResponse(ctx, nil, gen.SettingsUpdate{Revision: revision, Values: values}, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// ListPlugins returns the raw plugin catalog payload.
func (c *Client) ListPlugins(ctx context.Context) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ListPluginsWithResponse(ctx, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// InstallPlugin records a plugin as installed and returns the raw answer.
// The params stay nil: CSRF is cookie-only and bearer clients never send it.
func (c *Client) InstallPlugin(ctx context.Context, id string) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.InstallPluginWithResponse(ctx, gen.PluginID(id), nil, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// RemovePlugin deletes a plugin installation record and returns the raw answer.
func (c *Client) RemovePlugin(ctx context.Context, id string) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.RemovePluginWithResponse(ctx, gen.PluginID(id), nil, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// GetPluginAutomation returns the raw resolved automation document for an
// installed plugin. Generic operator clients dispatch on it without naming
// the plugin in their own source.
func (c *Client) GetPluginAutomation(ctx context.Context, id string) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetPluginAutomationWithResponse(ctx, gen.PluginID(id), editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// Call performs a runtime-discovered plugin automation request. Core
// operations use generated methods; plugin routes are discovered at runtime.
func (c *Client) Call(ctx context.Context, method, path string, body io.Reader) (int, []byte, error) {
	parsed, err := url.ParseRequestURI(path)
	if err != nil || parsed.IsAbs() || !strings.HasPrefix(parsed.Path, "/api/v1/plugins/") || strings.Contains(parsed.Path, "..") || strings.Contains(parsed.Path, "//") || parsed.Fragment != "" {
		return 0, nil, fmt.Errorf("plugin automation path is invalid")
	}
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	editor, err := c.editor(ctx)
	if err != nil {
		return 0, nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, c.server+path, body)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if err := editor(ctx, request); err != nil {
		return 0, nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("reach Tilecast server: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, raw, nil
}

// ListPendingPairings returns the raw pending pairing sessions payload.
func (c *Client) ListPendingPairings(ctx context.Context) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ListPendingPairingsWithResponse(ctx, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// ResolvePairingCode resolves a visible pairing code into its session.
func (c *Client) ResolvePairingCode(ctx context.Context, code string) (int, []byte, error) {
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ResolvePairingCodeWithResponse(ctx, gen.ResolvePairingCodeJSONRequestBody{Code: code}, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// ApprovePairing approves a pairing session with its screen details.
func (c *Client) ApprovePairing(ctx context.Context, id string, body map[string]any) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	var input gen.ApprovePairingJSONRequestBody
	if err := convertBody(body, &input); err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ApprovePairingWithResponse(ctx, parsed, input, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// RejectPairing rejects a pairing session with an optional reason.
func (c *Client) RejectPairing(ctx context.Context, id, reason string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.RejectPairingWithResponse(ctx, parsed, gen.RejectPairingJSONRequestBody{Reason: &reason}, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// UpdateScreen replaces a screen's details document.
func (c *Client) UpdateScreen(ctx context.Context, id string, body map[string]any) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	var input gen.UpdateScreenJSONRequestBody
	if err := convertBody(body, &input); err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.UpdateScreenWithResponse(ctx, parsed, input, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// SetScreenEnabled disables or enables a screen.
func (c *Client) SetScreenEnabled(ctx context.Context, id string, enabled bool) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		if enabled {
			response, err := c.inner.EnableScreenWithResponse(ctx, parsed, editor)
			if err != nil {
				return 0, nil, err
			}
			return response.StatusCode(), response.Body, nil
		}
		response, err := c.inner.DisableScreenWithResponse(ctx, parsed, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// RevokeScreen permanently revokes a screen's device credential.
func (c *Client) RevokeScreen(ctx context.Context, id, reason string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.RevokeScreenCredentialWithResponse(ctx, parsed, gen.RevokeScreenCredentialJSONRequestBody{Reason: &reason}, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

func convertBody(body map[string]any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// ListPlaylists returns the raw playlist list payload for one page.
func (c *Client) ListPlaylists(ctx context.Context, search string, page, pageSize int) (int, []byte, error) {
	params := &gen.ListPlaylistsParams{}
	if search != "" {
		params.Search = &search
	}
	if page > 0 {
		params.Page = &page
	}
	if pageSize > 0 {
		params.PageSize = &pageSize
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ListPlaylistsWithResponse(ctx, params, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// GetPlaylist returns the raw playlist draft payload.
func (c *Client) GetPlaylist(ctx context.Context, id string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetPlaylistWithResponse(ctx, parsed, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// PublishPlaylist publishes the draft the caller read, guarded by its
// revision. A 202 means editorial review took the submission instead.
func (c *Client) PublishPlaylist(ctx context.Context, id string, expectedDraftRevision int) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.PublishPlaylistWithResponse(ctx, parsed, gen.PublishPlaylistJSONRequestBody{ExpectedDraftRevision: expectedDraftRevision}, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// ListSchedules returns the raw schedule list payload.
func (c *Client) ListSchedules(ctx context.Context, search string, page, pageSize int) (int, []byte, error) {
	params := &gen.ListSchedulesParams{}
	if search != "" {
		params.Search = &search
	}
	if page > 0 {
		params.Page = &page
	}
	if pageSize > 0 {
		params.PageSize = &pageSize
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ListSchedulesWithResponse(ctx, params, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// GetSchedule returns the raw schedule payload.
func (c *Client) GetSchedule(ctx context.Context, id string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetScheduleWithResponse(ctx, parsed, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// CreateSchedule creates a schedule from a full input document.
func (c *Client) CreateSchedule(ctx context.Context, document []byte) (int, []byte, error) {
	var input gen.CreateScheduleJSONRequestBody
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return 0, nil, fmt.Errorf("decode schedule document: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return 0, nil, fmt.Errorf("schedule document must contain one JSON object")
	}
	if strings.TrimSpace(input.Name) == "" {
		return 0, nil, fmt.Errorf("schedule name is required")
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.CreateScheduleWithResponse(ctx, input, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// ListPATs returns the raw personal access token list payload. Secrets
// never appear here; creation reveals each secret exactly once.
func (c *Client) ListPATs(ctx context.Context, search string) (int, []byte, error) {
	params := &gen.ListPersonalAccessTokensParams{}
	if search != "" {
		params.Search = &search
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ListPersonalAccessTokensWithResponse(ctx, params, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// CreatePAT mints a named personal access token. The secret is returned
// exactly once; callers must show it immediately and never store it.
// Scopes and lifetimes validate against the generated contract before
// anything travels.
func (c *Client) CreatePAT(ctx context.Context, name string, scopes []string, expiresInDays int) (int, []byte, error) {
	typedScopes := make([]gen.CreatePersonalAccessTokenJSONBodyScopes, 0, len(scopes))
	for _, scope := range scopes {
		typed := gen.CreatePersonalAccessTokenJSONBodyScopes(scope)
		if !typed.Valid() {
			return 0, nil, fmt.Errorf("unknown scope %q: use read, write, or admin", scope)
		}
		typedScopes = append(typedScopes, typed)
	}
	lifetime := gen.CreatePersonalAccessTokenJSONBodyExpiresInDays(expiresInDays)
	switch lifetime {
	case gen.CreatePersonalAccessTokenJSONBodyExpiresInDaysN7,
		gen.CreatePersonalAccessTokenJSONBodyExpiresInDaysN30,
		gen.CreatePersonalAccessTokenJSONBodyExpiresInDaysN90,
		gen.CreatePersonalAccessTokenJSONBodyExpiresInDaysN365:
	default:
		return 0, nil, fmt.Errorf("lifetime must be one of 7, 30, 90, or 365 days")
	}
	body := gen.CreatePersonalAccessTokenJSONRequestBody{
		Name:          name,
		Scopes:        typedScopes,
		ExpiresInDays: gen.CreatePersonalAccessTokenJSONBodyExpiresInDays(expiresInDays),
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.CreatePersonalAccessTokenWithResponse(ctx, nil, body, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

func activityTime(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil, fmt.Errorf("activity timestamp %q: %w", value, err)
	}
	return &parsed, nil
}

// ActivityOverview returns the raw fleet activity overview for a window.
func (c *Client) ActivityOverview(ctx context.Context, from, to string) (int, []byte, error) {
	start, err := activityTime(from)
	if err != nil {
		return 0, nil, err
	}
	end, err := activityTime(to)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetActivityOverviewWithResponse(ctx, &gen.GetActivityOverviewParams{From: start, To: end}, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// ActivityUptime returns the raw uptime report for 24h, 7d, or 30d.
func (c *Client) ActivityUptime(ctx context.Context, window string) (int, []byte, error) {
	params := &gen.GetActivityUptimeParams{}
	if window != "" {
		typed := gen.GetActivityUptimeParamsWindow(window)
		params.Window = &typed
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetActivityUptimeWithResponse(ctx, params, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// ListIncidents returns the raw incidents payload for the given filters.
// Empty filters read as the server defaults (active incidents).
func (c *Client) ListIncidents(ctx context.Context, status, severity, incidentType string) (int, []byte, error) {
	params := &gen.ListIncidentsParams{}
	if status != "" {
		params.Status = &status
	}
	if severity != "" {
		params.Severity = &severity
	}
	if incidentType != "" {
		params.Type = &incidentType
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.ListIncidentsWithResponse(ctx, params, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// GetIncident returns the raw incident detail payload with its timeline.
func (c *Client) GetIncident(ctx context.Context, id string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetIncidentWithResponse(ctx, parsed, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// PlaybackCompliance returns the raw expected-versus-actual playback
// compliance payload for a window.
func (c *Client) PlaybackCompliance(ctx context.Context, from, to string) (int, []byte, error) {
	start, err := activityTime(from)
	if err != nil {
		return 0, nil, err
	}
	end, err := activityTime(to)
	if err != nil {
		return 0, nil, err
	}
	return c.rawCall(ctx, func(editor gen.RequestEditorFn) (int, []byte, error) {
		response, err := c.inner.GetPlaybackComplianceWithResponse(ctx, &gen.GetPlaybackComplianceParams{From: start, To: end}, editor)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode(), response.Body, nil
	})
}

// Download streams an authenticated GET body to the caller, who closes it.
// It exists for artifact and export endpoints whose payloads must never be
// buffered whole into memory by the transport.
func (c *Client) Download(ctx context.Context, path string) (io.ReadCloser, error) {
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	editor, err := c.editor(ctx)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.server+path, nil)
	if err != nil {
		return nil, err
	}
	if err := editor(ctx, request); err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("reach Tilecast server: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
		return nil, DecodeBody(response.StatusCode, raw, nil)
	}
	return response.Body, nil
}

// Upload posts a streaming body with its content type, decoding the data
// envelope answer into out. Multipart assembly stays with the caller.
func (c *Client) Upload(ctx context.Context, path, contentType string, body io.Reader, out any) error {
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	editor, err := c.editor(ctx)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.server+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", contentType)
	if err := editor(ctx, request); err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("reach Tilecast server: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	return DecodeBody(response.StatusCode, raw, out)
}
