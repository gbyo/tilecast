package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// This file holds `tilecast mcp`: the Tilecast MCP server over stdio,
// built on the official MCP Go SDK. Tools map to operator intent, not to
// HTTP operations: the families are screens, pairing, settings, plugins,
// playlists, schedules, tokens, activity, and one generic family per
// installed plugin. Risk annotations describe; the server authorizes
// every call for the resolved credential.
//
// `tilecast mcp --read-only` registers only the read class. Sensitive
// and higher tools take an explicit confirm argument instead of a TTY
// prompt: there is no terminal on the other end of stdio, so a missing
// or false confirm refuses rather than guessing. Break-glass operations
// never enter MCP.

func newMCPCommand(env *environment) *cobra.Command {
	mcpCommand := &cobra.Command{
		Use:   "mcp",
		Short: "Serve operator tools over MCP stdio",
		Long: `Serve Tilecast operator tools to an MCP client over stdio.

The credential resolves exactly like every other command (flags, then
environment, then the current context). --read-only registers only the
read tool class. Mutating tools in sensitive classes take an explicit
confirm argument; nothing here prompts.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runMCP(cmd, env)
		},
	}
	mcpCommand.Flags().Bool("read-only", false, "Register only the read tool class")
	return mcpCommand
}

func runMCP(cmd *cobra.Command, env *environment) error {
	readOnly, _ := cmd.Flags().GetBool("read-only")
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	// MCP uses the credential provider so a browser-login OAuth pair keeps
	// rotating for the life of the process. OAuth logic lives in the
	// provider, never here. The server still enforces the grant's scopes.
	transport, err := apiclient.New(resolved.ServerURL, resolved.BearerFunc())
	if err != nil {
		return err
	}
	transport = transport.WithAgent("tilecast-mcp")
	ctx, cancel, err := timeoutContext(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	documents, err := fetchAutomation(ctx, transport)
	if err != nil {
		return err
	}
	server := mcp.NewServer("tilecast", Version, nil)
	server.AddTools(buildMCPTools(&mcpBackend{transport: transport}, documents, readOnly)...)
	// Frame traffic stays off stderr: only errors surface there, so MCP
	// clients never mistake logging for protocol.
	if err := server.Run(context.Background(), mcp.NewStdioTransport()); err != nil {
		return fmt.Errorf("mcp server: %w", err)
	}
	return nil
}

// mcpBackend runs tool intent against the transport. Methods take plain
// argument maps and return plain data so both the SDK wiring below and
// unit tests call them directly.
type mcpBackend struct {
	transport *apiclient.Client
}

type mcpParam struct {
	name        string
	description string
	required    bool
	// schemaType is the OpenAPI-derived scalar type (string, integer,
	// number, boolean); empty leaves the value untyped.
	schemaType string
	enum       []any
	// schema carries a full JSON Schema for document bodies, derived
	// from the operation's OpenAPI request body where practical.
	schema *jsonschema.Schema
}

type mcpToolDef struct {
	name        string
	description string
	risk        string
	params      []mcpParam
	run         func(backend *mcpBackend, ctx context.Context, args map[string]any) (any, error)
}

// readClass reports whether the tool registers under --read-only. Only
// the read class qualifies; routine mutations stay out.
func (t mcpToolDef) readClass() bool { return t.risk == "read" }

// needsConfirm reports whether the tool takes an explicit confirm
// argument. Sensitive and higher never run on intent alone.
func (t mcpToolDef) needsConfirm() bool {
	switch t.risk {
	case "sensitive", "high-impact", "security-critical":
		return true
	default:
		return false
	}
}

func strArg(args map[string]any, name string) string {
	value, _ := args[name].(string)
	return value
}

func boolArg(args map[string]any, name string) bool {
	value, _ := args[name].(bool)
	return value
}

func floatArg(args map[string]any, name string) float64 {
	switch value := args[name].(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case int64:
		return float64(value)
	default:
		return 0
	}
}

func objectArg(args map[string]any, name string) map[string]any {
	value, _ := args[name].(map[string]any)
	if value == nil {
		return map[string]any{}
	}
	return value
}

func stringSliceArg(args map[string]any, name string) []string {
	raw, _ := args[name].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(string); ok {
			out = append(out, value)
		}
	}
	return out
}

func requireArgs(args map[string]any, names ...string) error {
	for _, name := range names {
		if strArg(args, name) == "" {
			return fmt.Errorf("tool needs %q", name)
		}
	}
	return nil
}

func decodeData(status int, body []byte, out any) error {
	return apiclient.DecodeBody(status, body, out)
}

func (b *mcpBackend) screenList(ctx context.Context, args map[string]any) (any, error) {
	screens, err := fetchScreens(ctx, b.transport)
	if err != nil {
		return nil, err
	}
	sort.Slice(screens, func(i, j int) bool { return screenName(screens[i]) < screenName(screens[j]) })
	return screens, nil
}

func (b *mcpBackend) screenGet(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "idOrName"); err != nil {
		return nil, err
	}
	return resolveScreen(ctx, b.transport, strArg(args, "idOrName"))
}

func (b *mcpBackend) screenUpdate(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "idOrName"); err != nil {
		return nil, err
	}
	current, err := resolveScreen(ctx, b.transport, strArg(args, "idOrName"))
	if err != nil {
		return nil, err
	}
	body := screenUpdateBody(current, strArg(args, "name"), strArg(args, "locationId"), boolArg(args, "clearLocation"), strArg(args, "roomName"), strArg(args, "roomNumber"), strArg(args, "description"))
	status, payload, err := b.transport.UpdateScreen(ctx, screenID(current), body)
	if err != nil {
		return nil, err
	}
	var updated screenRecord
	if err := decodeData(status, payload, &updated); err != nil {
		return nil, err
	}
	return updated, nil
}

func (b *mcpBackend) screenEnabled(ctx context.Context, args map[string]any, enabled bool) (any, error) {
	if err := requireArgs(args, "idOrName"); err != nil {
		return nil, err
	}
	current, err := resolveScreen(ctx, b.transport, strArg(args, "idOrName"))
	if err != nil {
		return nil, err
	}
	status, payload, err := b.transport.SetScreenEnabled(ctx, screenID(current), enabled)
	if err != nil {
		return nil, err
	}
	if err := decodeData(status, payload, nil); err != nil {
		return nil, err
	}
	return map[string]any{"id": screenID(current), "enabled": enabled}, nil
}

func (b *mcpBackend) screenRevoke(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "idOrName"); err != nil {
		return nil, err
	}
	current, err := resolveScreen(ctx, b.transport, strArg(args, "idOrName"))
	if err != nil {
		return nil, err
	}
	status, payload, err := b.transport.RevokeScreen(ctx, screenID(current), strArg(args, "reason"))
	if err != nil {
		return nil, err
	}
	if err := decodeData(status, payload, nil); err != nil {
		return nil, err
	}
	return map[string]any{"id": screenID(current), "revoked": true}, nil
}

func (b *mcpBackend) pairingList(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.ListPendingPairings(ctx)
	if err != nil {
		return nil, err
	}
	var data struct {
		Items []pairingRecord `json:"items"`
		Total int             `json:"total"`
	}
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data.Items, nil
}

func (b *mcpBackend) pairingResolve(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "code"); err != nil {
		return nil, err
	}
	status, body, err := b.transport.ResolvePairingCode(ctx, strArg(args, "code"))
	if err != nil {
		return nil, err
	}
	var session pairingRecord
	if err := decodeData(status, body, &session); err != nil {
		return nil, err
	}
	return session, nil
}

func (b *mcpBackend) pairingApprove(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "sessionId"); err != nil {
		return nil, err
	}
	replaceCredential := boolArg(args, "replaceExistingCredential")
	replaceHardware := boolArg(args, "replaceHardware")
	if replaceHardware && replaceCredential {
		return nil, fmt.Errorf("replaceHardware and replaceExistingCredential cannot both be true")
	}
	if !replaceHardware && strings.TrimSpace(strArg(args, "name")) == "" {
		return nil, fmt.Errorf("tool needs name unless replaceHardware is true")
	}
	if replaceHardware && strArg(args, "replacementScreenId") == "" {
		return nil, fmt.Errorf("replaceHardware needs replacementScreenId")
	}
	body := map[string]any{
		"name": strArg(args, "name"), "roomName": strArg(args, "roomName"), "roomNumber": strArg(args, "roomNumber"), "description": strArg(args, "description"),
		"replaceExistingCredential": replaceCredential,
		"replaceHardware":           replaceHardware,
	}
	if location := strArg(args, "locationId"); location != "" {
		body["locationId"] = location
	} else {
		body["locationId"] = nil
	}
	if replacement := strArg(args, "replacementScreenId"); replacement != "" {
		body["replacementScreenId"] = replacement
	} else {
		body["replacementScreenId"] = nil
	}
	status, payload, err := b.transport.ApprovePairing(ctx, strArg(args, "sessionId"), body)
	if err != nil {
		return nil, err
	}
	var screen screenRecord
	if err := decodeData(status, payload, &screen); err != nil {
		return nil, err
	}
	return screen, nil
}

func (b *mcpBackend) pairingReject(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "sessionId"); err != nil {
		return nil, err
	}
	status, payload, err := b.transport.RejectPairing(ctx, strArg(args, "sessionId"), strArg(args, "reason"))
	if err != nil {
		return nil, err
	}
	if err := decodeData(status, payload, nil); err != nil {
		return nil, err
	}
	return map[string]any{"id": strArg(args, "sessionId"), "rejected": true}, nil
}

func (b *mcpBackend) settingsGet(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	var document settingsDocument
	if err := decodeData(status, body, &document); err != nil {
		return nil, err
	}
	return document, nil
}

func (b *mcpBackend) settingsEffective(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "idOrName"); err != nil {
		return nil, err
	}
	record, err := resolveScreen(ctx, b.transport, strArg(args, "idOrName"))
	if err != nil {
		return nil, err
	}
	status, body, err := b.transport.GetEffectivePolicy(ctx, screenID(record))
	if err != nil {
		return nil, err
	}
	var policy any
	if err := decodeData(status, body, &policy); err != nil {
		return nil, err
	}
	return policy, nil
}

func (b *mcpBackend) settingsSet(ctx context.Context, args map[string]any) (any, error) {
	values := objectArg(args, "values")
	if len(values) == 0 {
		return nil, fmt.Errorf("tool needs a non-empty values object")
	}
	status, body, err := b.transport.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	var document settingsDocument
	if err := decodeData(status, body, &document); err != nil {
		return nil, err
	}
	merged := map[string]any{}
	for key, value := range document.Values {
		merged[key] = value
	}
	for key, value := range values {
		merged[key] = value
	}
	status, body, err = b.transport.UpdateSettings(ctx, document.Revision, merged)
	if err != nil {
		return nil, err
	}
	var updated settingsDocument
	if err := decodeData(status, body, &updated); err != nil {
		return nil, err
	}
	return updated, nil
}

func (b *mcpBackend) pluginList(ctx context.Context, args map[string]any) (any, error) {
	_, items, err := fetchCatalog(ctx, b.transport)
	if err != nil {
		return nil, err
	}
	return items, nil
}

func (b *mcpBackend) pluginGet(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "id"); err != nil {
		return nil, err
	}
	_, items, err := fetchCatalog(ctx, b.transport)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if pluginID(item) == strArg(args, "id") {
			return item, nil
		}
	}
	return nil, fmt.Errorf("unknown plugin %q", strArg(args, "id"))
}

func (b *mcpBackend) pluginInstall(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "id"); err != nil {
		return nil, err
	}
	status, body, err := b.transport.InstallPlugin(ctx, strArg(args, "id"))
	if err != nil {
		return nil, err
	}
	var item pluginRecord
	if err := decodeData(status, body, &item); err != nil {
		return nil, err
	}
	return item, nil
}

func (b *mcpBackend) pluginRemove(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "id"); err != nil {
		return nil, err
	}
	status, body, err := b.transport.RemovePlugin(ctx, strArg(args, "id"))
	if err != nil {
		return nil, err
	}
	if err := decodeData(status, body, nil); err != nil {
		return nil, err
	}
	return map[string]any{"removed": strArg(args, "id")}, nil
}

func (b *mcpBackend) playlistList(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.ListPlaylists(ctx, strArg(args, "search"), int(floatArg(args, "page")), int(floatArg(args, "pageSize")))
	if err != nil {
		return nil, err
	}
	var data struct {
		Items []playlistRecord `json:"items"`
		Total int              `json:"total"`
	}
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data.Items, nil
}

func (b *mcpBackend) playlistGet(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "id"); err != nil {
		return nil, err
	}
	return fetchPlaylist(ctx, b.transport, strArg(args, "id"))
}

func (b *mcpBackend) playlistPublish(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "id"); err != nil {
		return nil, err
	}
	id := strArg(args, "id")
	revision := int64(floatArg(args, "expectedRevision"))
	if revision <= 0 {
		draft, err := fetchPlaylist(ctx, b.transport, id)
		if err != nil {
			return nil, err
		}
		if unpublished, _ := draft["hasUnpublishedChanges"].(bool); !unpublished {
			return map[string]any{"published": false, "reason": "no unpublished changes"}, nil
		}
		rawRevision, _ := draft["draftRevision"].(float64)
		revision = int64(rawRevision)
		if revision <= 0 {
			return nil, fmt.Errorf("the server did not report a draft revision; pass expectedRevision explicitly")
		}
	}
	status, body, err := b.transport.PublishPlaylist(ctx, id, int(revision))
	if err != nil {
		return nil, err
	}
	if status == http.StatusAccepted {
		var submission any
		if err := decodeData(status, body, &submission); err != nil {
			return nil, err
		}
		return map[string]any{"published": false, "submission": submission}, nil
	}
	var result any
	if err := decodeData(status, body, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (b *mcpBackend) scheduleList(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.ListSchedules(ctx, strArg(args, "search"), int(floatArg(args, "page")), int(floatArg(args, "pageSize")))
	if err != nil {
		return nil, err
	}
	var data struct {
		Items []scheduleRecord `json:"items"`
		Total int              `json:"total"`
	}
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data.Items, nil
}

func (b *mcpBackend) scheduleGet(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "id"); err != nil {
		return nil, err
	}
	status, body, err := b.transport.GetSchedule(ctx, strArg(args, "id"))
	if err != nil {
		return nil, err
	}
	var record scheduleRecord
	if err := decodeData(status, body, &record); err != nil {
		return nil, err
	}
	return record, nil
}

func (b *mcpBackend) scheduleCreate(ctx context.Context, args map[string]any) (any, error) {
	document, err := json.Marshal(objectArg(args, "document"))
	if err != nil {
		return nil, err
	}
	if string(document) == "{}" {
		return nil, fmt.Errorf("tool needs a schedule document")
	}
	status, body, err := b.transport.CreateSchedule(ctx, document)
	if err != nil {
		return nil, err
	}
	var record scheduleRecord
	if err := decodeData(status, body, &record); err != nil {
		return nil, err
	}
	return record, nil
}

func (b *mcpBackend) tokenList(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.ListPATs(ctx, strArg(args, "search"))
	if err != nil {
		return nil, err
	}
	var data struct {
		PATs []patRecord `json:"pats"`
	}
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data.PATs, nil
}

func (b *mcpBackend) tokenCreate(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "name"); err != nil {
		return nil, err
	}
	scopes := stringSliceArg(args, "scopes")
	if len(scopes) == 0 {
		return nil, fmt.Errorf("tool needs at least one scope")
	}
	expires := int(floatArg(args, "expiresInDays"))
	if expires == 0 {
		expires = 30
	}
	status, body, err := b.transport.CreatePAT(ctx, strArg(args, "name"), scopes, expires)
	if err != nil {
		return nil, err
	}
	var result struct {
		Token string    `json:"token"`
		PAT   patRecord `json:"pat"`
	}
	if err := decodeData(status, body, &result); err != nil {
		return nil, err
	}
	if result.Token == "" {
		return nil, fmt.Errorf("the server did not return a token secret")
	}
	return result, nil
}

func (b *mcpBackend) activityOverview(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.ActivityOverview(ctx, strArg(args, "from"), strArg(args, "to"))
	if err != nil {
		return nil, err
	}
	var data any
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func (b *mcpBackend) activityUptime(ctx context.Context, args map[string]any) (any, error) {
	window := strArg(args, "window")
	if window == "" {
		window = "24h"
	}
	status, body, err := b.transport.ActivityUptime(ctx, window)
	if err != nil {
		return nil, err
	}
	var data any
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func (b *mcpBackend) activityIncidents(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.ListIncidents(ctx, strArg(args, "status"), strArg(args, "severity"), strArg(args, "type"))
	if err != nil {
		return nil, err
	}
	var data struct {
		Items []incidentRecord `json:"items"`
	}
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data.Items, nil
}

func (b *mcpBackend) activityIncidentGet(ctx context.Context, args map[string]any) (any, error) {
	if err := requireArgs(args, "id"); err != nil {
		return nil, err
	}
	status, body, err := b.transport.GetIncident(ctx, strArg(args, "id"))
	if err != nil {
		return nil, err
	}
	var record incidentRecord
	if err := decodeData(status, body, &record); err != nil {
		return nil, err
	}
	return record, nil
}

func (b *mcpBackend) activityCompliance(ctx context.Context, args map[string]any) (any, error) {
	status, body, err := b.transport.PlaybackCompliance(ctx, strArg(args, "from"), strArg(args, "to"))
	if err != nil {
		return nil, err
	}
	var data any
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data, nil
}

// pluginOp dispatches one resolved automation operation for an installed
// plugin: the generic per-plugin tool family. Only files the server
// reported contribute tools, so uninstalled plugins never appear.
func (b *mcpBackend) pluginOp(ctx context.Context, operation automationOp, args map[string]any) (any, error) {
	method, err := automationMethod(operation.Method)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(operation.Path, "/api/v1/plugins/") {
		return nil, fmt.Errorf("operation %q maps outside plugin paths", operation.OperationID)
	}
	path, err := mcpFillPath(operation.Path, args)
	if err != nil {
		return nil, err
	}
	if query := mcpQuery(operation.QueryParams, args); query != "" {
		path += "?" + query
	}
	var reader io.Reader
	if method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch {
		raw, ok := args["document"]
		if !ok {
			return nil, fmt.Errorf("operation %q needs a document argument", operation.OperationID)
		}
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	status, body, err := b.transport.Call(ctx, method, path, reader)
	if err != nil {
		return nil, err
	}
	var data any
	if err := decodeData(status, body, &data); err != nil {
		return nil, err
	}
	return data, nil
}

// mcpFillPath substitutes {params} from tool arguments in path order,
// like the generic CLI fills them from positional arguments. Each value
// becomes exactly one path segment through path-segment escaping, so
// reserved characters cannot alter the route.
func mcpFillPath(template string, args map[string]any) (string, error) {
	path := template
	for _, segment := range strings.Split(template, "/") {
		if !strings.HasPrefix(segment, "{") || !strings.HasSuffix(segment, "}") {
			continue
		}
		name := strings.Trim(segment, "{}")
		value := mcpScalar(args[name])
		if value == "" {
			return "", fmt.Errorf("tool needs %q", name)
		}
		path = strings.Replace(path, "{"+name+"}", url.PathEscape(value), 1)
	}
	return path, nil
}

// mcpScalar renders one tool argument as its path/query string form.
// Strings pass through; booleans and numbers use their JSON spelling so
// typed MCP inputs still address the same resource.
func mcpScalar(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	default:
		return ""
	}
}

func idOrNameParam() mcpParam {
	return mcpParam{name: "idOrName", description: "Screen UUID or unique name", required: true}
}

// coreMCPTools is the hand-designed semantic tool set. Names carry the
// family; descriptions carry the risk class. The server authorizes every
// call, so these annotations describe intent for the model, nothing more.
func coreMCPTools() []mcpToolDef {
	return []mcpToolDef{
		{name: "screen_list", description: "List the screens visible to the credential", risk: "read",
			run: (*mcpBackend).screenList},
		{name: "screen_get", description: "Show one screen by UUID or unique name", risk: "read",
			params: []mcpParam{idOrNameParam()}, run: (*mcpBackend).screenGet},
		{name: "screen_update", description: "Update a screen's details; unset fields keep current values", risk: "sensitive",
			params: []mcpParam{idOrNameParam(),
				{name: "name", description: "Screen name"},
				{name: "locationId", description: "Location UUID"},
				{name: "clearLocation", description: "Remove the location assignment"},
				{name: "roomName", description: "Room name"},
				{name: "roomNumber", description: "Room number"},
				{name: "description", description: "Screen description"},
			}, run: (*mcpBackend).screenUpdate},
		{name: "screen_disable", description: "Disable a screen (status override)", risk: "sensitive",
			params: []mcpParam{idOrNameParam()},
			run: func(backend *mcpBackend, ctx context.Context, args map[string]any) (any, error) {
				return backend.screenEnabled(ctx, args, false)
			}},
		{name: "screen_enable", description: "Enable a screen", risk: "sensitive",
			params: []mcpParam{idOrNameParam()},
			run: func(backend *mcpBackend, ctx context.Context, args map[string]any) (any, error) {
				return backend.screenEnabled(ctx, args, true)
			}},
		{name: "screen_revoke", description: "Permanently revoke a screen's device credential", risk: "sensitive",
			params: []mcpParam{idOrNameParam(), {name: "reason", description: "Why the credential is revoked"}},
			run:    (*mcpBackend).screenRevoke},
		{name: "pairing_list", description: "List pending pairing sessions", risk: "read",
			run: (*mcpBackend).pairingList},
		{name: "pairing_resolve", description: "Resolve a visible six-character pairing code into its session", risk: "read",
			params: []mcpParam{{name: "code", description: "Visible pairing code", required: true}},
			run:    (*mcpBackend).pairingResolve},
		{name: "pairing_approve", description: "Approve a pairing session and name its screen", risk: "sensitive",
			params: []mcpParam{
				{name: "sessionId", description: "Pairing session UUID", required: true},
				{name: "name", description: "Screen name (required unless replaceHardware is true)"},
				{name: "roomName", description: "Optional room name"},
				{name: "roomNumber", description: "Optional room number"},
				{name: "description", description: "Optional screen description"},
				{name: "locationId", description: "Location UUID"},
				{name: "replaceExistingCredential", description: "Authorize credential rotation after enrollment"},
				{name: "replaceHardware", description: "Assign the player to an existing screen"},
				{name: "replacementScreenId", description: "Existing screen UUID for hardware replacement"},
			}, run: (*mcpBackend).pairingApprove},
		{name: "pairing_reject", description: "Reject a pairing session", risk: "sensitive",
			params: []mcpParam{
				{name: "sessionId", description: "Pairing session UUID", required: true},
				{name: "reason", description: "Why the pairing is rejected"},
			}, run: (*mcpBackend).pairingReject},
		{name: "settings_get", description: "Read the organization settings document", risk: "read",
			run: (*mcpBackend).settingsGet},
		{name: "settings_effective", description: "Read the effective player policy for a screen", risk: "read",
			params: []mcpParam{idOrNameParam()}, run: (*mcpBackend).settingsEffective},
		{name: "settings_set", description: "Change organization settings; only the given keys change", risk: "routine",
			params: []mcpParam{{name: "values", description: "Settings keys and values to change", required: true}},
			run:    (*mcpBackend).settingsSet},
		{name: "plugin_list", description: "List the plugins this release offers with installation state", risk: "read",
			run: (*mcpBackend).pluginList},
		{name: "plugin_get", description: "Show one plugin catalog entry", risk: "read",
			params: []mcpParam{{name: "id", description: "Plugin ID", required: true}},
			run:    (*mcpBackend).pluginGet},
		{name: "plugin_install", description: "Record a release-owned plugin as installed (idempotent)", risk: "routine",
			params: []mcpParam{{name: "id", description: "Plugin ID", required: true}},
			run:    (*mcpBackend).pluginInstall},
		{name: "plugin_remove", description: "Delete a plugin installation record (plugin data is kept)", risk: "routine",
			params: []mcpParam{{name: "id", description: "Plugin ID", required: true}},
			run:    (*mcpBackend).pluginRemove},
		{name: "playlist_list", description: "List playlists", risk: "read",
			params: []mcpParam{
				{name: "search", description: "Filter by name"},
				{name: "page", description: "Page number (starts at 1)"},
				{name: "pageSize", description: "Page size"},
			}, run: (*mcpBackend).playlistList},
		{name: "playlist_get", description: "Show one playlist draft", risk: "read",
			params: []mcpParam{{name: "id", description: "Playlist UUID", required: true}},
			run:    (*mcpBackend).playlistGet},
		{name: "playlist_publish", description: "Publish the current draft (reads it first; conflicts are errors)", risk: "sensitive",
			params: []mcpParam{
				{name: "id", description: "Playlist UUID", required: true},
				{name: "expectedRevision", description: "Publish this draft revision instead of the one read now"},
			}, run: (*mcpBackend).playlistPublish},
		{name: "schedule_list", description: "List schedules", risk: "read",
			params: []mcpParam{
				{name: "search", description: "Filter by name"},
				{name: "page", description: "Page number (starts at 1)"},
				{name: "pageSize", description: "Page size"},
			}, run: (*mcpBackend).scheduleList},
		{name: "schedule_get", description: "Show one schedule", risk: "read",
			params: []mcpParam{{name: "id", description: "Schedule UUID", required: true}},
			run:    (*mcpBackend).scheduleGet},
		{name: "schedule_create", description: "Create a schedule from a full JSON document", risk: "routine",
			params: []mcpParam{{name: "document", description: "Schedule document", required: true}},
			run:    (*mcpBackend).scheduleCreate},
		{name: "token_list", description: "List personal access tokens (secrets never shown)", risk: "read",
			params: []mcpParam{{name: "search", description: "Filter by name"}},
			run:    (*mcpBackend).tokenList},
		{name: "token_create", description: "Mint a personal access token; the secret shows exactly once in the result", risk: "security-critical",
			params: []mcpParam{
				{name: "name", description: "Token name", required: true},
				{name: "scopes", description: "Grant scopes: read, write, admin", required: true},
				{name: "expiresInDays", description: "Lifetime in days: 7, 30, 90, or 365"},
			}, run: (*mcpBackend).tokenCreate},
		{name: "activity_overview", description: "Show the fleet activity overview for a window", risk: "read",
			params: []mcpParam{
				{name: "from", description: "Window start (RFC 3339)"},
				{name: "to", description: "Window end (RFC 3339)"},
			}, run: (*mcpBackend).activityOverview},
		{name: "activity_uptime", description: "Show the fleet uptime report", risk: "read",
			params: []mcpParam{{name: "window", description: "Report window: 24h, 7d, or 30d"}},
			run:    (*mcpBackend).activityUptime},
		{name: "activity_incidents", description: "List incidents (active by default)", risk: "read",
			params: []mcpParam{
				{name: "status", description: "open, acknowledged, recovered, resolved, ignored, or all"},
				{name: "severity", description: "info, warning, error, or critical"},
				{name: "type", description: "Incident type"},
			}, run: (*mcpBackend).activityIncidents},
		{name: "activity_incident_get", description: "Show one incident with its timeline", risk: "read",
			params: []mcpParam{{name: "id", description: "Incident UUID", required: true}},
			run:    (*mcpBackend).activityIncidentGet},
		{name: "activity_compliance", description: "Show expected-versus-actual playback compliance", risk: "read",
			params: []mcpParam{
				{name: "from", description: "Window start (RFC 3339)"},
				{name: "to", description: "Window end (RFC 3339)"},
			}, run: (*mcpBackend).activityCompliance},
	}
}

// pluginMCPTools builds the generic per-plugin tool families for
// installed plugins only. Tool names prefix the plugin ID, so families
// never collide; excluded operations never appear because the resolved
// document omits them. Path and query parameters carry their
// OpenAPI-derived types, and request bodies use the operation's schema
// where the server supplied one.
func pluginMCPTools(documents []automationDoc) []mcpToolDef {
	tools := []mcpToolDef{}
	for _, document := range documents {
		for _, operation := range document.Operations {
			operation := operation
			types := map[string]automationParam{}
			for _, param := range operation.PathParams {
				types[param.Name] = param
			}
			params := []mcpParam{}
			for _, segment := range strings.Split(operation.Path, "/") {
				if !strings.HasPrefix(segment, "{") || !strings.HasSuffix(segment, "}") {
					continue
				}
				name := strings.Trim(segment, "{}")
				meta := types[name]
				params = append(params, mcpParam{
					name:        name,
					description: paramDescription(meta.Description, "Path value for "+name),
					required:    true,
					schemaType:  meta.Type,
					enum:        meta.Enum,
				})
			}
			for _, param := range operation.QueryParams {
				params = append(params, mcpParam{
					name:        param.Name,
					description: paramDescription(param.Description, "Query value for "+param.Name),
					required:    param.Required,
					schemaType:  param.Type,
					enum:        param.Enum,
				})
			}
			if operation.Method == "post" || operation.Method == "put" || operation.Method == "patch" {
				document := mcpParam{name: "document", description: "JSON request body", required: true}
				if operation.RequestBody != nil {
					document.schema = mcpSchemaFromGeneric(operation.RequestBody.Schema)
					if document.schema != nil {
						document.description = "JSON request body for " + operation.OperationID
					}
				}
				params = append(params, document)
			}
			description := operation.Description
			if description == "" {
				description = operation.OperationID
			}
			tools = append(tools, mcpToolDef{
				name:        document.Plugin + "_" + operation.MCPAction,
				description: description,
				risk:        operation.Risk,
				params:      params,
				run: func(backend *mcpBackend, ctx context.Context, args map[string]any) (any, error) {
					return backend.pluginOp(ctx, operation, args)
				},
			})
		}
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].name < tools[j].name })
	return tools
}

// paramDescription prefers the OpenAPI text and falls back to the generic
// label when the operation carries none.
func paramDescription(described, fallback string) string {
	if described != "" {
		return described
	}
	return fallback
}

// mcpQuery encodes the tool arguments declared as query parameters.
// Only metadata-declared names travel; anything else is the caller's own
// document content, never a query string.
func mcpQuery(params []automationParam, args map[string]any) string {
	query := url.Values{}
	for _, param := range params {
		raw, ok := args[param.Name]
		if !ok || raw == nil {
			continue
		}
		if str, isStr := raw.(string); isStr && str == "" {
			continue
		}
		query.Set(param.Name, mcpScalar(raw))
	}
	return query.Encode()
}

// mcpSchemaFromGeneric converts one pluginctl-derived JSON Schema map
// into an MCP input schema. Only the scalar/object/array shapes
// generation emits are mapped; anything else yields nil so the document
// parameter stays a free-form JSON value instead of a broken schema.
func mcpSchemaFromGeneric(schema map[string]any) *jsonschema.Schema {
	out, ok := mcpSchemaValue(schema)
	if !ok {
		return nil
	}
	return out
}

func mcpSchemaValue(node map[string]any) (*jsonschema.Schema, bool) {
	converted := &jsonschema.Schema{}
	if raw, ok := node["type"].(string); ok {
		switch raw {
		case "string", "integer", "number", "boolean", "object", "array", "null":
			converted.Type = raw
		default:
			return nil, false
		}
	}
	if raw, ok := node["description"].(string); ok {
		converted.Description = raw
	}
	if raw, ok := node["format"].(string); ok {
		converted.Format = raw
	}
	if raw, ok := node["pattern"].(string); ok {
		converted.Pattern = raw
	}
	if raw, ok := node["default"]; ok {
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, false
		}
		converted.Default = encoded
	}
	for key, assign := range map[string]func(float64){
		"minimum": func(value float64) { converted.Minimum = &value },
		"maximum": func(value float64) { converted.Maximum = &value },
	} {
		if raw, ok := mcpNumber(node[key]); ok {
			assign(raw)
		}
	}
	for key, assign := range map[string]func(int){
		"minLength": func(value int) { converted.MinLength = &value },
		"maxLength": func(value int) { converted.MaxLength = &value },
		"minItems":  func(value int) { converted.MinItems = &value },
		"maxItems":  func(value int) { converted.MaxItems = &value },
	} {
		if raw, ok := mcpInteger(node[key]); ok {
			assign(raw)
		}
	}
	if raw, ok := node["uniqueItems"].(bool); ok && raw {
		converted.UniqueItems = true
	}
	if raw, ok := node["enum"].([]any); ok {
		converted.Enum = append([]any(nil), raw...)
	}
	if raw, ok := node["required"].([]any); ok {
		for _, item := range raw {
			name, ok := item.(string)
			if !ok {
				return nil, false
			}
			converted.Required = append(converted.Required, name)
		}
	}
	if raw, ok := node["properties"].(map[string]any); ok {
		converted.Properties = map[string]*jsonschema.Schema{}
		for name, prop := range raw {
			child, ok := prop.(map[string]any)
			if !ok {
				return nil, false
			}
			schema, ok := mcpSchemaValue(child)
			if !ok {
				return nil, false
			}
			converted.Properties[name] = schema
		}
	}
	if raw, ok := node["items"].(map[string]any); ok {
		schema, ok := mcpSchemaValue(raw)
		if !ok {
			return nil, false
		}
		converted.Items = schema
	}
	if raw, ok := node["additionalProperties"]; ok {
		switch typed := raw.(type) {
		case bool:
			if !typed {
				converted.AdditionalProperties = &jsonschema.Schema{Not: &jsonschema.Schema{}}
			}
		case map[string]any:
			schema, ok := mcpSchemaValue(typed)
			if !ok {
				return nil, false
			}
			converted.AdditionalProperties = schema
		default:
			return nil, false
		}
	}
	return converted, true
}

func mcpNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	default:
		return 0, false
	}
}

func mcpInteger(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int(typed)) {
			return 0, false
		}
		return int(typed), true
	case int:
		return typed, true
	default:
		return 0, false
	}
}

// buildMCPTools converts definitions to SDK tools, enforcing required
// arguments and the explicit confirm gate for sensitive classes.
// readOnly drops everything outside the read class.
func buildMCPTools(backend *mcpBackend, documents []automationDoc, readOnly bool) []*mcp.ServerTool {
	defs := append([]mcpToolDef{}, coreMCPTools()...)
	defs = append(defs, pluginMCPTools(documents)...)
	tools := []*mcp.ServerTool{}
	for _, def := range defs {
		def := def
		if readOnly && !def.readClass() {
			continue
		}
		// Tool inputs are dynamic maps, which the SDK cannot infer
		// properties for, so the schema is built directly. Generic plugin
		// parameters carry their OpenAPI-derived types.
		schema := &jsonschema.Schema{Type: "object", Properties: map[string]*jsonschema.Schema{}}
		addParam := func(param mcpParam) {
			property := &jsonschema.Schema{Description: param.description}
			if param.schema != nil {
				property = param.schema
				if property.Description == "" {
					property.Description = param.description
				}
			} else {
				property.Type = param.schemaType
				if len(param.enum) > 0 {
					property.Enum = append([]any(nil), param.enum...)
				}
			}
			schema.Properties[param.name] = property
			if param.required {
				schema.Required = append(schema.Required, param.name)
			}
		}
		for _, param := range def.params {
			addParam(param)
		}
		if def.needsConfirm() {
			addParam(mcpParam{name: "confirm", description: "Pass true to run this " + def.risk + " action", required: true, schemaType: "boolean"})
		}
		description := def.description + " (risk: " + def.risk + ")"
		handler := func(ctx context.Context, _ *mcp.ServerSession, params *mcp.CallToolParamsFor[map[string]any]) (*mcp.CallToolResultFor[struct{}], error) {
			args := params.Arguments
			if args == nil {
				args = map[string]any{}
			}
			for _, param := range def.params {
				if param.required && strArg(args, param.name) == "" && param.name != "document" && param.name != "values" && param.name != "scopes" {
					return nil, fmt.Errorf("tool needs %q", param.name)
				}
			}
			if def.needsConfirm() && !boolArg(args, "confirm") {
				return nil, fmt.Errorf("tool %q is %s: pass confirm=true to run it", def.name, def.risk)
			}
			result, err := def.run(backend, ctx, args)
			if err != nil {
				return nil, err
			}
			raw, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return nil, err
			}
			return &mcp.CallToolResultFor[struct{}]{
				Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}},
			}, nil
		}
		tool := mcp.NewServerTool(def.name, description, handler)
		tool.Tool.InputSchema = schema
		tools = append(tools, tool)
	}
	return tools
}
