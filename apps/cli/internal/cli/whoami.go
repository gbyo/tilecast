package cli

import (
	"github.com/spf13/cobra"

	"github.com/tilecast/tilecast/apps/cli/internal/authflow"
)

func newWhoamiCommand(env *environment) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show who the resolved credential signs in as",
		RunE: func(cmd *cobra.Command, args []string) error {
			resolved, err := env.resolver(cmd).Resolve(true)
			if err != nil {
				return err
			}
			status, err := authflow.FetchStatus(cmd.Context(), resolved.ServerURL, resolved.Bearer)
			if err != nil {
				return err
			}
			if !status.Authenticated {
				return silentError("the server did not accept this credential; run \"tilecast auth login\" again")
			}
			cmd.Printf("%s (%s) on %s\n", status.User.Username, status.User.Role, resolved.ServerURL)
			if status.EnrollMFA {
				cmd.Printf("Warning: this account still owes the organization a second factor.\n")
			}
			return nil
		},
	}
}

// silentError marks an error the command already explained, so Cobra's
// default "Error:" prefix still prints it exactly once. It carries no
// usage text: the flags were fine, the server said no.
type silentError string

func (e silentError) Error() string { return string(e) }
