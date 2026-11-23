package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Bundled plugins' own settings and secrets. The plugin identity is the
// one the host bound into the call; an input can name an owner of this
// plugin only.

type pluginStorageInput struct {
	Scope   string    `json:"scope"`
	OwnerID uuid.UUID `json:"ownerId"`
	Key     string    `json:"key"`
}

func (d *Dispatcher) pluginSettingsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input pluginStorageInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if d.deps.Plugins == nil || call.PluginID == "" {
		return nil, nil, &CallError{Code: ErrCodeUnavailable, Message: "Plugin settings are unavailable."}
	}
	if input.Key != "" || (input.Scope != plugin.ScopeOrganization && input.Scope != plugin.ScopeScreen) ||
		(input.Scope == plugin.ScopeScreen) != (input.OwnerID != uuid.Nil) {
		return nil, nil, invalidInput("scope must be organization, or screen with ownerId")
	}
	document, err := d.deps.Plugins.ReadPluginSettings(ctx, call.PluginID, input.Scope, input.OwnerID)
	switch {
	case errors.Is(err, plugins.ErrPluginNotFound), errors.Is(err, plugins.ErrNotFound):
		return nil, nil, notFound("the plugin declares no settings in that scope")
	case err != nil:
		return nil, nil, unavailable(err)
	}
	return map[string]any{"values": document.Values, "secrets": document.Secrets, "revision": document.Revision}, nil, nil
}

func (d *Dispatcher) pluginSecretGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input pluginStorageInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if d.deps.Plugins == nil || call.PluginID == "" {
		return nil, nil, &CallError{Code: ErrCodeSecretUnavailable, Message: "The secret is unavailable. Enter it again."}
	}
	if input.Key == "" || (input.Scope == plugin.ScopeOrganization) != (input.OwnerID == uuid.Nil) {
		return nil, nil, invalidInput("a secret read names a scope, an owner for the instance and screen scopes, and a key")
	}
	value, err := d.deps.Plugins.ReadPluginSecret(ctx, call.PluginID, input.Scope, input.OwnerID, input.Key)
	switch {
	case errors.Is(err, pluginsecrets.ErrUnavailable):
		return nil, nil, &CallError{Code: ErrCodeSecretUnavailable, Message: "The secret is unavailable. Enter it again."}
	case errors.Is(err, plugins.ErrNotFound):
		return nil, nil, notFound("the plugin declares no such secret or owner")
	case errors.Is(err, plugin.ErrInvalid):
		return nil, nil, invalidInput("%v", err)
	case err != nil:
		return nil, nil, unavailable(err)
	}
	return map[string]string{"value": value}, nil, nil
}

// CallBundled runs a bundled plugin's call. It is the same dispatcher, the
// same operation, context, validation, authorization, and audit rules as a
// package call; only the caller identity differs.
func (d *Dispatcher) CallBundled(ctx context.Context, call plugins.BundledCall) (json.RawMessage, error) {
	var actor *Actor
	if call.Actor != nil {
		actor = &Actor{UserID: call.Actor.UserID, Role: call.Actor.Role, Capabilities: capabilitySet(call.Actor.Capabilities)}
	}
	data, denial, failure := d.Call(ctx, Call{
		PluginID: call.PluginID, Context: call.Context, Actor: actor,
		Grants: call.Grants, Operation: call.Operation, Input: call.Input,
	})
	if denial != nil {
		return nil, &plugin.ServiceDenial{Kind: denial.Kind, Message: denial.Message}
	}
	if failure != nil {
		return nil, &plugin.ServiceError{Code: failure.Code, Message: failure.Message}
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, &plugin.ServiceError{Code: ErrCodeUnavailable, Message: "The service is temporarily unavailable."}
	}
	if limit := OperationLimits(call.Operation).MaxOutputBytes; len(encoded) > limit {
		return nil, &plugin.ServiceError{Code: ErrCodeTooLarge, Message: fmt.Sprintf("output exceeds %d bytes", limit)}
	}
	return encoded, nil
}

func capabilitySet(values []string) auth.CapabilitySet {
	held := make([]auth.Capability, 0, len(values))
	for _, value := range values {
		held = append(held, auth.Capability(value))
	}
	return auth.NewCapabilitySet(held...)
}
