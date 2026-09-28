package cli

import (
	"fmt"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// This file holds the handwritten administration slice for personal
// access tokens: list and create. Tokens are security-critical. Creation
// confirms, and the plaintext secret prints exactly once: the list and
// grant endpoints never reveal it again, so the CLI shows it
// prominently and warns on stderr.

type patRecord map[string]any

func patName(record patRecord) string {
	value, _ := record["name"].(string)
	return value
}

func newTokenCommand(env *environment) *cobra.Command {
	token := &cobra.Command{Use: "token", Short: "List and mint personal access tokens"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List your personal access tokens (secrets never shown)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTokenList(cmd, env)
		},
	}
	addOutputFlags(list)
	list.Flags().String("search", "", "Filter tokens by name")
	create := &cobra.Command{
		Use:   "create",
		Short: "Mint a personal access token (the secret shows exactly once)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTokenCreate(cmd, env)
		},
	}
	addOutputFlags(create)
	create.Flags().String("name", "", "Token name")
	create.Flags().StringSlice("scope", nil, "Grant scope: read, write, or admin (repeatable)")
	create.Flags().Int("expires-in-days", 30, "Lifetime in days: 7, 30, 90, or 365")
	create.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	token.AddCommand(list, create)
	return token
}

func runTokenList(cmd *cobra.Command, env *environment) error {
	search, _ := cmd.Flags().GetString("search")
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.ListPATs(ctx, search)
	if err != nil {
		return err
	}
	var data struct {
		PATs []patRecord `json:"pats"`
	}
	if err := apiclient.DecodeBody(status, body, &data); err != nil {
		return err
	}
	sort.Slice(data.PATs, func(i, j int) bool { return patName(data.PATs[i]) < patName(data.PATs[j]) })
	return printData(cmd, data.PATs, func() string {
		var out strings.Builder
		writer := tabwriter.NewWriter(&out, 0, 4, 2, ' ', 0)
		for _, item := range data.PATs {
			id, _ := item["id"].(string)
			scopes := patScopes(item)
			expires, _ := item["expiresAt"].(string)
			revoked := "no"
			if value, _ := item["revokedAt"].(string); value != "" {
				revoked = "yes"
			}
			_, _ = writer.Write([]byte(id + "\t" + patName(item) + "\t" + scopes + "\t" + expires + "\t" + revoked + "\n"))
		}
		_ = writer.Flush()
		return "ID\tNAME\tSCOPES\tEXPIRES\tREVOKED\n" + strings.TrimSuffix(out.String(), "\n")
	})
}

func patScopes(record patRecord) string {
	raw, _ := record["scopes"].([]any)
	scopes := make([]string, 0, len(raw))
	for _, scope := range raw {
		if name, ok := scope.(string); ok {
			scopes = append(scopes, name)
		}
	}
	return strings.Join(scopes, ",")
}

func runTokenCreate(cmd *cobra.Command, env *environment) error {
	name, _ := cmd.Flags().GetString("name")
	scopes, _ := cmd.Flags().GetStringSlice("scope")
	expires, _ := cmd.Flags().GetInt("expires-in-days")
	if name == "" {
		return fmt.Errorf("create needs --name")
	}
	if len(scopes) == 0 {
		return fmt.Errorf("create needs at least one --scope (read, write, or admin)")
	}
	if err := confirmChange(cmd, fmt.Sprintf("mint token %q with %s scope?", name, strings.Join(scopes, ","))); err != nil {
		return err
	}
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.CreatePAT(ctx, name, scopes, expires)
	if err != nil {
		return err
	}
	var result struct {
		Token string    `json:"token"`
		PAT   patRecord `json:"pat"`
	}
	if err := apiclient.DecodeBody(status, body, &result); err != nil {
		return err
	}
	if result.Token == "" {
		return fmt.Errorf("the server did not return a token secret")
	}
	if !quietFlag(cmd) {
		fmt.Fprintln(cmd.ErrOrStderr(), "save this secret now: the server never shows it again")
	}
	return printData(cmd, result, func() string {
		return "token=" + result.Token
	})
}
