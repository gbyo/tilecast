package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// Access is the authorization the host applies before a plugin handler runs.
// Every level requires an enrolled dashboard session; there is no plugin route
// that a Player credential or an integration token can reach.
type Access int

const (
	// AccessViewer allows any enrolled dashboard session. Use it for reads.
	AccessViewer Access = iota + 1
	// AccessManager allows Owner and Administrator and requires the session
	// CSRF token. Use it for configuration writes.
	AccessManager
	// AccessSession allows any enrolled session, requires the CSRF token on
	// unsafe methods, and leaves the finer authorization to the handler
	// through PrincipalFrom.
	AccessSession
)

// Handler is a plugin HTTP handler. Returning an error lets the host write the
// standard error envelope: sentinel errors map to fixed codes, an *APIError is
// written as given, and anything else is logged and answered with 500.
type Handler func(w http.ResponseWriter, r *http.Request) error

// Router registers plugin routes below /api/v1. Path parameters use
// net/http's {name} syntax and are read with r.PathValue.
type Router interface {
	Handle(method, pattern string, access Access, handler Handler)
}

// Principal is the authenticated dashboard user of a request.
type Principal struct {
	UserID uuid.UUID
	Role   string
}

// CanManage reports whether the principal is an Owner or Administrator.
func (p Principal) CanManage() bool {
	return p.Role == "owner" || p.Role == "administrator"
}

type principalKey struct{}

// WithPrincipal is called by the host; plugins read the value back with
// PrincipalFrom.
func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, principal)
}

// PrincipalFrom returns the request's dashboard user.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalKey{}).(Principal)
	return principal, ok
}

// Sentinel errors a plugin wraps with detail (fmt.Errorf("%w: ...", ...)).
var (
	// ErrNotFound: the plugin resource does not exist (404).
	ErrNotFound = errors.New("plugin instance not found")
	// ErrInvalid: the input breaks a rule; the wrapped message is shown (400).
	ErrInvalid = errors.New("invalid plugin configuration")
	// ErrNotInstalled: the plugin is not installed (409).
	ErrNotInstalled = errors.New("plugin is not installed")
)

// APIError is an explicit HTTP error response.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
}

func (e *APIError) Error() string { return e.Message }

// MaxRequestBytes is the default request-body limit for DecodeJSON.
const MaxRequestBytes = 1 << 20

// DecodeJSON applies the Tilecast request contract: one JSON object, no
// unknown fields, and a bounded body. The returned error is an *APIError
// with code invalid_request.
func DecodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	return DecodeJSONLimit(w, r, target, MaxRequestBytes)
}

func DecodeJSONLimit(w http.ResponseWriter, r *http.Request, target any, maximumBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maximumBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	invalid := func(message string) error {
		return &APIError{Status: http.StatusBadRequest, Code: "invalid_request", Message: message}
	}
	if err := decoder.Decode(target); err != nil {
		var typeError *json.UnmarshalTypeError
		switch {
		case errors.Is(err, io.EOF):
			return invalid("Request body is missing.")
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			field := strings.Trim(err.Error()[len("json: unknown field "):], `"`)
			return invalid("Unsupported request field: " + field + ".")
		case errors.As(err, &typeError):
			return invalid("Request field has an invalid value type: " + typeError.Field + ".")
		default:
			return invalid("Request body contains malformed JSON.")
		}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return invalid("Request body must contain one JSON object.")
	}
	return nil
}

// WriteData writes the standard success envelope {"data": value}.
func WriteData(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": value})
}

// PathUUID reads a UUID path parameter. A malformed value is reported as not
// found, never as a server error.
func PathUUID(r *http.Request, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		return uuid.Nil, &APIError{Status: http.StatusNotFound, Code: "not_found", Message: "The requested resource was not found."}
	}
	return id, nil
}

// Invalidf is shorthand for an ErrInvalid with a message.
func Invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrInvalid}, args...)...)
}
