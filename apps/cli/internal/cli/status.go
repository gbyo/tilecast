package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newStatusCommand(env *environment) *cobra.Command {
	status := &cobra.Command{
		Use:   "status",
		Short: "Show the server identity and who this CLI signs in as",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Prefer the credential when one resolves; anonymous servers
			// still answer identity, so absence is not an error here.
			resolved, err := env.resolver(cmd).Resolve(true)
			if err != nil {
				resolved, err = env.resolver(cmd).Resolve(false)
				if err != nil {
					return err
				}
			}
			transport, ctx, cancel, err := env.transport(cmd, resolved)
			if err != nil {
				return err
			}
			defer cancel()
			caps, err := transport.Probe(ctx)
			if err != nil {
				return err
			}
			if err := caps.RequireAPIVersion("v1"); err != nil {
				return err
			}
			payload := map[string]any{
				"server": resolved.ServerURL, "product": caps.Product,
				"apiVersion": caps.APIVersion, "installationId": caps.InstallationID,
				"organization": caps.Organization, "authenticated": caps.Authenticated,
				"username": caps.Username, "role": caps.Role,
			}
			return printData(cmd, payload, func() string {
				who := "not signed in"
				if caps.Authenticated {
					who = fmt.Sprintf("%s (%s)", caps.Username, caps.Role)
				}
				return fmt.Sprintf("Server:\t%s\nInstallation:\t%s\nOrganization:\t%s\nAPI:\t%s\nSigned in as:\t%s",
					resolved.ServerURL, caps.InstallationID, caps.Organization, caps.APIVersion, who)
			})
		},
	}
	addOutputFlags(status)
	return status
}
