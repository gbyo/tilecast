package services

import (
	"context"
	"errors"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/execution"
	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
	"github.com/tilecast/tilecast/apps/server/internal/targeting"
)

func pluginStateError(err error) *CallError {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, authz.ErrOutOfScope), errors.Is(err, authz.ErrForbidden), errors.Is(err, authz.ErrNotFound):
		return authzFailure(err, "")
	case errors.Is(err, externalplugins.ErrForbidden):
		return forbidden("configuring external plugins requires the plugins.manage capability")
	case errors.Is(err, externalplugins.ErrNotFound):
		return notFound("this package does not own an executable plugin contribution with that identity")
	case errors.Is(err, externalplugins.ErrInvalid), errors.Is(err, targeting.ErrInvalid):
		return invalidInput("%v", err)
	case errors.Is(err, externalplugins.ErrConflict), errors.Is(err, execution.ErrChanged):
		return conflict("the plugin configuration or package activation changed")
	default:
		return unavailable(err)
	}
}

func (d *Dispatcher) externalPluginState(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if d.deps.ExternalPlugins == nil {
		return nil, nil, unavailable(errors.New("external plugin state is unavailable"))
	}
	invocation := externalplugins.Invocation{PackageID: call.PackageID, Digest: call.PackageDigest, Epoch: call.ExecutionEpoch}
	actor, studio, failure := studioActor(call)
	if failure != nil {
		return nil, nil, failure
	}
	if studio {
		invocation.Actor = &actor.UserID
		invocation.Authority = &actor
	}
	if call.Operation != "plugin-runtime.state@1/get" {
		if failure := requireCapability(call, auth.CapPluginsManage); failure != nil {
			return nil, nil, failure
		}
	}
	var data any
	var err error
	switch call.Operation {
	case "plugin-runtime.state@1/get":
		var input struct {
			ContributionID string `json:"contributionId"`
		}
		if failure := decode(call.Input, &input); failure != nil {
			return nil, nil, failure
		}
		data, err = d.deps.ExternalPlugins.Get(ctx, invocation, input.ContributionID)
	case "plugin-runtime.state@1/configure":
		var input externalplugins.ConfigureInput
		if failure := decode(call.Input, &input); failure != nil {
			return nil, nil, failure
		}
		data, err = d.deps.ExternalPlugins.Configure(ctx, invocation, input)
	case "plugin-runtime.state@1/publish":
		var input externalplugins.PublishInput
		if failure := decode(call.Input, &input); failure != nil {
			return nil, nil, failure
		}
		data, err = d.deps.ExternalPlugins.Publish(ctx, invocation, input)
	case "plugin-runtime.state@1/clear":
		var input struct {
			ContributionID        string `json:"contributionId"`
			ConfigurationRevision int64  `json:"configurationRevision"`
		}
		if failure := decode(call.Input, &input); failure != nil {
			return nil, nil, failure
		}
		data, err = d.deps.ExternalPlugins.Clear(ctx, invocation, input.ContributionID, input.ConfigurationRevision)
	}
	if err != nil {
		return nil, nil, pluginStateError(err)
	}
	return data, nil, nil
}

func (d *Dispatcher) targetsResolveV2(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input targeting.Definition
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := targeting.Validate(ctx, tx, input); err != nil {
		return nil, nil, pluginStateError(err)
	}
	actor, studio, failure := studioActor(call)
	if failure != nil {
		return nil, nil, failure
	}
	if studio {
		if err := authz.New(tx).Tx(tx).Directory(ctx, actor, auth.CapScreenRead, authz.Directory{
			All: input.Mode == "all", ScreenIDs: input.ScreenIDs, GroupIDs: input.GroupIDs, LocationIDs: input.LocationIDs,
		}); err != nil {
			return nil, nil, pluginStateError(err)
		}
	}
	ids, err := targeting.Resolve(ctx, tx, input)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"screenIds": ids}, nil, nil
}

func (d *Dispatcher) targetOptions(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input devices.TargetOptionQuery
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if (input.Kind != "screen" && input.Kind != "group" && input.Kind != "location") || len(input.Search) > 100 || input.Page < 0 || input.Page > 100000 || input.PageSize < 0 {
		return nil, nil, invalidInput("target options require a valid kind and bounded pagination")
	}
	access, failure := d.screenAccess(ctx, call, auth.CapScreenRead)
	if failure != nil {
		return nil, nil, failure
	}
	data, err := d.deps.Devices.PluginTargetOptions(ctx, access, input)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return data, nil, nil
}
