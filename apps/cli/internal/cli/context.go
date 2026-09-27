package cli

import (
	"sort"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

func newContextCommand(env *environment) *cobra.Command {
	context := &cobra.Command{Use: "context", Short: "List and switch saved server contexts"}
	context.AddCommand(
		&cobra.Command{
			Use:   "list",
			Short: "List saved contexts",
			RunE: func(cmd *cobra.Command, args []string) error {
				contexts, err := env.config.List()
				if err != nil {
					return err
				}
				current, _ := env.config.CurrentName()
				names := append([]config.Context{}, contexts...)
				sort.Slice(names, func(i, j int) bool { return names[i].Name < names[j].Name })
				writer := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
				for _, item := range names {
					marker := " "
					if item.Name == current {
						marker = "*"
					}
					_, _ = writer.Write([]byte(marker + "\t" + item.Name + "\t" + item.ServerURL + "\n"))
				}
				return writer.Flush()
			},
		},
		&cobra.Command{
			Use:   "current",
			Short: "Print the current context name",
			RunE: func(cmd *cobra.Command, args []string) error {
				current, err := env.config.Current()
				if err != nil {
					return err
				}
				cmd.Println(current.Name)
				return nil
			},
		},
		&cobra.Command{
			Use:   "use <name>",
			Short: "Switch the current context",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				if err := env.config.Use(args[0]); err != nil {
					return err
				}
				cmd.Printf("Current context is now %q.\n", args[0])
				return nil
			},
		},
		&cobra.Command{
			Use:   "rename <old> <new>",
			Short: "Rename a context, carrying its stored credential",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				oldName, newName := args[0], args[1]
				raw, err := env.secrets.Get(credentialAccount(oldName))
				migrate := err == nil
				if migrate {
					if err := env.secrets.Set(credentialAccount(newName), raw); err != nil {
						return err
					}
				}
				if err := env.config.Rename(oldName, newName); err != nil {
					if migrate {
						_ = env.secrets.Delete(credentialAccount(newName))
					}
					return err
				}
				if migrate {
					_ = env.secrets.Delete(credentialAccount(oldName))
				}
				cmd.Printf("Renamed context %q to %q.\n", oldName, newName)
				return nil
			},
		},
		&cobra.Command{
			Use:   "remove <name>",
			Short: "Remove a context and forget its stored credential",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				if err := env.config.Remove(args[0]); err != nil {
					return err
				}
				// The credential is bound to the context name; leaving it
				// behind would strand a secret nobody can reach.
				_ = env.secrets.Delete(credentialAccount(args[0]))
				cmd.Printf("Removed context %q.\n", args[0])
				return nil
			},
		},
	)
	return context
}
