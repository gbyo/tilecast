package cli

import (
	"context"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// transport builds the typed API client for one resolved credential. The
// client captures the resolved secret; rotation stays in the resolver, so
// commands never touch credentials directly.
func (e *environment) transport(cmd *cobra.Command, resolved Resolved) (*apiclient.Client, context.Context, context.CancelFunc, error) {
	ctx, cancel, err := timeoutContext(cmd)
	if err != nil {
		return nil, nil, nil, err
	}
	transport, err := e.newTransport(resolved)
	if err != nil {
		cancel()
		return nil, nil, nil, err
	}
	return transport, ctx, cancel, nil
}

// newTransport builds the API client without a command context, for
// callers that bound their own context (generic plugin pre-dispatch).
func (e *environment) newTransport(resolved Resolved) (*apiclient.Client, error) {
	transport, err := apiclient.New(resolved.ServerURL, func(context.Context) (string, error) {
		return resolved.Bearer, nil
	})
	if err != nil {
		return nil, err
	}
	return transport.WithAgent("tilecast-cli"), nil
}
