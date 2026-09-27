// Package cli builds the tilecast command tree.
//
// The remote CLI talks to a Tilecast Server over its supported HTTP API.
// It never links server internals, PostgreSQL code, or plugin
// implementation packages; the boundary test in this package enforces
// that with the compiled dependency graph, not with grep.
package cli

import (
	"github.com/spf13/cobra"
)

// Version metadata. Release builds set these with -ldflags; development
// builds report "dev".
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// NewRootCommand builds the tilecast command tree.
//
// Foundation slice: version, help, and shell completion only. Management
// commands arrive stacked on this foundation.
func NewRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:   "tilecast",
		Short: "Manage a Tilecast installation from the terminal",
		Long: `tilecast manages a Tilecast Server over its supported HTTP API.

Local server administration (serve, backup, restore, emergency MFA reset)
is intentionally out of scope here. Use the tilecast-server utility on the
server host for that.`,
		SilenceUsage: true,
	}
	root.AddCommand(newVersionCommand())
	root.AddCommand(newCompletionCommand())
	return root
}

// Main is the process entry point: it builds the command tree and runs it
// against the process arguments.
func Main(args []string) error {
	root := NewRootCommand()
	root.SetArgs(args)
	return root.Execute()
}
