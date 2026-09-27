package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newVersionCommand() *cobra.Command {
	var short bool
	cmd := &cobra.Command{
		Use:   "version",
		Short: "Print the CLI version",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if short {
				fmt.Fprintln(cmd.OutOrStdout(), Version)
				return nil
			}
			fmt.Fprintf(cmd.OutOrStdout(), "tilecast %s (commit %s, built %s)\n", Version, Commit, Date)
			return nil
		},
	}
	cmd.Flags().BoolVar(&short, "short", false, "Print only the version number")
	return cmd
}
