package cli

import (
	"fmt"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// This file holds the handwritten fleet group: screen details management
// (update, disable, enable, revoke) and the pairing ceremony (list,
// resolve, approve, reject). Every mutation here is sensitive: each one
// confirms on a TTY and refuses off-TTY unless --yes is given. Screen
// references accept an ID or a unique name through resolveScreen, exactly
// like screen get.

// addScreenManageCommands extends the handwritten screen command with its
// management verbs. screen.go owns list and get.
func addScreenManageCommands(env *environment, screen *cobra.Command) {
	update := &cobra.Command{
		Use:   "update <id-or-name>",
		Short: "Update a screen's details (unset flags keep current values)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScreenUpdate(cmd, env, args[0])
		},
	}
	addOutputFlags(update)
	update.Flags().String("name", "", "Screen name (2-120 characters)")
	update.Flags().String("location-id", "", "Location UUID (empty keeps current)")
	update.Flags().Bool("clear-location", false, "Remove the screen's location assignment")
	update.Flags().String("room-name", "", "Room name")
	update.Flags().String("room-number", "", "Room number")
	update.Flags().String("description", "", "Screen description")
	update.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	disable := &cobra.Command{
		Use:   "disable <id-or-name>",
		Short: "Disable a screen (status override; the player keeps its credential)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScreenEnabled(cmd, env, args[0], false)
		},
	}
	addOutputFlags(disable)
	disable.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	enable := &cobra.Command{
		Use:   "enable <id-or-name>",
		Short: "Enable a screen",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScreenEnabled(cmd, env, args[0], true)
		},
	}
	addOutputFlags(enable)
	enable.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	revoke := &cobra.Command{
		Use:   "revoke <id-or-name>",
		Short: "Permanently revoke a screen's device credential",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScreenRevoke(cmd, env, args[0])
		},
	}
	addOutputFlags(revoke)
	revoke.Flags().String("reason", "", "Why the credential is revoked (recorded)")
	revoke.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	screen.AddCommand(update, disable, enable, revoke)
}

func stringField(record screenRecord, key string) string {
	value, _ := record[key].(string)
	return value
}

