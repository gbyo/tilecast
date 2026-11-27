package plugins

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/outbound"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// http.fetch@1 for bundled Plugin Manifest API 3 plugins. The service
// registry decodes the call; this file resolves the connection record, the
// consents, and the secret headers, and sends the request through the one
// outbound engine.

// WithOutbound replaces the outbound engine. Tests supply one with a fake
// resolver and dialer.
func WithOutbound(engine *outbound.Engine) Option {
	return func(s *Service) { s.outbound = engine }
}

func (s *Service) outboundEngine() *outbound.Engine {
	s.outboundOnce.Do(func() {
		if s.outbound == nil {
			s.outbound = outbound.New(outbound.Options{})
		}
	})
	return s.outbound
}

// Secret header bounds. A format is a short prefix and suffix around one
// secret, such as "Bearer " and "".
const maxSecretAffixBytes = 64

// ConnectionRequest is one http.fetch@1 request after decoding.
type ConnectionRequest struct {
	Connection uuid.UUID
	Method     string
	// URL is absolute, or a path and query that the host joins to the
	// connection's one origin.
	URL     string
	Headers []ConnectionHeader
	Body    []byte
}

// ConnectionHeader is a plain header or a secret reference. Value and
// Secret are never both set.
type ConnectionHeader struct {
	Name   string
	Value  *string
	Secret *SecretHeader
}

// SecretHeader names one of the plugin's own secret fields and the format
// around it. The host reads the value; plugin code never holds it.
type SecretHeader struct {
	Scope   string
	OwnerID uuid.UUID
	Key     string
	Prefix  string
	Suffix  string
}

// ConnectionResponse is a bounded response for plugin code.
type ConnectionResponse struct {
	Status  int
	Headers map[string][]string
	Body    []byte
}

// FetchFailure is a stable failure for plugin code. Code is one of the
// outbound codes, secret_unavailable, or plaintext_secret_refused.
type FetchFailure struct {
	Code    string
	Message string
}

func (f *FetchFailure) Error() string { return f.Code + ": " + f.Message }

// ErrCodeSecretUnavailable answers a secret header whose secret is not set
// or cannot be decrypted.
const ErrCodeSecretUnavailable = "secret_unavailable"

func fetchFailure(code string) *FetchFailure {
	message := (&outbound.Failure{Code: code}).Message()
	if code == ErrCodeSecretUnavailable {
		message = "A secret this request names is not set or cannot be read. Enter it again."
	}
	return &FetchFailure{Code: code, Message: message}
}

// resolvedConnection is a record with its declaration and live state.
type resolvedConnection struct {
	row         connectionRow
	declaration plugin.Connection
	origins     []plugin.Origin
	consents    activeConsents
}

// resolveConnection loads a record of the plugin and decides whether it
// can be used now. A record of another plugin reads as unavailable, the
// same as a missing one.
func (s *Service) resolveConnection(ctx context.Context, pluginID string, id uuid.UUID) (resolvedConnection, *FetchFailure) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return resolvedConnection{}, fetchFailure(outbound.CodeConnectionUnavailable)
	}
	if installed, err := s.IsInstalled(ctx, pluginID); err != nil || !installed {
		return resolvedConnection{}, fetchFailure(outbound.CodeConnectionUnavailable)
	}
	row, err := scanConnection(s.db.QueryRow(ctx, `SELECT `+connectionColumns+` FROM plugin_connections WHERE id=$1 AND plugin_id=$2`, id, pluginID))
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			s.logger.Warn("plugin connection lookup failed", "plugin", pluginID, "error", err)
		}
		return resolvedConnection{}, fetchFailure(outbound.CodeConnectionUnavailable)
	}
	declaration, ok := hosted.manifest.ConnectionByID(row.definition)
	if !ok {
		return resolvedConnection{}, fetchFailure(outbound.CodeConnectionUnavailable)
	}
	origins := row.approvedOrigins(declaration)
	if len(origins) == 0 {
		return resolvedConnection{}, fetchFailure(outbound.CodeConnectionUnavailable)
	}
	return resolvedConnection{row: row, declaration: declaration, origins: origins, consents: row.consents(declaration)}, nil
}

// policy is the engine policy of a resolved connection.
func (c resolvedConnection) policy() outbound.Policy {
	return outbound.Policy{
		Origins:          c.origins,
		PrivateNetwork:   c.declaration.AllowsPrivateNetwork() && c.consents.privateNetwork,
		PlainHTTP:        c.declaration.AllowsPlainHTTP() && c.declaration.Origins.Operator && c.consents.plainHTTP,
		MaxResponseBytes: int64(c.declaration.ResponseLimit()),
		Timeout:          time.Duration(c.declaration.Timeout()) * time.Second,
	}
}

// requestURL joins a path to the one origin, or checks that an absolute URL
// names a scheme and host. The engine decides whether its origin is
// approved.
func (c resolvedConnection) requestURL(raw string) (*url.URL, *FetchFailure) {
	if raw == "" || len(raw) > 8<<10 {
		return nil, fetchFailure(outbound.CodeRequestInvalid)
	}
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		if len(c.origins) != 1 {
			return nil, fetchFailure(outbound.CodeRequestInvalid)
		}
		joined, err := url.Parse(c.origins[0].String() + raw)
		if err != nil {
			return nil, fetchFailure(outbound.CodeRequestInvalid)
		}
		return joined, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return nil, fetchFailure(outbound.CodeRequestInvalid)
	}
	return parsed, nil
}

