package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/managedpresentations"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/apps/server/internal/takeovers"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

const (
	// MaxOperationBytes bounds an operation token off the wire.
	MaxOperationBytes = 128
	// MaxInputBytes bounds one service call's JSON input.
	MaxInputBytes = 32 * 1024
	// MaxOutputBytes bounds one service call's JSON envelope.
	MaxOutputBytes = 64 * 1024
)

// Domain error codes for the call envelope. Transport denials (unknown
// operation, missing grant, wrong context) never reach the envelope:
// they are stable host errors. Everything here is a typed operation
// outcome the guest can handle.
const (
	ErrCodeInvalidInput = "invalid_input"
	ErrCodeNotFound     = "not_found"
	ErrCodeForbidden    = "forbidden"
	ErrCodeConflict     = "conflict"
	ErrCodeTooLarge     = "too_large"
	ErrCodeUnavailable  = "unavailable"
)

// Actor is the authenticated Studio operator behind a studio-context
// call. Background calls carry no actor: they run as the system and
// never impersonate a Studio user.
type Actor struct {
	UserID uuid.UUID
	Role   string
}

// Call is one authorized-or-not service invocation from a guest.
type Call struct {
	PackageID string
	Context   string
	Actor     *Actor
	Grants    []packagemanifest.ServiceGrant
	Operation string
	Input     []byte
}

// Denial is a transport-level refusal: unknown operation, missing
// grant, or wrong context. The Wasm host maps it to a stable negative
// code, never to an envelope.
type Denial struct {
	Kind    string
	Message string
}

func (d *Denial) Error() string { return d.Message }

// Denial kinds for host mapping.
const (
	DenialUnknownOperation = "unknown_operation"
	DenialMissingGrant     = "missing_grant"
	DenialForbiddenContext = "forbidden_context"
	DenialInvalidActor     = "invalid_actor"
)

// CallError is a typed domain failure the guest receives in the
// envelope's error shape.
type CallError struct {
	Code    string
	Message string
}

func (e *CallError) Error() string { return e.Code + ": " + e.Message }

func invalidInput(format string, args ...any) *CallError {
	return &CallError{Code: ErrCodeInvalidInput, Message: fmt.Sprintf(format, args...)}
}

func notFound(message string) *CallError {
	return &CallError{Code: ErrCodeNotFound, Message: message}
}

func forbidden(message string) *CallError {
	return &CallError{Code: ErrCodeForbidden, Message: message}
}

func conflict(message string) *CallError {
	return &CallError{Code: ErrCodeConflict, Message: message}
}

func unavailable(err error) *CallError {
	return &CallError{Code: ErrCodeUnavailable, Message: "The service is temporarily unavailable: " + err.Error()}
}

// Envelope is the wire shape every executed call answers: ok with data,
// or ok=false with a typed error.
type Envelope struct {
	OK    bool           `json:"ok"`
	Data  any            `json:"data,omitempty"`
	Error *EnvelopeError `json:"error,omitempty"`
}

// EnvelopeError is the typed domain failure inside an envelope.
type EnvelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// MarshalSuccess renders the success envelope.
func MarshalSuccess(data any) ([]byte, error) {
	return json.Marshal(Envelope{OK: true, Data: data})
}

// MarshalFailure renders the domain-failure envelope.
func MarshalFailure(failure *CallError) ([]byte, error) {
	return json.Marshal(Envelope{OK: false, Error: &EnvelopeError{Code: failure.Code, Message: failure.Message}})
}

// Limits carries the installation's operation bounds the dispatcher
// shares with the dashboard handlers.
type Limits struct {
	// MaxTakeoverTargets caps screens plus groups on one takeover.
	MaxTakeoverTargets int
	// MaxPendingCommands caps the pending queue per screen for
	// package-queued player commands, matching the dashboard default.
	MaxPendingCommands int
	// DefaultCommandExpiryMinutes expires package-queued player
	// commands, matching the dashboard default.
	DefaultCommandExpiryMinutes int
}

// Dependencies are the domain services the dispatcher reuses. No
// operation runs its own SQL against domain tables except the
// package-ownership rows the dispatcher itself owns.
type Dependencies struct {
	DB         *pgxpool.Pool
	Devices    *devices.Service
	Playlists  *playlists.Service
	Layouts    *layouts.Service
	Media      *media.Service
	Scheduling *scheduling.Service
	Takeovers  *takeovers.Service
	Managed    *managedpresentations.Service
	Settings   *settings.Service
	Shared     plugins.SharedHost
	Limits     Limits
	Now        func() time.Time
}

// Dispatcher routes authorized service calls to domain services.
type Dispatcher struct {
	deps Dependencies
}

// NewDispatcher builds the call router. A nil Now uses the system clock.
func NewDispatcher(deps Dependencies) *Dispatcher {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Limits.MaxTakeoverTargets <= 0 {
		deps.Limits.MaxTakeoverTargets = 250
	}
	if deps.Limits.MaxPendingCommands <= 0 {
		deps.Limits.MaxPendingCommands = 50
	}
	if deps.Limits.DefaultCommandExpiryMinutes <= 0 {
		deps.Limits.DefaultCommandExpiryMinutes = 10
	}
	return &Dispatcher{deps: deps}
}

