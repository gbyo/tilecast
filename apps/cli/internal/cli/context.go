package cli

import (
	"errors"
	"fmt"
	"sort"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"github.com/zalando/go-keyring"

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
				return runContextRename(env, cmd, args[0], args[1])
			},
		},
		&cobra.Command{
			Use:   "remove <name>",
			Short: "Remove a context and forget its stored credential",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return runContextRemove(env, cmd, args[0])
			},
		},
	)
	return context
}

// runContextRename carries the stored credential across the rename. A
// missing credential is fine; an erroring keyring is not treated as "no
// credential exists". The new entry is written before the config moves,
// and the old entry is deleted after, so a failure never strands a
// secret under the wrong name without reporting it.
func runContextRename(env *environment, cmd *cobra.Command, oldName, newName string) error {
	raw, err := env.secrets.Get(credentialAccount(oldName))
	switch {
	case err == nil:
		// Credential exists; migrate it below.
	case errors.Is(err, keyring.ErrNotFound):
		// No credential to carry; rename the config alone.
		if err := env.config.Rename(oldName, newName); err != nil {
			return err
		}
		cmd.Printf("Renamed context %q to %q.\n", oldName, newName)
		return nil
	default:
		return unavailableStoreError(err)
	}
	if err := env.secrets.Set(credentialAccount(newName), raw); err != nil {
		return err
	}
	if err := env.config.Rename(oldName, newName); err != nil {
		_ = env.secrets.Delete(credentialAccount(newName))
		return err
	}
	if err := env.secrets.Delete(credentialAccount(oldName)); err != nil {
		return fmt.Errorf("renamed context %q to %q, but the old credential could not be deleted: %v", oldName, newName, err)
	}
	cmd.Printf("Renamed context %q to %q.\n", oldName, newName)
	return nil
}

// runContextRemove forgets the stored credential and then the config
// reference. Credential deletion failures are never silent, and the
// config reference is kept when the secret could not be removed, so a
// failure does not orphan a secret nobody can reach.
func runContextRemove(env *environment, cmd *cobra.Command, name string) error {
	if _, err := env.config.Get(name); err != nil {
		return err
	}
	_, getErr := env.secrets.Get(credentialAccount(name))
	if getErr != nil && !errors.Is(getErr, keyring.ErrNotFound) {
		return unavailableStoreError(getErr)
	}
	if getErr == nil {
		if err := env.secrets.Delete(credentialAccount(name)); err != nil {
			return fmt.Errorf("could not delete the stored credential for context %q: %v", name, err)
		}
	}
	if err := env.config.Remove(name); err != nil {
		return err
	}
	cmd.Printf("Removed context %q.\n", name)
	return nil
}
