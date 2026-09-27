package cli

import (
	"context"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// transport builds the typed API client for one resolved credential. The
// bearer closure captures the resolved secret; rotation stays in the
// resolver, so commands never touch credentials directly.
func (e *environment) transport(cmd *cobra.Command, resolved Resolved) (*apiclient.Client, context.Context, context.CancelFunc, error) {
	ctx, cancel, err := timeoutContext(cmd)
	if err != nil {
		return nil, nil, nil, err
	}
	bearer := resolved.Bearer
	transport, err := apiclient.New(resolved.ServerURL, func(context.Context) (string, error) {
		return bearer, nil
	})
	if err != nil {
		cancel()
		return nil, nil, nil, err
	}
	return transport.WithAgent("tilecast-cli"), ctx, cancel, nil
}
