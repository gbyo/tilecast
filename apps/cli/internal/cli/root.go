// Package cli builds the tilecast command tree.
//
// The remote CLI talks to a Tilecast Server over its supported HTTP API.
// It never links server internals, PostgreSQL code, or plugin
// implementation packages; the boundary test in this package enforces
// that with the compiled dependency graph, not with grep.
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

// defaultEnvironment wires the process config file and the OS-native
// credential store.
func defaultEnvironment() (*environment, error) {
	path, err := config.DefaultPath()
	if err != nil {
		return nil, err
	}
	return &environment{config: config.NewStore(path), secrets: secret.KeyringStore{}}, nil
}

// NewRootCommand builds the tilecast command tree with the process
// default environment. It is the production and smoke-test entry point;
// tests that need isolation use NewRootCommandWithEnv instead.
func NewRootCommand() *cobra.Command {
	env, err := defaultEnvironment()
	if err != nil {
		// The config location is unresolvable; keep the tree usable so
		// version, help, and completion still work. Commands that need
		// the config file report the location failure when they run.
		env = &environment{config: config.NewStore(""), secrets: secret.KeyringStore{}}
	}
	return NewRootCommandWithEnv(env)
}

// NewRootCommandWithEnv builds the tilecast command tree against an
// explicit environment.
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
	root.AddCommand(newStatusCommand(env))
	root.AddCommand(newWhoamiCommand(env))
	root.AddCommand(newTokenCommand(env))
	root.AddCommand(newScreenCommand(env))
	root.AddCommand(newPairingCommand(env))
	root.AddCommand(newPlaylistCommand(env))
	root.AddCommand(newScheduleCommand(env))
	root.AddCommand(newSettingsCommand(env))
	root.AddCommand(newActivityCommand(env))
	root.AddCommand(newPluginCommand(env))
	root.AddCommand(newMCPCommand(env))
	return root
}

// Main is the process entry point: it builds the command tree and runs it
// against the process arguments.
func Main(args []string) error {
	env, err := defaultEnvironment()
	if err != nil {
		return err
	}
	root := NewRootCommandWithEnv(env)
	root.SetArgs(args)
	return root.Execute()
}
