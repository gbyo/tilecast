package cli

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// screenRecord is the display subset the CLI reads off a generic screen
// payload. Unknown members stay empty rather than failing: the server
// owns the shape, the CLI only renders it.
type screenRecord map[string]any

func screenID(record screenRecord) string {
	value, _ := record["id"].(string)
	return value
}

func screenName(record screenRecord) string {
	value, _ := record["name"].(string)
	return value
}

func screenStatus(record screenRecord) string {
	value, _ := record["status"].(string)
	return value
}

func newScreenCommand(env *environment) *cobra.Command {
	screen := &cobra.Command{Use: "screen", Short: "List and inspect screens"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List screens visible to the current credential",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScreenList(cmd, env)
		},
	}
	addOutputFlags(list)
	get := &cobra.Command{
		Use:   "get <id-or-name>",
		Short: "Show one screen by ID or unique name",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScreenGet(cmd, env, args[0])
		},
	}
	addOutputFlags(get)
	screen.AddCommand(list, get)
	addScreenManageCommands(env, screen)
	return screen
}

// fetchScreens lists screens through the typed client.
func fetchScreens(ctx context.Context, transport *apiclient.Client) ([]screenRecord, error) {
	status, body, err := transport.ListScreens(ctx)
	if err != nil {
		return nil, err
	}
	var screens []screenRecord
	if err := apiclient.DecodeData(status, body, "screens", &screens); err != nil {
		return nil, err
	}
	return screens, nil
}

func runScreenList(cmd *cobra.Command, env *environment) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	screens, err := fetchScreens(ctx, transport)
	if err != nil {
		return err
	}
	sort.Slice(screens, func(i, j int) bool { return screenName(screens[i]) < screenName(screens[j]) })
	return printData(cmd, screens, func() string {
		plain, _ := cmd.Flags().GetBool("plain")
		var out strings.Builder
		if plain {
			for i, screen := range screens {
				if i > 0 {
					out.WriteByte('\n')
				}
				out.WriteString(screenID(screen) + " " + screenName(screen) + " " + screenStatus(screen))
			}
			return out.String()
		}
		writer := tabwriter.NewWriter(&out, 0, 4, 2, ' ', 0)
		for _, screen := range screens {
			_, _ = writer.Write([]byte(screenID(screen) + "\t" + screenName(screen) + "\t" + screenStatus(screen) + "\n"))
		}
		_ = writer.Flush()
		return strings.TrimSuffix(out.String(), "\n")
	})
}

// resolveScreen accepts a UUID outright and otherwise matches a unique
// human name from the visible list. Ambiguous names are errors, never
// guesses; a screen outside the caller's scope reads as unknown.
func resolveScreen(ctx context.Context, transport *apiclient.Client, ref string) (screenRecord, error) {
	if id, err := uuid.Parse(ref); err == nil {
		status, body, err := transport.GetScreen(ctx, id.String())
		if err != nil {
			return nil, err
		}
		var record screenRecord
		if err := apiclient.DecodeBody(status, body, &record); err != nil {
			return nil, notFoundAsUnknown(err, ref)
		}
		return record, nil
	}
	screens, err := fetchScreens(ctx, transport)
	if err != nil {
		return nil, err
	}
	var matched []screenRecord
	for _, screen := range screens {
		if screenName(screen) == ref {
			matched = append(matched, screen)
		}
	}
	switch len(matched) {
	case 0:
		return nil, fmt.Errorf("no screen named %q (or it is outside your scope); pass an ID", ref)
	case 1:
		// The list carries display fields only. Management commands
		// prefill from the full record, so resolve through get: a name
		// that lists but does not read is reported, never half-filled.
		status, body, err := transport.GetScreen(ctx, screenID(matched[0]))
		if err != nil {
			return nil, err
		}
		var record screenRecord
		if err := apiclient.DecodeBody(status, body, &record); err != nil {
			return nil, notFoundAsUnknown(err, ref)
		}
		return record, nil
	default:
		ids := make([]string, 0, len(matched))
		for _, screen := range matched {
			ids = append(ids, screenID(screen))
		}
		return nil, fmt.Errorf("name %q is ambiguous (%s); pass an ID", ref, strings.Join(ids, ", "))
	}
}

// notFoundAsUnknown rewrites a 404 as the scope-honest unknown message.
func notFoundAsUnknown(err error, ref string) error {
	if apiErr, ok := err.(*apiclient.APIError); ok && apiErr.Status == 404 {
		return fmt.Errorf("no screen %q (unknown or outside your scope)", ref)
	}
	return err
}

func runScreenGet(cmd *cobra.Command, env *environment, ref string) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	record, err := resolveScreen(ctx, transport, ref)
	if err != nil {
		return err
	}
	return printData(cmd, record, func() string {
		return fmt.Sprintf("ID:\t%s\nName:\t%s\nStatus:\t%s", screenID(record), screenName(record), screenStatus(record))
	})
}
