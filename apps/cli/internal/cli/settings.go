package cli

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// settingsDocument is the display subset of the typed settings document.
// The server owns inheritance, defaults, and validation; the CLI only
// renders what it returned.
type settingsDocument struct {
	Revision int64          `json:"revision"`
	Values   map[string]any `json:"values"`
}

func newSettingsCommand(env *environment) *cobra.Command {
	settings := &cobra.Command{Use: "settings", Short: "Read and change organization settings"}
	get := &cobra.Command{
		Use:   "get",
		Short: "Show the organization settings document",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSettingsGet(cmd, env)
		},
	}
	addOutputFlags(get)
	get.Flags().String("scope", "organization", "Settings scope (only organization is supported)")
	set := &cobra.Command{
		Use:   "set key=value [...]",
		Short: "Change settings keys against the current revision",
		Long: `Change only the requested keys: the client reads the current
document, keeps its revision, submits the expected revision, surfaces a
conflict cleanly when another writer won, and prints the new document
and revision. Values that parse as JSON keep their type; anything else
stays a string.`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			scope, _ := cmd.Flags().GetString("scope")
			return runSettingsSet(cmd, env, scope, args)
		},
	}
	addOutputFlags(set)
	set.Flags().String("scope", "organization", "Settings scope (only organization is supported)")
	effective := &cobra.Command{
		Use:   "effective <screen-id-or-name>",
		Short: "Show the effective player policy for one screen",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSettingsEffective(cmd, env, args[0])
		},
	}
	addOutputFlags(effective)
	settings.AddCommand(get, set, effective)
	return settings
}

func checkScope(scope string) error {
	if scope != "organization" {
		return fmt.Errorf("unsupported settings scope %q (only organization is supported)", scope)
	}
	return nil
}

func fetchSettingsDocument(cmd *cobra.Command, env *environment, scope string) (Resolved, *apiclient.Client, settingsDocument, error) {
	var empty settingsDocument
	if err := checkScope(scope); err != nil {
		return Resolved{}, nil, empty, err
	}
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return Resolved{}, nil, empty, err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return Resolved{}, nil, empty, err
	}
	defer cancel()
	status, body, err := transport.GetSettings(ctx)
	if err != nil {
		return Resolved{}, nil, empty, err
	}
	var document settingsDocument
	if err := apiclient.DecodeBody(status, body, &document); err != nil {
		return Resolved{}, nil, empty, err
	}
	return resolved, transport, document, nil
}

func runSettingsGet(cmd *cobra.Command, env *environment) error {
	scope, _ := cmd.Flags().GetString("scope")
	_, _, document, err := fetchSettingsDocument(cmd, env, scope)
	if err != nil {
		return err
	}
	return printData(cmd, document, func() string {
		keys := make([]string, 0, len(document.Values))
		for key := range document.Values {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var out strings.Builder
		for _, key := range keys {
			raw, _ := json.Marshal(document.Values[key])
			fmt.Fprintf(&out, "%s=%s\n", key, raw)
		}
		fmt.Fprintf(&out, "revision=%d", document.Revision)
		return out.String()
	})
}

// parseAssignment splits one key=value argument. The value keeps its JSON
// type when it parses, and stays a string otherwise, so 17:00 remains a
// string while true and 5 become a boolean and a number.
func parseAssignment(arg string) (string, any, error) {
	key, value, found := strings.Cut(arg, "=")
	if !found || key == "" {
		return "", nil, fmt.Errorf("expected key=value, got %q", arg)
	}
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return key, value, nil
	}
	return key, parsed, nil
}

func runSettingsSet(cmd *cobra.Command, env *environment, scope string, args []string) error {
	values := map[string]any{}
	for _, arg := range args {
		key, value, err := parseAssignment(arg)
		if err != nil {
			return err
		}
		values[key] = value
	}
	_, transport, document, err := fetchSettingsDocument(cmd, env, scope)
	if err != nil {
		return err
	}
	merged := map[string]any{}
	for key, value := range document.Values {
		merged[key] = value
	}
	for key, value := range values {
		merged[key] = value
	}
	ctx, cancel, err := timeoutContext(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.UpdateSettings(ctx, document.Revision, merged)
	if err != nil {
		return err
	}
	var updated settingsDocument
	if err := apiclient.DecodeBody(status, body, &updated); err != nil {
		if conflict, ok := err.(*apiclient.ConflictError); ok {
			return fmt.Errorf("settings changed under you (revision %d is stale): re-run and try again: %w", document.Revision, conflict)
		}
		return err
	}
	if !quietFlag(cmd) {
		cmd.Printf("Updated %d setting(s) at revision %d.\n", len(values), updated.Revision)
	}
	return printData(cmd, updated, func() string {
		return fmt.Sprintf("revision=%d", updated.Revision)
	})
}

func runSettingsEffective(cmd *cobra.Command, env *environment, ref string) error {
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
	status, body, err := transport.GetEffectivePolicy(ctx, screenID(record))
	if err != nil {
		return err
	}
	var policy map[string]any
	if err := apiclient.DecodeBody(status, body, &policy); err != nil {
		return err
	}
	return printData(cmd, policy, func() string {
		raw, _ := json.MarshalIndent(policy, "", "  ")
		return string(raw)
	})
}
