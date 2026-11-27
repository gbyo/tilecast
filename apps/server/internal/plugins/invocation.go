package plugins

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/google/uuid"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Host invocations bind a Plugin Manifest API 3 plugin's service calls to
// what the host is doing for it. The host issues an invocation when it runs
// a plugin route (studio, for the signed-in operator), a worker or seed
// (background), a projection (system), or an instance validation (studio
// for the operator who saves, or background). The invocation lives in the
// call context under a key only this package can name, and the host keeps
// a set of live invocations. The transport accepts a call only with a live
// invocation issued for the same plugin, so plugin code cannot claim
// another plugin, another user, a stronger context, or an expired request.
//
// Bundled plugins are trusted first-party code: this is a correctness
// boundary that keeps a mistake from acting as the wrong caller, not a
// sandbox against a compromised plugin.

// Invocation contexts, the same names as the service registry's.
const (
	invocationStudio     = "studio"
	invocationBackground = "background"
	invocationSystem     = "system"
)

// BundledActor is the operator behind a studio invocation.
type BundledActor struct {
	UserID       uuid.UUID
	Role         string
	Capabilities []string
}

// BundledCall is one service call from a bundled plugin, with the identity
// and context the host bound.
type BundledCall struct {
	PluginID  string
	Grants    []packagemanifest.ServiceGrant
	Context   string
	Actor     *BundledActor
	Operation string
	Input     []byte
	// Restrictions narrow what the invocation may do beyond its context.
	Restrictions InvocationRestrictions
}

// InvocationRestrictions narrow one host invocation. The dispatcher
// enforces them for every operation, so a later network-reaching operation
// is refused as soon as the registry marks it.
type InvocationRestrictions struct {
	// DenyNetwork refuses every service operation that reaches the
	// network.
	DenyNetwork bool
}

// BundledServiceCaller runs a bundled call through the service registry's
// dispatcher. internal/extensions/services implements it.
type BundledServiceCaller interface {
	CallBundled(ctx context.Context, call BundledCall) (json.RawMessage, error)
}

type invocation struct {
	pluginID     string
	context      string
	actor        *BundledActor
	restrictions InvocationRestrictions
}

type invocationKey struct{}

type invocationSet struct {
	mu   sync.Mutex
	live map[*invocation]struct{}
}

func (set *invocationSet) issue(ctx context.Context, item *invocation) (context.Context, func()) {
	set.mu.Lock()
	if set.live == nil {
		set.live = map[*invocation]struct{}{}
	}
	set.live[item] = struct{}{}
	set.mu.Unlock()
	return context.WithValue(ctx, invocationKey{}, item), func() {
		set.mu.Lock()
		delete(set.live, item)
		set.mu.Unlock()
	}
}

func (set *invocationSet) valid(item *invocation) bool {
	set.mu.Lock()
	defer set.mu.Unlock()
	_, ok := set.live[item]
	return ok
}

// operatorInvocation issues a studio invocation for the request's operator,
// or a background one for work without an operator (demo seeding).
func (s *Service) operatorInvocation(ctx context.Context, pluginID string) (context.Context, func()) {
	if principal, ok := plugin.PrincipalFrom(ctx); ok && principal.UserID != uuid.Nil {
		return s.invocations.issue(ctx, &invocation{pluginID: pluginID, context: invocationStudio,
			actor: &BundledActor{UserID: principal.UserID, Role: principal.Role, Capabilities: append([]string(nil), principal.Capabilities...)}})
	}
	return s.invocations.issue(ctx, &invocation{pluginID: pluginID, context: invocationBackground})
}

func (s *Service) backgroundInvocation(ctx context.Context, pluginID string) (context.Context, func()) {
	return s.invocations.issue(ctx, &invocation{pluginID: pluginID, context: invocationBackground})
}

func (s *Service) systemInvocation(ctx context.Context, pluginID string) (context.Context, func()) {
	return s.invocations.issue(ctx, &invocation{pluginID: pluginID, context: invocationSystem})
}

// restrictedSystemInvocation is a system invocation with restrictions, for
// a hook that must not do everything a system callback may.
func (s *Service) restrictedSystemInvocation(ctx context.Context, pluginID string, restrictions InvocationRestrictions) (context.Context, func()) {
	return s.invocations.issue(ctx, &invocation{pluginID: pluginID, context: invocationSystem, restrictions: restrictions})
}

// SetServiceCaller wires the service registry's dispatcher for bundled
// Plugin Manifest API 3 plugins.
func (s *Service) SetServiceCaller(caller BundledServiceCaller) {
	s.serviceCaller = caller
}

// serviceTransport is one plugin's transport. The plugin identity and its
// declared grants are fixed when the host builds it.
type serviceTransport struct {
	service  *Service
	pluginID string
	grants   []packagemanifest.ServiceGrant
}

func (t serviceTransport) CallService(ctx context.Context, operation string, input []byte) (json.RawMessage, error) {
	item, ok := ctx.Value(invocationKey{}).(*invocation)
	if !ok || !t.service.invocations.valid(item) {
		return nil, &plugin.ServiceDenial{Kind: "invalid_actor", Message: "service calls run only while the host invokes the plugin"}
	}
	if item.pluginID != t.pluginID {
		return nil, &plugin.ServiceDenial{Kind: "invalid_actor", Message: "the invocation belongs to another plugin"}
	}
	if t.service.serviceCaller == nil {
		return nil, &plugin.ServiceError{Code: plugin.ServiceUnavailable, Message: "The service is temporarily unavailable."}
	}
	return t.service.serviceCaller.CallBundled(ctx, BundledCall{
		PluginID: t.pluginID, Grants: t.grants, Context: item.context, Actor: item.actor,
		Operation: operation, Input: input, Restrictions: item.restrictions,
	})
}

func grantsOf(manifest plugin.Manifest) []packagemanifest.ServiceGrant {
	grants := []packagemanifest.ServiceGrant{}
	for _, value := range manifest.Services {
		if reference, ok := plugin.ParseServiceReference(value); ok {
			grants = append(grants, packagemanifest.ServiceGrant{ID: reference.Name, Version: reference.Version})
		}
	}
	return grants
}

// invokeRoute wraps a plugin route handler in a studio invocation.
func (s *Service) invokeRoute(pluginID string, handler plugin.Handler) plugin.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		ctx, done := s.operatorInvocation(r.Context(), pluginID)
		defer done()
		return handler(w, r.WithContext(ctx))
	}
}

// backgroundWorker runs a plugin worker inside a background invocation.
func (s *Service) backgroundWorker(pluginID string, worker plugin.Worker) plugin.Worker {
	run := worker.Run
	worker.Run = func(ctx context.Context) error {
		invocationCtx, done := s.backgroundInvocation(ctx, pluginID)
		defer done()
		return run(invocationCtx)
	}
	return worker
}
