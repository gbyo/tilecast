package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// This file holds handwritten plugin lifecycle commands and the generic
// automation dispatcher. Lifecycle (list, get, install, remove) is
// designed here like every other core command. Per-plugin operations are
// never handwritten: they are built at runtime from each installed
// plugin's resolved automation document, so adding a plugin with an API
// and an automation.yaml needs no change to this package. The boundary
// test enforces that: this package must not name plugin identifiers.

// pluginRecord is the display subset the CLI reads off a generic catalog
// entry. Unknown members stay empty rather than failing.
type pluginRecord map[string]any

func pluginID(record pluginRecord) string {
	value, _ := record["id"].(string)
	return value
}

func pluginName(record pluginRecord) string {
	value, _ := record["name"].(string)
	return value
}

func pluginFlag(record pluginRecord, key string) string {
	value, _ := record[key].(bool)
	if value {
		return "yes"
	}
	return "no"
}

func newPluginCommand(env *environment) *cobra.Command {
	plugin := &cobra.Command{Use: "plugin", Short: "List, inspect, install, and remove plugins"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List the plugins this release offers with installation state",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPluginList(cmd, env)
		},
	}
	addOutputFlags(list)
	get := &cobra.Command{
		Use:   "get <plugin-id>",
		Short: "Show one plugin catalog entry",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPluginGet(cmd, env, args[0])
		},
	}
	addOutputFlags(get)
	install := &cobra.Command{
		Use:   "install <plugin-id>",
		Short: "Record a release-owned plugin as installed (idempotent)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPluginInstall(cmd, env, args[0])
		},
	}
	addOutputFlags(install)
	install.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	remove := &cobra.Command{
		Use:   "remove <plugin-id>",
		Short: "Delete a plugin installation record (plugin data is kept)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPluginRemove(cmd, env, args[0])
		},
	}
	addOutputFlags(remove)
	remove.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	plugin.AddCommand(list, get, install, remove)
	return plugin
}

func fetchCatalog(ctx context.Context, transport *apiclient.Client) (map[string]any, []pluginRecord, error) {
	status, body, err := transport.ListPlugins(ctx)
	if err != nil {
		return nil, nil, err
	}
	var catalog map[string]any
	if err := apiclient.DecodeBody(status, body, &catalog); err != nil {
		return nil, nil, err
	}
	var items []pluginRecord
	if raw, ok := catalog["items"]; ok {
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, nil, err
		}
		if err := json.Unmarshal(encoded, &items); err != nil {
			return nil, nil, err
		}
	}
	return catalog, items, nil
}

func runPluginList(cmd *cobra.Command, env *environment) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	catalog, items, err := fetchCatalog(ctx, transport)
	if err != nil {
		return err
	}
	if unsupported, _ := catalog["unsupportedInstallations"].([]any); len(unsupported) > 0 && !quietFlag(cmd) {
		fmt.Fprintf(cmd.ErrOrStderr(), "%d unsupported installation(s) preserved and inert\n", len(unsupported))
	}
	sort.Slice(items, func(i, j int) bool { return pluginID(items[i]) < pluginID(items[j]) })
	return printData(cmd, catalog, func() string {
		var out strings.Builder
		writer := tabwriter.NewWriter(&out, 0, 4, 2, ' ', 0)
		for _, item := range items {
			_, _ = writer.Write([]byte(pluginID(item) + "\t" + pluginName(item) + "\t" + pluginFlag(item, "installed") + "\t" + pluginFlag(item, "active") + "\n"))
		}
		_ = writer.Flush()
		return "ID\tNAME\tINSTALLED\tACTIVE\n" + strings.TrimSuffix(out.String(), "\n")
	})
}

func runPluginGet(cmd *cobra.Command, env *environment, id string) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	_, items, err := fetchCatalog(ctx, transport)
	if err != nil {
		return err
	}
	for _, item := range items {
		if pluginID(item) == id {
			return printData(cmd, item, func() string {
				raw, _ := json.MarshalIndent(item, "", "  ")
				return string(raw)
			})
		}
	}
	return fmt.Errorf("unknown plugin %q (see tilecast plugin list)", id)
}

