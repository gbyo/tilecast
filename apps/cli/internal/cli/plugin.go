package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"text/tabwriter"

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
	plugin := &cobra.Command{
		Use:   "plugin",
		Short: "List, inspect, install, and remove plugins",
		Long: `List, inspect, install, and remove plugins.

Installed plugins with automation also serve their operator commands
here: tilecast plugin <plugin> ... runs the operations the installed
plugin maps, with no plugin-specific code in this binary.`,
		// Operation flags belong to dynamic plugin operations resolved
		// at runtime, so this parent skips Cobra flag parsing entirely:
		// RunE receives every token after `plugin` verbatim, including
		// global flags wherever they appear. The dispatcher below parses
		// the small fixed global set itself; static lifecycle subcommands
		// keep their own normal Cobra parsing unaffected.
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPluginDynamic(cmd, env, args)
		},
	}
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
	return confirmExplicit(action, false, cmd.InOrStdin(), cmd.ErrOrStderr())
}

// automationParam is one OpenAPI-derived scalar parameter from the
// resolved automation document. automation.yaml never carries these;
// pluginctl derives them from the plugin's OpenAPI operation, and the
// generated automation artifact serves them to this dispatcher.
type automationParam struct {
	Name        string `json:"name"`
	Required    bool   `json:"required"`
	Type        string `json:"type"`
	Format      string `json:"format,omitempty"`
	Enum        []any  `json:"enum,omitempty"`
	Description string `json:"description,omitempty"`
}

// automationBody is the JSON request-body contract for one operation,
// derived from the operation's OpenAPI schema for MCP construction.
type automationBody struct {
	Required bool           `json:"required"`
	Schema   map[string]any `json:"schema"`
}