func runScreenUpdate(cmd *cobra.Command, env *environment, ref string) error {
	flags := cmd.Flags()
	name, _ := flags.GetString("name")
	locationID, _ := flags.GetString("location-id")
	clearLocation, _ := flags.GetBool("clear-location")
	roomName, _ := flags.GetString("room-name")
	roomNumber, _ := flags.GetString("room-number")
	description, _ := flags.GetString("description")
	if name == "" && locationID == "" && !clearLocation && roomName == "" && roomNumber == "" && description == "" {
		return fmt.Errorf("nothing to update: pass at least one of --name, --location-id, --clear-location, --room-name, --room-number, --description")
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
	// The server replaces the whole details row and requires a valid
	// name, so unset flags keep the current values read first.
	current, err := resolveScreen(ctx, transport, ref)
	if err != nil {
		return err
	}
	body := map[string]any{
		"name":        orDefault(name, stringField(current, "name")),
		"roomName":    orDefault(roomName, stringField(current, "roomName")),
		"roomNumber":  orDefault(roomNumber, stringField(current, "roomNumber")),
		"description": orDefault(description, stringField(current, "description")),
	}
	switch {
	case clearLocation:
		body["locationId"] = nil
	case locationID != "":
		body["locationId"] = locationID
	case stringField(current, "locationId") != "":
		body["locationId"] = stringField(current, "locationId")
	default:
		body["locationId"] = nil
	}
	if err := confirmChange(cmd, fmt.Sprintf("update screen %q?", stringField(current, "name"))); err != nil {
		return err
	}
	status, payload, err := transport.UpdateScreen(ctx, screenID(current), body)
	if err != nil {
		return err
	}
	var updated screenRecord
	if err := apiclient.DecodeBody(status, payload, &updated); err != nil {
		return err
	}
	return printData(cmd, updated, func() string {
		return fmt.Sprintf("updated %s (%s)", screenName(updated), screenID(updated))
	})
}

func orDefault(flag, current string) string {
	if flag != "" {
		return flag
	}
	return current
}

func runScreenEnabled(cmd *cobra.Command, env *environment, ref string, enabled bool) error {
	action := "disable"
	if enabled {
		action = "enable"
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
	current, err := resolveScreen(ctx, transport, ref)
	if err != nil {
		return err
	}
	if err := confirmChange(cmd, fmt.Sprintf("%s screen %q?", action, stringField(current, "name"))); err != nil {
		return err
	}
	status, payload, err := transport.SetScreenEnabled(ctx, screenID(current), enabled)
	if err != nil {
		return err
	}
	if err := apiclient.DecodeBody(status, payload, nil); err != nil {
		return err
	}
	past := "disabled"
	if enabled {
		past = "enabled"
	}
	return printData(cmd, map[string]string{"id": screenID(current), "enabled": fmt.Sprint(enabled)}, func() string {
		return fmt.Sprintf("%s %s", past, stringField(current, "name"))
	})
}

func runScreenRevoke(cmd *cobra.Command, env *environment, ref string) error {
	reason, _ := cmd.Flags().GetString("reason")
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	current, err := resolveScreen(ctx, transport, ref)
	if err != nil {
		return err
	}
	if err := confirmChange(cmd, fmt.Sprintf("permanently revoke %q's credential? The player disconnects and must re-pair.", stringField(current, "name"))); err != nil {
		return err
	}
	status, payload, err := transport.RevokeScreen(ctx, screenID(current), reason)
	if err != nil {
		return err
	}
	if err := apiclient.DecodeBody(status, payload, nil); err != nil {
		return err
	}
	return printData(cmd, map[string]string{"id": screenID(current), "revoked": "true"}, func() string {
		return fmt.Sprintf("revoked %s", stringField(current, "name"))
	})
}

func newPairingCommand(env *environment) *cobra.Command {
	pairing := &cobra.Command{Use: "pairing", Short: "Review and approve player pairing requests"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List pending pairing sessions",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPairingList(cmd, env)
		},
	}
	addOutputFlags(list)
	resolve := &cobra.Command{
		Use:   "resolve <code>",
		Short: "Resolve a visible six-character pairing code into its session",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPairingResolve(cmd, env, args[0])
		},
	}
	addOutputFlags(resolve)
	approve := &cobra.Command{
		Use:   "approve <session-id>",
		Short: "Approve a pairing session and name its screen",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPairingApprove(cmd, env, args[0])
		},
	}
	addOutputFlags(approve)
	approve.Flags().String("name", "", "Screen name (2-120 characters)")
	approve.Flags().String("room-name", "", "Room name")
	approve.Flags().String("room-number", "", "Room number")
	approve.Flags().String("description", "", "Screen description")
	approve.Flags().String("location-id", "", "Location UUID")
	approve.Flags().Bool("replace-existing-credential", false, "Authorize credential rotation after enrollment")
	approve.Flags().Bool("replace-hardware", false, "Assign the player to an existing screen (needs --replacement-screen-id)")
	approve.Flags().String("replacement-screen-id", "", "Existing screen UUID for hardware replacement")
	approve.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	reject := &cobra.Command{
		Use:   "reject <session-id>",
		Short: "Reject a pairing session",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPairingReject(cmd, env, args[0])
		},
	}
	addOutputFlags(reject)
	reject.Flags().String("reason", "", "Why the pairing is rejected (recorded)")
	reject.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	pairing.AddCommand(list, resolve, approve, reject)
	return pairing
}

type pairingRecord map[string]any

func pairingID(record pairingRecord) string {
	value, _ := record["id"].(string)
	return value
}

