package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
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
			transport, err := apiclient.New(resolved.ServerURL, resolved.BearerFunc())
			if err != nil {
				return err
			}
			caps, err := transport.WithAgent("tilecast-cli").Probe(cmd.Context())
			if err != nil {
				return err
			}
			if !caps.Authenticated {
				return silentError("the server did not accept this credential; run \"tilecast auth login\" again")
			}
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "%s (%s) on %s\n", caps.Username, caps.Role, resolved.ServerURL); err != nil {
				return err
			}
			if caps.EnrollMFA {
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