func runPluginInstall(cmd *cobra.Command, env *environment, id string) error {
	if err := confirmChange(cmd, fmt.Sprintf("install plugin %q?", id)); err != nil {
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
	status, body, err := transport.InstallPlugin(ctx, id)
	if err != nil {
		return err
	}
	var item pluginRecord
	if err := apiclient.DecodeBody(status, body, &item); err != nil {
		return err
	}
	if status == http.StatusOK && !quietFlag(cmd) {
		fmt.Fprintf(cmd.ErrOrStderr(), "%s was already installed\n", id)
	}
	return printData(cmd, item, func() string {
		return fmt.Sprintf("installed %s", pluginID(item))
	})
}

func runPluginRemove(cmd *cobra.Command, env *environment, id string) error {
	if err := confirmChange(cmd, fmt.Sprintf("remove plugin %q? Plugin data is kept, but the feature stops.", id)); err != nil {
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
	status, body, err := transport.RemovePlugin(ctx, id)
	if err != nil {
		return err
	}
	if err := apiclient.DecodeBody(status, body, nil); err != nil {
		return err
	}
	return printData(cmd, map[string]string{"removed": id}, func() string {
		return fmt.Sprintf("removed %s", id)
	})
}

// confirmChange gates an explicit operator action. --yes proceeds; a TTY
// prompts on stderr; anything else refuses rather than guessing. Stdin
// from a pipe or a closed stream is not a TTY, so scripts must pass --yes.
func confirmChange(cmd *cobra.Command, action string) error {
	if yes, _ := cmd.Flags().GetBool("yes"); yes {
		return nil
	}
	if yes, _ := cmd.InheritedFlags().GetBool("yes"); yes {
		return nil
	}
	stdin := cmd.InOrStdin()
	if file, ok := stdin.(*os.File); ok {
		// Pipes, closed streams, and anything unreadable are not a TTY:
		// scripts pass --yes instead of answering a prompt nobody reads.
		if stat, err := file.Stat(); err != nil || stat.Mode()&os.ModeCharDevice == 0 {
			return fmt.Errorf("refusing to %s without --yes on non-interactive input", action)
		}
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "%s Proceed? [y/N]: ", action)
	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil {
		// No answer at all (EOF, /dev/null, closed pipe) is the same as
		// non-interactive: point at --yes instead of a bare refusal.
		return fmt.Errorf("refusing to %s without --yes on non-interactive input", action)
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	if answer != "y" && answer != "yes" {
		return fmt.Errorf("cancelled: %s", action)
	}
	return nil
}

// automationOp is one resolved operation a server reported. It mirrors
// the PluginAutomation schema without importing plugin packages: the CLI
// dispatches on data, never on plugin code.
type automationOp struct {
	OperationID string   `json:"operationId"`
	Method      string   `json:"method"`
	Path        string   `json:"path"`
	Risk        string   `json:"risk"`
	CLIPath     []string `json:"cliPath"`
	MCPAction   string   `json:"mcpAction"`
	Input       string   `json:"input,omitempty"`
	Description string   `json:"description,omitempty"`
}

type automationDoc struct {
	APIVersion int            `json:"apiVersion"`
	Plugin     string         `json:"plugin"`
	Operations []automationOp `json:"operations"`
}

// Execute dispatches one invocation. Static commands run unchanged. Any
// other leading word is treated as a plugin command root: the CLI fetches
// the installed plugins' automation documents, builds their command
// trees, and executes the match. No plugin identifier appears in this
// package; unknown roots name `tilecast plugin list`.
func Execute(root *cobra.Command, env *environment, args []string) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") || args[0] == "help" || staticCommand(root, args[0]) {
		root.SetArgs(args)
		return root.Execute()
	}
	scanned := preScanGlobals(args)
	resolver := Resolver{
		ServerFlag:  scanned["server"],
		ContextFlag: scanned["context"],
		Store:       env.config,
		Secrets:     env.secrets,
	}
	resolved, err := resolver.Resolve(true)
	if err != nil {
		return err
	}
	transport, err := env.newTransport(resolved)
	if err != nil {
		return err
	}
	timeout := scanned["timeout"]
	if timeout == "" {
		timeout = (30 * time.Second).String()
	}
	bound, err := time.ParseDuration(timeout)
	if err != nil {
		return fmt.Errorf("invalid --timeout %q", timeout)
	}
	ctx := context.Background()
	var cancel context.CancelFunc = func() {}
	if bound > 0 {
		ctx, cancel = context.WithTimeout(ctx, bound)
	}
	defer cancel()
	documents, err := fetchAutomation(ctx, transport)
	if err != nil {
		return err
	}
	roots := buildAutomationTree(env, documents)
	if len(roots) == 0 {
		return fmt.Errorf("unknown command %q (no installed plugin maps automation; see tilecast plugin list)", args[0])
	}
	root.AddCommand(roots...)
	if !staticCommand(root, args[0]) {
		return fmt.Errorf("unknown command %q (see tilecast plugin list)", args[0])
	}
	root.SetArgs(args)
	return root.Execute()
}

// staticCommand reports whether the root already handles the word.
func staticCommand(root *cobra.Command, word string) bool {
	for _, sub := range root.Commands() {
		if sub.Name() == word {
			return true
		}
		for _, alias := range sub.Aliases {
			if alias == word {
				return true
			}
		}
	}
	return false
}

// preScanGlobals reads the server, credential, context, and timeout
// precedence flags without a command tree, in --flag value and
// --flag=value form. Last wins, matching pflag.
func preScanGlobals(args []string) map[string]string {
	found := map[string]string{}
	wanted := map[string]bool{"server": true, "context": true, "timeout": true}
	for i := 0; i < len(args); i++ {
		raw := args[i]
		if !strings.HasPrefix(raw, "--") || strings.HasPrefix(raw, "---") {
			continue
		}
		name := strings.TrimPrefix(raw, "--")
		var value string
		if index := strings.Index(name, "="); index >= 0 {
			value = name[index+1:]
			name = name[:index]
		} else if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			value = args[i+1]
		}
		if wanted[name] {
			found[name] = value
		}
	}
	return found
}

