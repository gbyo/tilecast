package plugins

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// pluginTakeovers is the Takeover service as one plugin sees it. A request
// that names no class gets TakeoverAutomation, and a request above the
// plugin's ceiling is refused, so a routine plugin cannot outrank an
// operator or an emergency message.
type pluginTakeovers struct {
	plugin.Takeovers
	ceiling plugin.TakeoverClass
}

func takeoversFor(service plugin.Takeovers, p plugin.Plugin) plugin.Takeovers {
	if service == nil {
		return nil
	}
	ceiling := plugin.TakeoverAutomation
	if declared, ok := p.(plugin.TakeoverClassCeiling); ok {
		ceiling = declared.MaximumTakeoverClass()
	}
	return pluginTakeovers{Takeovers: service, ceiling: ceiling}
}

func (t pluginTakeovers) ActivateInTx(ctx context.Context, tx pgx.Tx, request plugin.TakeoverRequest) (plugin.TakeoverResult, plugin.AfterCommit, error) {
	if request.Class == "" {
		request.Class = plugin.TakeoverAutomation
	}
	if !request.Class.Valid() {
		return plugin.TakeoverResult{}, nil, fmt.Errorf("%w: unknown takeover class %q", plugin.ErrInvalid, request.Class)
	}
	// CheckDeclarations refuses a life_safety ceiling, but the request is
	// checked here too: no plugin may raise one until Owner enablement exists.
	if request.Class == plugin.TakeoverLifeSafety || request.Class.StrongerThan(t.ceiling) {
		return plugin.TakeoverResult{}, nil, fmt.Errorf("%w: takeover class %q is above this plugin's maximum %q", plugin.ErrInvalid, request.Class, t.ceiling)
	}
	return t.Takeovers.ActivateInTx(ctx, tx, request)
}