// FetchThroughConnection sends one http.fetch@1 request.
func (s *Service) FetchThroughConnection(ctx context.Context, pluginID string, request ConnectionRequest) (ConnectionResponse, error) {
	started := time.Now()
	connection, refusal := s.resolveConnection(ctx, pluginID, request.Connection)
	if refusal != nil {
		s.logFetch(pluginID, request.Connection, "", request.Method, 0, started, refusal.Code)
		return ConnectionResponse{}, refusal
	}
	target, refusal := connection.requestURL(request.URL)
	if refusal != nil {
		s.logFetch(pluginID, request.Connection, "", request.Method, 0, started, refusal.Code)
		return ConnectionResponse{}, refusal
	}
	if len(request.Body) > outbound.MaxRequestBodyBytes {
		return ConnectionResponse{}, fetchFailure(outbound.CodeRequestInvalid)
	}
	headers, refusal := s.requestHeaders(ctx, pluginID, connection, target, request.Headers)
	if refusal != nil {
		s.logFetch(pluginID, request.Connection, originText(target), request.Method, 0, started, refusal.Code)
		return ConnectionResponse{}, refusal
	}
	response, err := s.outboundEngine().Do(ctx, connection.policy(), outbound.Request{Method: request.Method, URL: target, Headers: headers, Body: request.Body})
	if err != nil {
		code := outbound.FailureCode(err)
		if code == "" {
			code = outbound.CodeRequestFailed
		}
		s.logFetch(pluginID, request.Connection, originText(target), request.Method, 0, started, code)
		return ConnectionResponse{}, fetchFailure(code)
	}
	s.logFetch(pluginID, request.Connection, response.Origin.String(), request.Method, response.Status, started, "")
	return ConnectionResponse{Status: response.Status, Headers: outbound.SafeResponseHeaders(response.Header), Body: response.Body}, nil
}

// requestHeaders resolves secret references. A secret over plain HTTP needs
// the declaration's allowPlaintextSecret and its own consent; ordinary
// plain HTTP consent is not enough.
func (s *Service) requestHeaders(ctx context.Context, pluginID string, connection resolvedConnection, target *url.URL, input []ConnectionHeader) ([]outbound.RequestHeader, *FetchFailure) {
	out := make([]outbound.RequestHeader, 0, len(input))
	for _, header := range input {
		if header.Value != nil && header.Secret != nil {
			return nil, fetchFailure(outbound.CodeRequestInvalid)
		}
		if header.Secret == nil {
			value := ""
			if header.Value != nil {
				value = *header.Value
			}
			out = append(out, outbound.RequestHeader{Name: header.Name, Value: value})
			continue
		}
		reference := header.Secret
		if len(reference.Prefix) > maxSecretAffixBytes || len(reference.Suffix) > maxSecretAffixBytes ||
			strings.Contains(reference.Prefix, "{secret}") || strings.Contains(reference.Suffix, "{secret}") {
			return nil, fetchFailure(outbound.CodeRequestInvalid)
		}
		if strings.EqualFold(target.Scheme, plugin.SchemeHTTP) &&
			!(connection.declaration.AllowPlaintextSecret && connection.consents.plaintextSecret) {
			return nil, fetchFailure(outbound.CodePlaintextSecretRefused)
		}
		value, err := s.ReadPluginSecret(ctx, pluginID, reference.Scope, reference.OwnerID, reference.Key)
		if err != nil {
			if !errors.Is(err, pluginsecrets.ErrUnavailable) && !errors.Is(err, ErrNotFound) && !errors.Is(err, plugin.ErrInvalid) {
				s.logger.Warn("plugin secret header read failed", "plugin", pluginID, "connection", connection.row.id)
			}
			return nil, fetchFailure(ErrCodeSecretUnavailable)
		}
		out = append(out, outbound.RequestHeader{Name: header.Name, Value: reference.Prefix + value + reference.Suffix, Sensitive: true})
	}
	return out, nil
}

func originText(target *url.URL) string {
	if origin, err := plugin.OriginOf(target); err == nil {
		return origin.String()
	}
	return ""
}

// logFetch writes one diagnostic line: plugin, connection, origin, method,
// status, duration, and the failure code. It never writes the path, the
// query, a header, or a body.
func (s *Service) logFetch(pluginID string, connection uuid.UUID, origin, method string, status int, started time.Time, code string) {
	attrs := []any{"plugin", pluginID, "connection", connection, "method", method, "durationMs", time.Since(started).Milliseconds()}
	if origin != "" {
		attrs = append(attrs, "origin", origin)
	}
	if status != 0 {
		attrs = append(attrs, "status", status)
	}
	if code != "" {
		attrs = append(attrs, "failure", code)
		s.logger.Info("plugin connection request failed", attrs...)
		return
	}
	s.logger.Debug("plugin connection request", attrs...)
}