// automationOp is one resolved operation a server reported. It mirrors
// the PluginAutomation schema without importing plugin packages: the CLI
// dispatches on data, never on plugin code. Parameter and body metadata
// ride the same generated document; older servers omit them, and the
// dispatcher degrades to positional path arguments plus --input/--file.
type automationOp struct {
	OperationID string            `json:"operationId"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Risk        string            `json:"risk"`
	CLIPath     []string          `json:"cliPath"`
	MCPAction   string            `json:"mcpAction"`
	Input       string            `json:"input,omitempty"`
	Description string            `json:"description,omitempty"`
	PathParams  []automationParam `json:"pathParams,omitempty"`
	QueryParams []automationParam `json:"queryParams,omitempty"`
	RequestBody *automationBody   `json:"requestBody,omitempty"`
}

type automationDoc struct {
	APIVersion int            `json:"apiVersion"`
	Plugin     string         `json:"plugin"`
	Operations []automationOp `json:"operations"`
}

// runPluginDynamic dispatches `tilecast plugin <plugin> ...` against the
// installed plugins' resolved automation documents. This is the one
// canonical plugin execution path: the production binary reaches it
// through the normal command tree, so global flags work wherever Cobra
// accepts them and tests exercise the same route. No plugin identifier
// appears in this package; unknown roots name `tilecast plugin list`.
func runPluginDynamic(cmd *cobra.Command, env *environment, raw []string) error {
	globals, rest, help, err := parseDynamicGlobals(raw)
	if err != nil {
		return err
	}
	if help || len(rest) == 0 {
		return cmd.Help()
	}
	resolved, err := Resolver{
		ServerFlag:  globals.server,
		ContextFlag: globals.context,
		Store:       env.config,
		Secrets:     env.secrets,
	}.Resolve(true)
	if err != nil {
		return err
	}
	ctx, cancel, err := timeoutWithValue(cmd.Context(), globals.timeout)
	if err != nil {
		return err
	}
	defer cancel()
	transport, err := env.newTransport(resolved)
	if err != nil {
		cancel()
		return err
	}
	transport = transport.WithAgent("tilecast-cli")
	documents, err := fetchAutomation(ctx, transport)
	if err != nil {
		return err
	}
	operation, positionals, flags, err := matchDynamicOp(documents, rest)
	if err != nil {
		return err
	}
	flags.quiet = flags.quiet || globals.quiet
	return executeDynamicOp(cmd, operation, transport, ctx, positionals, flags)
}

// dynamicGlobals are the fixed global flags the dynamic dispatcher
// parses itself: server selection, context selection, the call bound,
// quiet output, and help. Everything else passes through to operation
// matching untouched.
type dynamicGlobals struct {
	server  string
	context string
	timeout string
	quiet   bool
}

// parseDynamicGlobals extracts the fixed global set from raw tokens,
// wherever they appear. --name=value and --name value both work; --
// ends global parsing so dashed operation values stay expressible.
// Unknown --flags are never consumed here: they belong to operations.
func parseDynamicGlobals(raw []string) (dynamicGlobals, []string, bool, error) {
	var globals dynamicGlobals
	var rest []string
	help := false
	for i := 0; i < len(raw); i++ {
		token := raw[i]
		if token == "--" {
			rest = append(rest, raw[i+1:]...)
			break
		}
		name, value, attached := cutDynamicFlag(token)
		if !attached {
			rest = append(rest, token)
			continue
		}
		switch name {
		case "help", "h":
			help = true
		case "quiet":
			if value == "" {
				globals.quiet = true
				continue
			}
			parsed, err := parseDynamicBool(name, value)
			if err != nil {
				return globals, nil, false, err
			}
			globals.quiet = parsed
		case "server", "context", "timeout":
			if value == "" {
				if i+1 >= len(raw) || looksLikeFlag(raw[i+1]) {
					return globals, nil, false, fmt.Errorf("--%s needs a value", name)
				}
				value = raw[i+1]
				i++
			}
			switch name {
			case "server":
				globals.server = value
			case "context":
				globals.context = value
			case "timeout":
				globals.timeout = value
			}
		default:
			rest = append(rest, token)
			if value == "" && i+1 < len(raw) && !looksLikeFlag(raw[i+1]) {
				// Leave the following token for operation parsing:
				// only known globals consume values here.
			}
		}
	}
	return globals, rest, help, nil
}

// cutDynamicFlag splits a --name[=value] token. Single-dash tokens and
// bare words are not flags.
func cutDynamicFlag(token string) (name, value string, attached bool) {
	if len(token) < 3 || !strings.HasPrefix(token, "--") {
		return "", "", false
	}
	name = strings.TrimPrefix(token, "--")
	if index := strings.Index(name, "="); index >= 0 {
		return name[:index], name[index+1:], true
	}
	return name, "", true
}

// dynamicFlags are one dynamic invocation's parsed flags: the shared
// document/confirmation/output set plus the operation's OpenAPI-derived
// query flags. Nothing here is a UI DSL: query flags come straight from
// the resolved automation metadata.
type dynamicFlags struct {
	input string
	file  string
	yes   bool
	json  bool
	plain bool
	quiet bool
	query map[string]string
}

// dynamicBoolFlags take no value; every other known flag takes one.
var dynamicBoolFlags = map[string]bool{"yes": true, "json": true, "plain": true, "quiet": true}

// splitDynamicTokens separates --flags from positional arguments without
// a command tree. --name=value is self-contained; --name consumes the
// next token unless it looks like another flag; -- ends flag parsing so
// values starting with a dash stay expressible.
func splitDynamicTokens(raw []string) (positionals []string, pairs map[string]string, bares []string, err error) {
	pairs = map[string]string{}
	positionals = []string{}
	bares = []string{}
	for i := 0; i < len(raw); i++ {
		token := raw[i]
		if token == "--" {
			positionals = append(positionals, raw[i+1:]...)
			break
		}
		if len(token) < 3 || !strings.HasPrefix(token, "--") {
			positionals = append(positionals, token)
			continue
		}
		name := strings.TrimPrefix(token, "--")
		if value, ok := cutFlagValue(name); ok {
			pairs[name[:len(name)-len(value)-1]] = value
			continue
		}
		if i+1 < len(raw) && !looksLikeFlag(raw[i+1]) {
			pairs[name] = raw[i+1]
			i++
			continue
		}
		bares = append(bares, name)
	}
	return positionals, pairs, bares, nil
}

// cutFlagValue splits name=value into its parts.
func cutFlagValue(token string) (string, bool) {
	index := strings.Index(token, "=")
	if index < 0 {
		return "", false
	}
	return token[index+1:], true
}

// looksLikeFlag reports whether the token parses as a flag rather than a
// value. Single-dash words count so negative numbers and dashed values
// need the --name=value form or the -- terminator.
func looksLikeFlag(token string) bool {
	return len(token) > 1 && strings.HasPrefix(token, "-")
}

// matchDynamicOp finds the operation behind one dynamic invocation. The
// longest CLI path prefix wins; remaining positionals feed path
// placeholders, and --flags resolve against the shared set plus the
// operation's own query parameters.
func matchDynamicOp(documents []automationDoc, raw []string) (automationOp, []string, dynamicFlags, error) {
	var zero automationOp
	positionals, pairs, bares, err := splitDynamicTokens(raw)
	if err != nil {
		return zero, nil, dynamicFlags{}, err
	}
	var best *automationOp
	for _, document := range documents {
		for _, operation := range document.Operations {
			operation := operation
			if len(operation.CLIPath) == 0 || len(operation.CLIPath) > len(positionals) {
				continue
			}
			match := true
			for i, segment := range operation.CLIPath {
				if positionals[i] != segment {
					match = false
					break
				}
			}
			if !match {
				continue
			}
			if best == nil || len(operation.CLIPath) > len(best.CLIPath) {
				best = &operation
			}
		}
	}
	if best == nil {
		return zero, nil, dynamicFlags{}, fmt.Errorf("unknown plugin command %q (%s)", strings.Join(positionals, " "), dynamicRootsHint(documents))
	}
	operation := *best
	queryNames := map[string]automationParam{}
	for _, param := range operation.QueryParams {
		queryNames[param.Name] = param
	}
	flags := dynamicFlags{query: map[string]string{}}
	for name, value := range pairs {
		switch {
		case name == "input":
			flags.input = value
		case name == "file":
			flags.file = value
		case dynamicBoolFlags[name]:
			parsed, err := parseDynamicBool(name, value)
			if err != nil {
				return zero, nil, dynamicFlags{}, err
			}
			setDynamicBool(&flags, name, parsed)
		case queryNames[name].Name != "":
			flags.query[name] = value
		default:
			return zero, nil, dynamicFlags{}, fmt.Errorf("unknown flag --%s for %q", name, operation.OperationID)
		}
	}
	for _, name := range bares {
		switch {
		case dynamicBoolFlags[name]:
			setDynamicBool(&flags, name, true)
		case name == "input" || name == "file":
			return zero, nil, dynamicFlags{}, fmt.Errorf("--%s needs a value", name)
		case queryNames[name].Name != "" && queryNames[name].Type == "boolean":
			flags.query[name] = "true"
		case queryNames[name].Name != "":
			return zero, nil, dynamicFlags{}, fmt.Errorf("--%s needs a value", name)
		default:
			return zero, nil, dynamicFlags{}, fmt.Errorf("unknown flag --%s for %q", name, operation.OperationID)
		}
	}
	for _, param := range operation.QueryParams {
		if param.Required {
			if _, ok := flags.query[param.Name]; !ok {
				return zero, nil, dynamicFlags{}, fmt.Errorf("missing required --%s", param.Name)
			}
		}
	}
	names := automationPathNames(operation.Path)
	rest := positionals[len(operation.CLIPath):]
	if len(rest) < len(names) {
		return zero, nil, dynamicFlags{}, fmt.Errorf("missing value for {%s}", names[len(rest)])
	}
	if len(rest) > len(names) {
		return zero, nil, dynamicFlags{}, fmt.Errorf("unexpected argument %q", rest[len(names)])
	}
	return operation, rest, flags, nil
}

// parseDynamicBool reads an explicit --flag=value for a boolean flag.
func parseDynamicBool(name, value string) (bool, error) {
	switch strings.ToLower(value) {
	case "true", "1", "yes":
		return true, nil
	case "false", "0", "no":
		return false, nil
	default:
		return false, fmt.Errorf("--%s takes a boolean value, got %q", name, value)
	}
}

func setDynamicBool(flags *dynamicFlags, name string, value bool) {
	switch name {
	case "yes":
		flags.yes = value
	case "json":
		flags.json = value
	case "plain":
		flags.plain = value
	case "quiet":
		flags.quiet = value
	}
}

// dynamicRootsHint names the installed plugin command roots for unknown
// command errors.
func dynamicRootsHint(documents []automationDoc) string {
	seen := map[string]bool{}
	var roots []string
	for _, document := range documents {
		for _, operation := range document.Operations {
			if len(operation.CLIPath) == 0 || seen[operation.CLIPath[0]] {
				continue
			}
			seen[operation.CLIPath[0]] = true
			roots = append(roots, operation.CLIPath[0])
		}
	}
	sort.Strings(roots)
	if len(roots) == 0 {
		return "no installed plugin maps automation; see tilecast plugin list"
	}
	return "installed plugin commands: " + strings.Join(roots, ", ") + "; see tilecast plugin list"
}

// automationPathNames lists {placeholders} in template order.
func automationPathNames(template string) []string {
	var names []string
	for _, segment := range strings.Split(template, "/") {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			names = append(names, strings.Trim(segment, "{}"))
		}
	}
	return names
}

// executeDynamicOp runs one matched operation: escaped path parameters,
// derived query flags, document bodies, the risk confirmation gate, and
// JSON-or-human output.
func executeDynamicOp(cmd *cobra.Command, operation automationOp, transport *apiclient.Client, ctx context.Context, positionals []string, flags dynamicFlags) error {
	method, err := automationMethod(operation.Method)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(operation.Path, "/api/v1/plugins/") {
		return fmt.Errorf("operation %q maps outside plugin paths", operation.OperationID)
	}
	if operation.Input == "fields" {
		return fmt.Errorf("operation %q uses field inputs, which the generic CLI does not support; ask the plugin author for a document input", operation.OperationID)
	}
	path, err := fillAutomationPath(operation.Path, positionals)
	if err != nil {
		return err
	}
	if query := dynamicQuery(operation.QueryParams, flags.query); query != "" {
		path += "?" + query
	}
	var body io.Reader
	if method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch {
		raw, err := readAutomationBody(flags.input, flags.file)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	} else if flags.input != "" {
		return fmt.Errorf("operation %q takes no request body", operation.OperationID)
	} else if flags.file != "" {
		return fmt.Errorf("operation %q takes no request body", operation.OperationID)
	}
	switch operation.Risk {
	case "sensitive", "high-impact", "security-critical":
		if err := confirmExplicit(fmt.Sprintf("run %s (%s)?", operation.OperationID, operation.Risk), flags.yes, cmd.InOrStdin(), cmd.ErrOrStderr()); err != nil {
			return err
		}
	case "read", "routine":
	default:
		return fmt.Errorf("operation %q carries unknown risk %q", operation.OperationID, operation.Risk)
	}
	status, response, err := transport.Call(ctx, method, path, body)
	if err != nil {
		return err
	}
	var data any
	if err := apiclient.DecodeBody(status, response, &data); err != nil {
		return err
	}
	if data == nil {
		if !flags.quiet && !quietFlag(cmd) {
			fmt.Fprintln(cmd.ErrOrStderr(), "ok")
		}
		return nil
	}
	if flags.json {
		raw, err := json.MarshalIndent(data, "", "  ")
		if err != nil {
			return err
		}
		cmd.Println(string(raw))
		return nil
	}
	raw, _ := json.MarshalIndent(data, "", "  ")
	cmd.Println(string(raw))
	return nil
}

// readAutomationInput loads the JSON request body from --input or --file.
// Exactly one is required for body operations; the document must be JSON.
func readAutomationInput(cmd *cobra.Command) ([]byte, error) {
	input, _ := cmd.Flags().GetString("input")
	file, _ := cmd.Flags().GetString("file")
	return readAutomationBody(input, file)
}

// readAutomationBody loads the JSON request body from explicit values.
func readAutomationBody(input, file string) ([]byte, error) {
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
// Each value becomes exactly one path segment through path-segment
// escaping, so reserved characters cannot alter the route. Missing and
// extra values are errors, never guesses.
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
		path = strings.Replace(path, "{"+name+"}", url.PathEscape(args[i]), 1)
	}
	return path, nil
}

// dynamicQuery encodes the provided query flags. Unknown keys never reach
// here: matching rejects them before the request is built.
func dynamicQuery(params []automationParam, values map[string]string) string {
	query := url.Values{}
	for _, param := range params {
		if value, ok := values[param.Name]; ok {
			query.Set(param.Name, value)
		}
	}
	return query.Encode()
}

// confirmExplicit gates an explicit operator action without a command
// tree: an explicit yes proceeds, otherwise a TTY prompts on stderr and
// anything else refuses rather than guessing.
func confirmExplicit(action string, yes bool, stdin io.Reader, stderr io.Writer) error {
	if yes {
		return nil
	}
	if file, ok := stdin.(*os.File); ok {
		// Pipes, closed streams, and anything unreadable are not a TTY:
		// scripts pass --yes instead of answering a prompt nobody reads.
		if stat, err := file.Stat(); err != nil || stat.Mode()&os.ModeCharDevice == 0 {
			return fmt.Errorf("refusing to %s without --yes on non-interactive input", action)
		}
	}
	fmt.Fprintf(stderr, "%s Proceed? [y/N]: ", action)
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
