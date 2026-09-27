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
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if short {
				_, err := fmt.Fprintln(cmd.OutOrStdout(), Version)
				return err
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "tilecast %s (commit %s, built %s)\n", Version, Commit, Date)
			return err
		},
	}
	cmd.Flags().BoolVar(&short, "short", false, "Print only the version number")
	return cmd
}
