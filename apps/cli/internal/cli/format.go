package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

// Output conventions for the first CLI slice, established here and reused
// by every later command: stdout carries result data, stderr carries
// progress and warnings, --json switches the data rendering, and --quiet
// suppresses everything but data and errors. Read-only commands never
// prompt, so non-TTY invocations are safe by construction; explicit
// mutations (plugin install/remove, sensitive+ automation operations)
// prompt on a TTY and refuse off-TTY unless --yes is given.

// addOutputFlags registers the shared rendering flags.
func addOutputFlags(cmd *cobra.Command) {
	cmd.Flags().Bool("json", false, "Render result data as JSON on stdout")
	cmd.Flags().Bool("plain", false, "Render plain rows without table framing")
	cmd.Flags().Bool("quiet", false, "Suppress informational output; data and errors only")
}

func jsonFlag(cmd *cobra.Command) bool {
	value, _ := cmd.Flags().GetBool("json")
	return value
}

func quietFlag(cmd *cobra.Command) bool {
	value, _ := cmd.Flags().GetBool("quiet")
	if !value {
		value, _ = cmd.InheritedFlags().GetBool("quiet")
	}
	return value
}

// printData renders one result payload on stdout: JSON with --json, or the
// human rendering otherwise. Cobra's Print helpers write to stderr, so data
// never goes through them.
func printData(cmd *cobra.Command, payload any, human func() string) error {
	if jsonFlag(cmd) {
		raw, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(cmd.OutOrStdout(), string(raw))
		return err
	}
	_, err := fmt.Fprintln(cmd.OutOrStdout(), human())
	return err
}

// timeoutContext bounds one command's server calls. --timeout is a
// Go duration (30s default); zero or negative disables the bound, which
// non-interactive callers should only do deliberately.
func timeoutContext(cmd *cobra.Command) (context.Context, context.CancelFunc, error) {
	raw, _ := cmd.Flags().GetString("timeout")
	if raw == "" {
		raw, _ = cmd.InheritedFlags().GetString("timeout")
	}
	return timeoutWithValue(cmd.Context(), raw)
}

// timeoutWithValue bounds server calls by an explicit duration string,
// shared by Cobra-parsed commands and the dynamic plugin dispatcher,
// which parses the fixed global set itself.
func timeoutWithValue(base context.Context, raw string) (context.Context, context.CancelFunc, error) {
	if raw == "" {
		raw = (30 * time.Second).String()
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid --timeout %q: %w", raw, err)
	}
	if parsed <= 0 {
		return base, func() {}, nil
	}
	ctx, cancel := context.WithTimeout(base, parsed)
	return ctx, cancel, nil
}