// fetchAutomation returns the resolved documents of every installed
// plugin that maps automation. Uninstalled plugins 409, unknown ones
// 404, and mapping-less ones 404 here too; none of those are errors for
// dispatch, they just contribute no commands.
func fetchAutomation(ctx context.Context, transport *apiclient.Client) ([]automationDoc, error) {
	status, body, err := transport.ListPlugins(ctx)
	if err != nil {
		return nil, err
	}
	var catalog struct {
		Items []struct {
			ID        string `json:"id"`
			Installed bool   `json:"installed"`
		} `json:"items"`
	}
	if err := apiclient.DecodeBody(status, body, &catalog); err != nil {
		return nil, err
	}
	var documents []automationDoc
	for _, item := range catalog.Items {
		if !item.Installed {
			continue
		}
		status, body, err := transport.GetPluginAutomation(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		if status == http.StatusNotFound || status == http.StatusConflict {
			continue
		}
		var document automationDoc
		if err := apiclient.DecodeBody(status, body, &document); err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	return documents, nil
}

// buildAutomationTree groups operations by their CLI path roots. Paths
// from different plugins share no root: pluginctl rejects collisions,
// and the last document wins a same-process duplicate rather than
// merging two plugins' operations under one word.
func buildAutomationTree(env *environment, documents []automationDoc) []*cobra.Command {
	byRoot := map[string]*cobra.Command{}
	order := []string{}
	leafOf := func(root *cobra.Command, segments []string) *cobra.Command {
		current := root
		for _, segment := range segments {
			var next *cobra.Command
			for _, sub := range current.Commands() {
				if sub.Name() == segment {
					next = sub
					break
				}
			}
			if next == nil {
				next = &cobra.Command{Use: segment, Short: fmt.Sprintf("%s %s commands", root.Name(), segment)}
				current.AddCommand(next)
			}
			current = next
		}
		return current
	}
	for _, document := range documents {
		for _, operation := range document.Operations {
			if len(operation.CLIPath) == 0 {
				continue
			}
			rootName := operation.CLIPath[0]
			root, ok := byRoot[rootName]
			if !ok {
				root = &cobra.Command{Use: rootName, Short: fmt.Sprintf("Operate %s (generic automation)", rootName)}
				byRoot[rootName] = root
				order = append(order, rootName)
			}
			parent := leafOf(root, operation.CLIPath[1:len(operation.CLIPath)-1])
			leaf := newAutomationLeaf(env, operation)
			parent.AddCommand(leaf)
		}
	}
	sort.Strings(order)
	roots := make([]*cobra.Command, 0, len(order))
	for _, name := range order {
		roots = append(roots, byRoot[name])
	}
	return roots
}

func newAutomationLeaf(env *environment, operation automationOp) *cobra.Command {
	short := operation.Description
	if short == "" {
		short = operation.OperationID
	}
	leaf := &cobra.Command{
		Use:   leafUse(operation),
		Short: short,
		Long:  fmt.Sprintf("%s\n\nRisk: %s\nOperation: %s", short, operation.Risk, operation.OperationID),
		Args:  cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAutomationOp(cmd, env, operation, args)
		},
	}
	addOutputFlags(leaf)
	leaf.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	leaf.Flags().String("input", "", "JSON document for the request body")
	leaf.Flags().String("file", "", "Read the JSON request body from this file")
	return leaf
}

// leafUse names path parameters positionally: `get <id>`.
func leafUse(operation automationOp) string {
	use := operation.CLIPath[len(operation.CLIPath)-1]
	for _, segment := range strings.Split(operation.Path, "/") {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			use += " <" + strings.Trim(segment, "{}") + ">"
		}
	}
	return use
}