func (d *Dispatcher) now() time.Time {
	return d.deps.Now().UTC()
}

// Call authorizes one invocation and runs it. A Denial means the
// transport must answer a stable host error; a CallError means the
// transport must answer a failure envelope; data means success.
func (d *Dispatcher) Call(ctx context.Context, call Call) (any, *Denial, *CallError) {
	operation, _, ok := LookupOperation(call.Operation)
	if !ok {
		return nil, &Denial{Kind: DenialUnknownOperation, Message: "unknown service operation"}, nil
	}
	if !Granted(call.Grants, operation) {
		return nil, &Denial{Kind: DenialMissingGrant, Message: "the active manifest does not grant " + operation.CapabilityID}, nil
	}
	if !AllowsContext(operation, call.Context) {
		return nil, &Denial{Kind: DenialForbiddenContext, Message: "operation not allowed in this context"}, nil
	}
	switch call.Context {
	case ContextStudio:
		if call.Actor == nil || call.Actor.UserID == uuid.Nil || call.Actor.Role == "" {
			return nil, &Denial{Kind: DenialInvalidActor, Message: "studio calls require an authenticated actor"}, nil
		}
	case ContextBackground:
		if call.Actor != nil {
			return nil, &Denial{Kind: DenialInvalidActor, Message: "background calls never carry an actor"}, nil
		}
	default:
		return nil, &Denial{Kind: DenialForbiddenContext, Message: "unknown invocation context"}, nil
	}
	if len(call.Input) > MaxInputBytes {
		return nil, nil, &CallError{Code: ErrCodeTooLarge, Message: "input exceeds 32 KiB"}
	}
	switch operation.Name {
	case "organization.read@1/get":
		return d.organizationGet(ctx, call)
	case "instance.read@1/get":
		return d.instanceGet(ctx, call)
	case "screens.read@1/list":
		return d.screensList(ctx, call)
	case "screens.read@1/get":
		return d.screensGet(ctx, call)
	case "targets.resolve@1/resolve":
		return d.targetsResolve(ctx, call)
	case "content.read@1/playlists.list":
		return d.playlistsList(ctx, call)
	case "content.read@1/playlists.get":
		return d.playlistsGet(ctx, call)
	case "content.read@1/layouts.list":
		return d.layoutsList(ctx, call)
	case "content.read@1/layouts.get":
		return d.layoutsGet(ctx, call)
	case "content.read@1/datasources.list":
		return d.datasourcesList(ctx, call)
	case "content.read@1/datasources.get":
		return d.datasourcesGet(ctx, call)
	case "content.read@1/schedules.list":
		return d.schedulesList(ctx, call)
	case "content.read@1/schedules.get":
		return d.schedulesGet(ctx, call)
	case "content.read@1/groups.list":
		return d.groupsList(ctx, call)
	case "content.read@1/groups.get":
		return d.groupsGet(ctx, call)
	case "managed-presentations.manage@1/ensure":
		return d.managedEnsure(ctx, call)
	case "managed-presentations.manage@1/update-data":
		return d.managedUpdateData(ctx, call)
	case "managed-presentations.manage@1/get":
		return d.managedGet(ctx, call)
	case "takeovers.manage@1/activate":
		return d.takeoverActivate(ctx, call)
	case "takeovers.manage@1/cancel":
		return d.takeoverCancel(ctx, call)
	case "users.read-basic@1/get":
		return d.usersGet(ctx, call)
	case "users.read-basic@1/search":
		return d.usersSearch(ctx, call)
	case "users.read-basic@1/list-by-role":
		return d.usersListByRole(ctx, call)
	case "audit.write@1/write":
		return d.auditWrite(ctx, call)
	default:
		return nil, &Denial{Kind: DenialUnknownOperation, Message: "operation has no handler"}, nil
	}
}

// decode strictly parses operation input: known fields only, bounded by
// the transport's input cap before this runs. Empty input decodes as an
// empty object, so reads take no arguments.
func decode(input []byte, out any) *CallError {
	if len(bytes.TrimSpace(input)) == 0 {
		input = []byte("{}")
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return invalidInput("input is not valid for this operation: %v", err)
	}
	if decoder.More() {
		return invalidInput("input carries trailing data")
	}
	return nil
}

// studioRole enforces the dashboard role policy for studio-context
// mutations. Background calls are authorized by the install-time grant
// itself, so they never reach here.
func studioRole(call Call, roles ...string) *CallError {
	if call.Context != ContextStudio || call.Actor == nil {
		return nil
	}
	for _, role := range roles {
		if call.Actor.Role == role {
			return nil
		}
	}
	return forbidden("this operation requires a different Studio role")
}

var errOutOfScope = errors.New("outside the account's screen scope")