func runPairingList(cmd *cobra.Command, env *environment) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.ListPendingPairings(ctx)
	if err != nil {
		return err
	}
	var data struct {
		Items []pairingRecord `json:"items"`
		Total int             `json:"total"`
	}
	if err := apiclient.DecodeBody(status, body, &data); err != nil {
		return err
	}
	sort.Slice(data.Items, func(i, j int) bool { return pairingID(data.Items[i]) < pairingID(data.Items[j]) })
	return printData(cmd, data.Items, func() string {
		var out strings.Builder
		writer := tabwriter.NewWriter(&out, 0, 4, 2, ' ', 0)
		for _, item := range data.Items {
			expires, _ := item["expiresAt"].(string)
			_, _ = writer.Write([]byte(pairingID(item) + "\t" + expires + "\n"))
		}
		_ = writer.Flush()
		return "SESSION\tEXPIRES\n" + strings.TrimSuffix(out.String(), "\n")
	})
}

func runPairingResolve(cmd *cobra.Command, env *environment, code string) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.ResolvePairingCode(ctx, code)
	if err != nil {
		return err
	}
	var session pairingRecord
	if err := apiclient.DecodeBody(status, body, &session); err != nil {
		return err
	}
	return printData(cmd, session, func() string {
		var out strings.Builder
		out.WriteString("session=" + pairingID(session) + "\n")
		if statusValue, _ := session["status"].(string); statusValue != "" {
			out.WriteString("status=" + statusValue + "\n")
		}
		if expires, _ := session["expiresAt"].(string); expires != "" {
			out.WriteString("expires=" + expires + "\n")
		}
		out.WriteString("approve with: tilecast pairing approve " + pairingID(session) + " --name <screen> --room-name <room> --room-number <n> --description <text>")
		return out.String()
	})
}

func runPairingApprove(cmd *cobra.Command, env *environment, id string) error {
	flags := cmd.Flags()
	name, _ := flags.GetString("name")
	roomName, _ := flags.GetString("room-name")
	roomNumber, _ := flags.GetString("room-number")
	description, _ := flags.GetString("description")
	locationID, _ := flags.GetString("location-id")
	replaceCredential, _ := flags.GetBool("replace-existing-credential")
	replaceHardware, _ := flags.GetBool("replace-hardware")
	replacementScreenID, _ := flags.GetString("replacement-screen-id")
	if name == "" || roomName == "" || roomNumber == "" || description == "" {
		return fmt.Errorf("approve needs --name, --room-name, --room-number, and --description")
	}
	if replaceHardware && replacementScreenID == "" {
		return fmt.Errorf("approve needs --replacement-screen-id with --replace-hardware")
	}
	if err := confirmChange(cmd, fmt.Sprintf("approve pairing %s as %q?", id, name)); err != nil {
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
	body := map[string]any{
		"name": name, "roomName": roomName, "roomNumber": roomNumber, "description": description,
		"replaceExistingCredential": replaceCredential, "replaceHardware": replaceHardware,
	}
	if locationID != "" {
		body["locationId"] = locationID
	} else {
		body["locationId"] = nil
	}
	if replacementScreenID != "" {
		body["replacementScreenId"] = replacementScreenID
	} else {
		body["replacementScreenId"] = nil
	}
	status, payload, err := transport.ApprovePairing(ctx, id, body)
	if err != nil {
		return err
	}
	var screen screenRecord
	if err := apiclient.DecodeBody(status, payload, &screen); err != nil {
		return err
	}
	return printData(cmd, screen, func() string {
		return fmt.Sprintf("approved %s (%s)", screenName(screen), screenID(screen))
	})
}

func runPairingReject(cmd *cobra.Command, env *environment, id string) error {
	reason, _ := cmd.Flags().GetString("reason")
	if err := confirmChange(cmd, fmt.Sprintf("reject pairing %s?", id)); err != nil {
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
	status, payload, err := transport.RejectPairing(ctx, id, reason)
	if err != nil {
		return err
	}
	if err := apiclient.DecodeBody(status, payload, nil); err != nil {
		return err
	}
	return printData(cmd, map[string]string{"id": id, "rejected": "true"}, func() string {
		return fmt.Sprintf("rejected %s", id)
	})
}