func runAutomationOp(cmd *cobra.Command, env *environment, operation automationOp, args []string) error {
	method, err := automationMethod(operation.Method)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(operation.Path, "/api/v1/plugins/") {
		return fmt.Errorf("operation %q maps outside plugin paths", operation.OperationID)
	}
	path, err := fillAutomationPath(operation.Path, args)
	if err != nil {
		return err
	}
	var body io.Reader
	if method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch {
		raw, err := readAutomationInput(cmd)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	} else if input, _ := cmd.Flags().GetString("input"); input != "" {
		return fmt.Errorf("operation %q takes no request body", operation.OperationID)
	} else if file, _ := cmd.Flags().GetString("file"); file != "" {
		return fmt.Errorf("operation %q takes no request body", operation.OperationID)
	}
	switch operation.Risk {
	case "sensitive", "high-impact", "security-critical":
		if err := confirmChange(cmd, fmt.Sprintf("run %s (%s)?", operation.OperationID, operation.Risk)); err != nil {
			return err
		}
	case "read", "routine":
	default:
		return fmt.Errorf("operation %q carries unknown risk %q", operation.OperationID, operation.Risk)
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
	status, response, err := transport.Call(ctx, method, path, body)
	if err != nil {
		return err
	}
	var data any
	if err := apiclient.DecodeBody(status, response, &data); err != nil {
		return err
	}
	if data == nil {
		if !quietFlag(cmd) {
			fmt.Fprintln(cmd.ErrOrStderr(), "ok")
		}
		return nil
	}
	return printData(cmd, data, func() string {
		raw, _ := json.MarshalIndent(data, "", "  ")
		return string(raw)
	})
}

func automationMethod(raw string) (string, error) {
	switch strings.ToLower(raw) {
	case "get":
		return http.MethodGet, nil
	case "post":
		return http.MethodPost, nil
	case "put":
		return http.MethodPut, nil
	case "patch":
		return http.MethodPatch, nil
	case "delete":
		return http.MethodDelete, nil
	default:
		return "", fmt.Errorf("unsupported automation method %q", raw)
	}
}

// fillAutomationPath substitutes {params} positionally in path order.
// Missing and extra values are errors, never guesses.
func fillAutomationPath(template string, args []string) (string, error) {
	var names []string
	for _, segment := range strings.Split(template, "/") {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			names = append(names, strings.Trim(segment, "{}"))
		}
	}
	if len(args) < len(names) {
		return "", fmt.Errorf("missing value for {%s}", names[len(args)])
	}
	if len(args) > len(names) {
		return "", fmt.Errorf("unexpected argument %q", args[len(names)])
	}
	path := template
	for i, name := range names {
		path = strings.Replace(path, "{"+name+"}", args[i], 1)
	}
	return path, nil
}

// readAutomationInput loads the JSON request body from --input or --file.
// Exactly one is required for body operations; the document must be JSON.
func readAutomationInput(cmd *cobra.Command) ([]byte, error) {
	input, _ := cmd.Flags().GetString("input")
	file, _ := cmd.Flags().GetString("file")
	if input != "" && file != "" {
		return nil, fmt.Errorf("use only one of --input and --file")
	}
	var raw []byte
	if file != "" {
		loaded, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		raw = loaded
	} else if input != "" {
		raw = []byte(input)
	} else {
		return nil, fmt.Errorf("this operation needs a JSON body: pass --input or --file")
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("request body is not valid JSON")
	}
	return raw, nil
}
