package cli

import (
	"github.com/spf13/cobra"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
	"github.com/tilecast/tilecast/apps/cli/internal/secret"
)

// environment carries the process-wide CLI dependencies: the context
// config file and the credential store. Commands stay thin; resolution
// lives in credential.go.
type environment struct {
	config  *config.Store
	secrets secret.Store
}

// resolver binds the caller's precedence flags for one command.
func (e *environment) resolver(cmd *cobra.Command) Resolver {
	serverFlag, _ := cmd.Flags().GetString("server")
	tokenFlag, _ := cmd.Flags().GetString("token")
	contextFlag, _ := cmd.Flags().GetString("context")
	// Persistent flags live on the parents; look them up up the tree.
	if serverFlag == "" {
		serverFlag, _ = cmd.InheritedFlags().GetString("server")
	}
	if tokenFlag == "" {
		tokenFlag, _ = cmd.InheritedFlags().GetString("token")
	}
	if contextFlag == "" {
		contextFlag, _ = cmd.InheritedFlags().GetString("context")
	}
	return Resolver{
		ServerFlag:  serverFlag,
		TokenFlag:   tokenFlag,
		ContextFlag: contextFlag,
		Store:       e.config,
		Secrets:     e.secrets,
	}
}

// addGlobalFlags registers the precedence flags everywhere.
func addGlobalFlags(root *cobra.Command) {
	root.PersistentFlags().String("server", "", "Tilecast server URL (overrides TILECAST_URL and the current context)")
	root.PersistentFlags().String("token", "", "Bearer credential (overrides TILECAST_TOKEN and the stored credential)")
	root.PersistentFlags().String("context", "", "Use this saved context (overrides TILECAST_CONTEXT and the current context)")
	root.PersistentFlags().Bool("quiet", false, "Suppress informational output; data and errors only")
	root.PersistentFlags().String("timeout", "", "Bound server calls (Go duration, default 30s)")
}
