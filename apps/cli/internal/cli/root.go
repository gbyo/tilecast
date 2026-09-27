// Package cli builds the tilecast command tree.
//
// Core commands are handwritten Cobra commands. Their presentation (names,
// grouping, flags, help, tables, prompts, confirmations) is designed here.
// API transport stays in a generated client (Phase 10); this package must
// not grow domain or business logic.
package cli

import (
	"github.com/spf13/cobra"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
	"github.com/tilecast/tilecast/apps/cli/internal/secret"
)

// Version metadata. Release builds set these with -ldflags; development
// builds report "dev".
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// NewRootCommand builds the tilecast command tree with the production
// environment: the user config file and the OS credential store.
func NewRootCommand() *cobra.Command {
	path, _ := config.DefaultPath()
	return NewRootCommandWithEnv(&environment{
		config:  config.NewStore(path),
		secrets: secret.KeyringStore{},
	})
}

// NewRootCommandWithEnv builds the command tree against an explicit
// environment. Tests pass memory stores; production passes the real ones.
func NewRootCommandWithEnv(env *environment) *cobra.Command {
	root := &cobra.Command{
		Use:   "tilecast",
		Short: "Manage a Tilecast installation from the terminal",
		Long: `tilecast manages a Tilecast Server over its supported HTTP API.

Local server administration (serve, backup, restore, emergency MFA reset)
is intentionally out of scope here. Use the tilecast-server utility on the
server host for that.`,
		SilenceUsage: true,
	}
	addGlobalFlags(root)
	root.AddCommand(newVersionCommand())
	root.AddCommand(newCompletionCommand())
	root.AddCommand(newAuthCommand(env))
	root.AddCommand(newContextCommand(env))
	root.AddCommand(newWhoamiCommand(env))
	root.AddCommand(newStatusCommand(env))
	root.AddCommand(newScreenCommand(env))
	root.AddCommand(newSettingsCommand(env))
	root.AddCommand(newPluginCommand(env))
	return root
}

// Main is the process entry point: it builds the production environment
// and dispatches static commands directly or installed plugins'
// automation trees otherwise. See plugin.go.
func Main(args []string) error {
	path, _ := config.DefaultPath()
	env := &environment{
		config:  config.NewStore(path),
		secrets: secret.KeyringStore{},
	}
	return Execute(NewRootCommandWithEnv(env), env, args)
}
