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

// Call performs one authenticated automation request against an arbitrary
// server path. It carries the Bearer [REDACTED], request ID, and user agent like
// every other call, and buffers the bounded JSON answer. Generic plugin
// commands dispatch through here; handwritten commands use the typed
// methods above.
func (c *Client) Call(ctx context.Context, method, path string, body io.Reader) (int, []byte, error) {
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

// callJSON marshals a document and performs one automation-style call.
// Fleet commands use it where the documented contract is partial: the
// handwritten wrapper carries the body the server requires.
func (c *Client) callJSON(ctx context.Context, method, path string, body map[string]any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	return c.Call(ctx, method, path, reader)
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
	return c.callJSON(ctx, http.MethodPost, "/api/v1/screens/pairing/resolve", map[string]any{"code": code})
}

// ApprovePairing approves a pairing session with its screen details.
func (c *Client) ApprovePairing(ctx context.Context, id string, body map[string]any) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.callJSON(ctx, http.MethodPost, "/api/v1/screens/pairing/"+parsed.String()+"/approve", body)
}

// RejectPairing rejects a pairing session with an optional reason.
func (c *Client) RejectPairing(ctx context.Context, id, reason string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.callJSON(ctx, http.MethodPost, "/api/v1/screens/pairing/"+parsed.String()+"/reject", map[string]any{"reason": reason})
}

// UpdateScreen replaces a screen's details document.
func (c *Client) UpdateScreen(ctx context.Context, id string, body map[string]any) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.callJSON(ctx, http.MethodPatch, "/api/v1/screens/"+parsed.String(), body)
}

// SetScreenEnabled disables or enables a screen.
func (c *Client) SetScreenEnabled(ctx context.Context, id string, enabled bool) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	action := "disable"
	if enabled {
		action = "enable"
	}
	return c.Call(ctx, http.MethodPost, "/api/v1/screens/"+parsed.String()+"/"+action, nil)
}

// RevokeScreen permanently revokes a screen's device credential.
func (c *Client) RevokeScreen(ctx context.Context, id, reason string) (int, []byte, error) {
	parsed, err := parseID(id)
	if err != nil {
		return 0, nil, err
	}
	return c.callJSON(ctx, http.MethodPost, "/api/v1/screens/"+parsed.String()+"/revoke", map[string]any{"reason": reason})
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
