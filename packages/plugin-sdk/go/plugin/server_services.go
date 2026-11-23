package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// The Server service client of a Plugin Manifest API 3 plugin.
//
// The Server has one service vocabulary: the registry that extension
// packages call through tilecast.call_v1. A bundled API 3 plugin calls the
// same operations through Services, in process, with the same contexts,
// validation, domain services, authorization decisions, and audit. The
// typed methods in services_registry_gen.go are generated from that
// registry, so this client cannot drift from it.
//
// The host binds the plugin identity into the transport, and it decides
// the call context from host state, never from an argument: a call made
// while the host runs a route handler is a studio call for that operator, a
// call from a host-started worker or job is a background call, and a call
// from a projection is a system call. A call outside any host invocation is
// refused.

// ServerService is one registry capability a bundled plugin may declare.
type ServerService struct {
	ID          string
	Version     int
	Name        string
	Description string
	Contexts    []string
	Operations  []ServerOperation
}

// ServerOperation is one fixed operation of a capability. MaxInputBytes
// and MaxOutputBytes are its transport bounds: the encoded input and the
// encoded answer.
type ServerOperation struct {
	Name           string
	Title          string
	Description    string
	Mutating       bool
	Contexts       []string
	MaxInputBytes  int
	MaxOutputBytes int
}

// LookupServerService returns a capability a bundled plugin may declare.
func LookupServerService(id string, version int) (ServerService, bool) {
	for _, service := range ServerServices {
		if service.ID == id && service.Version == version {
			return service, true
		}
	}
	return ServerService{}, false
}

// ServiceTransport carries one call to the host's dispatcher. Only the host
// implements it. It returns the operation's data, a *ServiceError for a
// typed domain failure, or a *ServiceDenial when the call is refused before
// any domain code runs.
type ServiceTransport interface {
	CallService(ctx context.Context, operation string, input []byte) (json.RawMessage, error)
}

// ServiceError is a typed domain failure.
type ServiceError struct {
	Code    string
	Message string
}

func (e *ServiceError) Error() string { return e.Code + ": " + e.Message }

// ServiceDenial is a refusal before any domain code runs: an unknown
// operation, a service the manifest does not declare, a context the
// operation does not allow, or a call outside a host invocation.
type ServiceDenial struct {
	Kind    string
	Message string
}

func (e *ServiceDenial) Error() string { return e.Kind + ": " + e.Message }

// Domain failure codes. They match the package call envelope.
const (
	ServiceInvalidInput      = "invalid_input"
	ServiceNotFound          = "not_found"
	ServiceForbidden         = "forbidden"
	ServiceConflict          = "conflict"
	ServiceTooLarge          = "too_large"
	ServiceUnavailable       = "unavailable"
	ServiceSecretUnavailable = "secret_unavailable"
)

// IsServiceError reports whether err is a domain failure with the code.
func IsServiceError(err error, code string) bool {
	var failure *ServiceError
	return errors.As(err, &failure) && failure.Code == code
}

// Services is a plugin's Server service client.
type Services struct {
	transport ServiceTransport
	declared  map[string]bool
}

// ServiceConsumer receives the plugin's service client. The host calls it
// once, after Init, for a Plugin Manifest API 3 plugin. API 3 features come
// through this client, never through new Host fields.
type ServiceConsumer interface {
	UseServices(services *Services)
}

// NewServices builds the client for a manifest. The host calls it with its
// own transport; plugintest calls it with a test transport.
func NewServices(manifest Manifest, transport ServiceTransport) *Services {
	declared := map[string]bool{}
	for _, value := range manifest.Services {
		if reference, ok := ParseServiceReference(value); ok {
			declared[reference.String()] = true
		}
	}
	return &Services{transport: transport, declared: declared}
}

// Call invokes one operation token, for example "organization.read@1/get".
// The generated methods call it; a plugin normally uses those.
func (s *Services) Call(ctx context.Context, operation string, input, output any) error {
	if s == nil || s.transport == nil {
		return &ServiceDenial{Kind: "unavailable", Message: "the plugin has no service client"}
	}
	capability, _, ok := splitOperation(operation)
	if !ok {
		return &ServiceDenial{Kind: "unknown_operation", Message: "unknown service operation"}
	}
	if !s.declared[capability] {
		return &ServiceDenial{Kind: "missing_grant", Message: "the manifest does not declare " + capability}
	}
	var raw []byte
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("encode %s input: %w", operation, err)
		}
		raw = encoded
	}
	data, err := s.transport.CallService(ctx, operation, raw)
	if err != nil {
		return err
	}
	if output == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, output)
}

func splitOperation(operation string) (capability, method string, ok bool) {
	for index := 0; index < len(operation); index++ {
		if operation[index] == '/' {
			if _, valid := ParseServiceReference(operation[:index]); !valid || index == len(operation)-1 {
				return "", "", false
			}
			return operation[:index], operation[index+1:], true
		}
	}
	return "", "", false
}

// Scopes of plugin settings and secrets.
const (
	ScopeOrganization = "organization"
	ScopeInstance     = "instance"
	ScopeScreen       = "screen"
)

// ReadSecret returns one secret of this plugin through secrets.read@1. The
// owner is uuid.Nil for the organization scope, the instance ID for the
// instance scope, and the screen ID for the screen scope. A secret that was
// never set, or that the installation cannot decrypt after a restore,
// answers a *ServiceError with ServiceSecretUnavailable.
func (s *Services) ReadSecret(ctx context.Context, scope string, ownerID uuid.UUID, key string) (string, error) {
	input := map[string]any{"scope": scope, "key": key}
	if ownerID != uuid.Nil {
		input["ownerId"] = ownerID
	}
	var output struct {
		Value string `json:"value"`
	}
	if err := s.SecretsReadGet(ctx, input, &output); err != nil {
		return "", err
	}
	return output.Value, nil
}

// ReadSettings returns this plugin's non-secret settings for the
// organization (ownerID uuid.Nil) or one screen, through settings.read@1.
func (s *Services) ReadSettings(ctx context.Context, scope string, ownerID uuid.UUID) (map[string]any, error) {
	input := map[string]any{"scope": scope}
	if ownerID != uuid.Nil {
		input["ownerId"] = ownerID
	}
	var output struct {
		Values map[string]any `json:"values"`
	}
	if err := s.SettingsReadGet(ctx, input, &output); err != nil {
		return nil, err
	}
	return output.Values, nil
}
