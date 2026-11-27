// Package services is the one Server service vocabulary: the versioned
// operations a Package API v3 guest calls through tilecast.call_v1, and that
// a bundled Plugin Manifest API 3 plugin calls through the generated Go
// client in the plugin SDK (services_registry_gen.go). The registry owns stable IDs, versions,
// English display metadata, risk categories, allowed invocation
// contexts, and operation membership. Manifest validation checks grant
// shape; installation and review check grants against this registry; the
// Wasm transport checks every invocation against the active manifest's
// grants, the operation, and the context.
package services

import (
	"errors"
	"fmt"
	"sort"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// ErrUnknownService answers a service grant the registry does not know.
var ErrUnknownService = errors.New("unknown service capability")

// Invocation contexts for service operations. Studio calls carry the
// authenticated operator; background jobs run as the system and never
// impersonate a Studio user. System calls are server-triggered work with no
// operator: a bundled plugin's Player projection in this release, and
// events, webhooks, and Player reports in later releases.
const (
	ContextStudio     = "studio"
	ContextBackground = "background"
	ContextSystem     = "system"
)

// Display/risk categories for Studio permission rendering. They group
// grants by consequence, not by implementation detail.
const (
	CategoryRead      = "read"
	CategoryDirectory = "directory"
	CategoryManage    = "manage"
	CategoryAudit     = "audit"
)

// Operation is one fixed, versioned service call. Names are tokens, never
// routes: capability@version/method.
type Operation struct {
	Name              string
	CapabilityID      string
	CapabilityVersion int
	Title             string
	Description       string
	Mutating          bool
	Contexts          []string
	// Limits bounds the encoded input and the encoded answer of one call.
	// Zero members use the default transport bounds. An operation asks for
	// more only when its domain needs it, and only bundled-only operations
	// do in this release, so the package call window does not change.
	Limits TransportLimits
}

// TransportLimits are the wire bounds of one call: the JSON input, and the
// JSON envelope or data of the answer. They are not domain limits. A domain
// limit, such as the raw size of an HTTP body, is checked by the operation;
// the transport limit only has room for the bounded JSON representation of
// it, base64 included.
type TransportLimits struct {
	MaxInputBytes  int
	MaxOutputBytes int
}

// MaxTransportBytes is the largest transport bound any operation may ask
// for. It is above the largest Phase 2 answer: a 16 MiB HTTP body in base64
// with its metadata.
const MaxTransportBytes = 24 << 20

// LimitsOf returns an operation's transport bounds with the defaults
// applied.
func LimitsOf(operation Operation) TransportLimits {
	limits := operation.Limits
	if limits.MaxInputBytes <= 0 {
		limits.MaxInputBytes = MaxInputBytes
	}
	if limits.MaxOutputBytes <= 0 {
		limits.MaxOutputBytes = MaxOutputBytes
	}
	return limits
}

// OperationLimits returns the transport bounds of an operation token, or
// the defaults for a token the registry does not know. The Wasm host uses
// it to bound a read before the dispatcher resolves the call.
func OperationLimits(name string) TransportLimits {
	operation, _, ok := LookupOperation(name)
	if !ok {
		return TransportLimits{MaxInputBytes: MaxInputBytes, MaxOutputBytes: MaxOutputBytes}
	}
	return LimitsOf(operation)
}

// base64Size is the length of standard base64 for n bytes.
func base64Size(n int) int { return (n + 2) / 3 * 4 }

// Callers of a capability. A package calls through tilecast.call_v1 and
// holds an install-time grant; a bundled API 3 plugin calls through the
// generated Go client and declares the service in its manifest.
const (
	CallerPackage = "package"
	CallerBundled = "bundled"
)

// Capability is one grantable Tilecast service: its identity, display
// metadata, allowed contexts, callers, and member operations.
type Capability struct {
	ID          string
	Version     int
	Name        string
	Description string
	Category    string
	Contexts    []string
	// Callers lists who may call the capability. Empty means packages only,
	// the meaning every capability had before bundled callers existed.
	Callers    []string
	Operations []Operation
}

// AllowsCaller reports whether a caller kind may call the capability.
func (c Capability) AllowsCaller(caller string) bool {
	if len(c.Callers) == 0 {
		return caller == CallerPackage
	}
	for _, allowed := range c.Callers {
		if allowed == caller {
			return true
		}
	}
	return false
}

var bothCallers = []string{CallerPackage, CallerBundled}

// Detail is the registry-resolved display metadata Studio renders for one
// requested grant. The review payload carries it so Studio never decodes
// raw capability tokens itself.
type Detail struct {
	ID          string            `json:"id"`
	Version     int               `json:"version"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Category    string            `json:"category"`
	Operations  []OperationDetail `json:"operations"`
}

// OperationDetail is the review rendering of one registry operation.
type OperationDetail struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Mutating    bool   `json:"mutating"`
}

var capabilities = []Capability{
	{
		ID: "targets.resolve", Version: 2, Name: "Resolve display targets", Description: "Select screens, groups, locations, or explicit all screens through a scoped target picker.", Category: CategoryRead, Contexts: []string{ContextStudio, ContextBackground}, Callers: bothCallers,
		Operations: []Operation{
			{Name: "targets.resolve@2/resolve", CapabilityID: "targets.resolve", CapabilityVersion: 2, Title: "Resolve targets", Description: "Validate explicit all or a nonempty screen, group, and location selection.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "targets.resolve@2/options", CapabilityID: "targets.resolve", CapabilityVersion: 2, Title: "List target options", Description: "List bounded target names and identifiers within the operator's scope.", Contexts: []string{ContextStudio}},
		},
	},
	{
		ID: "plugin-runtime.state", Version: 1, Name: "External Player plugin state", Description: "Configure and publish bounded expiring state for this package's own external Player plugins.", Category: CategoryManage, Contexts: []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "plugin-runtime.state@1/get", CapabilityID: "plugin-runtime.state", CapabilityVersion: 1, Title: "Read plugin state", Description: "Read this package's own plugin configuration and last published state.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "plugin-runtime.state@1/configure", CapabilityID: "plugin-runtime.state", CapabilityVersion: 1, Title: "Configure plugin targets", Description: "Save operator-authored configuration and targets with a revision check.", Mutating: true, Contexts: []string{ContextStudio}},
			{Name: "plugin-runtime.state@1/publish", CapabilityID: "plugin-runtime.state", CapabilityVersion: 1, Title: "Publish Player state", Description: "Publish bounded expiring state to the configured targets without replacing playback.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "plugin-runtime.state@1/clear", CapabilityID: "plugin-runtime.state", CapabilityVersion: 1, Title: "Clear Player state", Description: "Remove this plugin's current Player state while keeping configuration.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "organization.read",
		Version:     1,
		Callers:     bothCallers,
		Name:        "Organization details",
		Description: "Read the organization's name and identifier.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "organization.read@1/get", CapabilityID: "organization.read", CapabilityVersion: 1, Title: "Read organization", Description: "Read the organization's name and identifier.", Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "instance.read",
		Version:     1,
		Callers:     bothCallers,
		Name:        "Installation details",
		Description: "Read installation facts such as the public address and release version.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "instance.read@1/get", CapabilityID: "instance.read", CapabilityVersion: 1, Title: "Read installation", Description: "Read installation facts such as the public address and release version.", Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "screens.read",
		Version:     1,
		Callers:     bothCallers,
		Name:        "Screen directory",
		Description: "List screens and read non-secret screen facts and reported player capabilities.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "screens.read@1/list", CapabilityID: "screens.read", CapabilityVersion: 1, Title: "List screens", Description: "List screens with non-secret facts and reported player capabilities.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "screens.read@1/get", CapabilityID: "screens.read", CapabilityVersion: 1, Title: "Read screen", Description: "Read one screen's non-secret facts and reported player capabilities.", Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "targets.resolve",
		Version:     1,
		Callers:     bothCallers,
		Name:        "Resolve display targets",
		Description: "Validate screen and group selections and resolve them to screens.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "targets.resolve@1/resolve", CapabilityID: "targets.resolve", CapabilityVersion: 1, Title: "Resolve targets", Description: "Validate screen and group selections and resolve them to screens.", Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "content.read",
		Version:     1,
		Name:        "Content library",
		Description: "Read playlists, layouts, data sources, schedules, and screen groups.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "content.read@1/playlists.list", CapabilityID: "content.read", CapabilityVersion: 1, Title: "List playlists", Description: "List playlists with bounded pagination.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/playlists.get", CapabilityID: "content.read", CapabilityVersion: 1, Title: "Read playlist", Description: "Read one playlist and its items.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/layouts.list", CapabilityID: "content.read", CapabilityVersion: 1, Title: "List layouts", Description: "List layouts with bounded pagination.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/layouts.get", CapabilityID: "content.read", CapabilityVersion: 1, Title: "Read layout", Description: "Read one layout.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/datasources.list", CapabilityID: "content.read", CapabilityVersion: 1, Title: "List data sources", Description: "List data sources with bounded pagination.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/datasources.get", CapabilityID: "content.read", CapabilityVersion: 1, Title: "Read data source", Description: "Read one data source without credentials.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/schedules.list", CapabilityID: "content.read", CapabilityVersion: 1, Title: "List schedules", Description: "List schedules with bounded pagination.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/schedules.get", CapabilityID: "content.read", CapabilityVersion: 1, Title: "Read schedule", Description: "Read one schedule.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/groups.list", CapabilityID: "content.read", CapabilityVersion: 1, Title: "List screen groups", Description: "List screen groups with bounded pagination.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "content.read@1/groups.get", CapabilityID: "content.read", CapabilityVersion: 1, Title: "Read screen group", Description: "Read one screen group and its members.", Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "managed-presentations.manage",
		Version:     1,
		Name:        "Managed presentations",
		Description: "Create and refresh this package's own managed data source, widget, and playlist.",
		Category:    CategoryManage,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "managed-presentations.manage@1/ensure", CapabilityID: "managed-presentations.manage", CapabilityVersion: 1, Title: "Ensure managed presentation", Description: "Create or reuse this package's managed data source, widget, and playlist.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "managed-presentations.manage@1/update-data", CapabilityID: "managed-presentations.manage", CapabilityVersion: 1, Title: "Refresh managed data", Description: "Refresh this package's managed data source payload.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "managed-presentations.manage@1/get", CapabilityID: "managed-presentations.manage", CapabilityVersion: 1, Title: "Read managed presentation", Description: "Read this package's managed presentation identifiers.", Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "takeovers.manage",
		Version:     1,
		Name:        "Emergency takeovers",
		Description: "Start and cancel takeovers using the canonical takeover rules.",
		Category:    CategoryManage,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "takeovers.manage@1/activate", CapabilityID: "takeovers.manage", CapabilityVersion: 1, Title: "Start takeover", Description: "Start a takeover with canonical validation, duration, and target rules.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "takeovers.manage@1/cancel", CapabilityID: "takeovers.manage", CapabilityVersion: 1, Title: "Cancel takeover", Description: "Cancel an active takeover.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "users.read-basic",
		Version:     1,
		Callers:     bothCallers,
		Name:        "User directory",
		Description: "Read basic user directory facts for attribution and workflows.",
		Category:    CategoryDirectory,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "users.read-basic@1/get", CapabilityID: "users.read-basic", CapabilityVersion: 1, Title: "Read user", Description: "Read one user's basic directory facts.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "users.read-basic@1/search", CapabilityID: "users.read-basic", CapabilityVersion: 1, Title: "Search users", Description: "Search active users by name or username.", Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "users.read-basic@1/list-by-role", CapabilityID: "users.read-basic", CapabilityVersion: 1, Title: "List users by role", Description: "List users holding one role.", Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "audit.write",
		Version:     1,
		Name:        "Audit events",
		Description: "Write bounded package audit events with correct attribution.",
		Category:    CategoryAudit,
		Contexts:    []string{ContextStudio, ContextBackground},
		Operations: []Operation{
			{Name: "audit.write@1/write", CapabilityID: "audit.write", CapabilityVersion: 1, Title: "Write audit event", Description: "Write one bounded package audit event.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		ID:          "players.display-control",
		Version:     1,
		Name:        "Player display control",
		Description: "Request display operations on screens that report the matching Player capability.",
		Category:    CategoryManage,
		Contexts:    []string{ContextStudio, ContextBackground},
		// One method per Player Capability operation. The method names,
		// titles, and descriptions mirror playercaps.Operations(); the
		// drift test pins them to the canonical registry file.
		Operations: []Operation{
			{Name: "players.display-control@1/display.power", CapabilityID: "players.display-control", CapabilityVersion: 1, Title: "Set display power", Description: "Turn the attached display on or off through the reporting provider.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "players.display-control@1/display.input", CapabilityID: "players.display-control", CapabilityVersion: 1, Title: "Set display input", Description: "Select the active input on the attached display.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "players.display-control@1/display.volume", CapabilityID: "players.display-control", CapabilityVersion: 1, Title: "Set display volume", Description: "Set the attached display volume from 0 to 100.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "players.display-control@1/display.mute", CapabilityID: "players.display-control", CapabilityVersion: 1, Title: "Set display mute", Description: "Mute or unmute the attached display.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
			{Name: "players.display-control@1/display.brightness", CapabilityID: "players.display-control", CapabilityVersion: 1, Title: "Set display brightness", Description: "Set the attached display brightness from 0 to 100.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground}},
		},
	},
	{
		// Bundled only in this release: a package has no host-owned settings
		// until Plugin Model V3 gives packages instance parity.
		ID:          "settings.read",
		Version:     1,
		Name:        "Plugin settings",
		Description: "Read this plugin's own non-secret settings for the organization or one screen.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "settings.read@1/get", CapabilityID: "settings.read", CapabilityVersion: 1, Title: "Read settings", Description: "Read this plugin's non-secret settings and whether each secret is set.", Contexts: []string{ContextStudio, ContextBackground, ContextSystem}},
		},
	},
	{
		// A secret value never reaches Studio. Plugin code reads one in a
		// route (studio), background, or system context; Studio itself only
		// writes secrets and reads whether each is set.
		ID:          "secrets.read",
		Version:     1,
		Name:        "Plugin secrets",
		Description: "Read one of this plugin's own secrets.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "secrets.read@1/get", CapabilityID: "secrets.read", CapabilityVersion: 1, Title: "Read secret", Description: "Read one of this plugin's secrets. An unset or unreadable secret answers secret_unavailable.", Contexts: []string{ContextStudio, ContextBackground, ContextSystem}},
		},
	},
	{
		// Bundled only until installed-plugin parity (ADR phase 6). The old
		// package http_fetch import keeps its own contract.
		ID:          "http.fetch",
		Version:     1,
		Name:        "Outbound HTTP",
		Description: "Send HTTP requests through this plugin's own host connections.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "http.fetch@1/request", CapabilityID: "http.fetch", CapabilityVersion: 1, Title: "Send request", Description: "Send one request through a connection of this plugin. The host checks the origin and the addresses, adds secret headers, and bounds the body and the time.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground, ContextSystem},
				Limits: TransportLimits{MaxInputBytes: HTTPFetchMaxInputBytes, MaxOutputBytes: HTTPFetchMaxOutputBytes}},
		},
	},
	{
		// Bundled only. The package KV imports keep their own contract and
		// share the bounds through internal/extensions/kvstore.
		ID:          "storage.kv",
		Version:     1,
		Name:        "Plugin key/value storage",
		Description: "Keep small values of this plugin: 128-byte keys, 64 KiB values, 1 MiB in all.",
		Category:    CategoryManage,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "storage.kv@1/get", CapabilityID: "storage.kv", CapabilityVersion: 1, Title: "Read value", Description: "Read one value of this plugin. A missing key answers not_found.", Contexts: []string{ContextStudio, ContextBackground, ContextSystem},
				Limits: TransportLimits{MaxOutputBytes: KVMaxValueTransportBytes}},
			{Name: "storage.kv@1/set", CapabilityID: "storage.kv", CapabilityVersion: 1, Title: "Write value", Description: "Store one value of this plugin within the key, value, and quota bounds.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground, ContextSystem},
				Limits: TransportLimits{MaxInputBytes: KVMaxValueTransportBytes}},
			{Name: "storage.kv@1/compareAndSet", CapabilityID: "storage.kv", CapabilityVersion: 1, Title: "Compare and write value", Description: "Store one value only when the current value equals the expected value; a null expected value means the key must not exist.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground, ContextSystem},
				Limits: TransportLimits{MaxInputBytes: KVMaxCompareTransportBytes}},
			{Name: "storage.kv@1/delete", CapabilityID: "storage.kv", CapabilityVersion: 1, Title: "Delete value", Description: "Delete one value of this plugin.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground, ContextSystem}},
		},
	},
	{
		ID:          "timers.schedule",
		Version:     1,
		Name:        "Durable timers",
		Description: "Schedule a callback of this plugin at a time, with a key and a payload of at most 4 KiB.",
		Category:    CategoryManage,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "timers.schedule@1/schedule", CapabilityID: "timers.schedule", CapabilityVersion: 1, Title: "Schedule timer", Description: "Schedule one callback at a time. Scheduling a key again replaces its pending timer.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground, ContextSystem}},
		},
	},
	{
		ID:          "timers.cancel",
		Version:     1,
		Name:        "Cancel durable timers",
		Description: "Cancel a pending callback of this plugin.",
		Category:    CategoryManage,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "timers.cancel@1/cancel", CapabilityID: "timers.cancel", CapabilityVersion: 1, Title: "Cancel timer", Description: "Remove the pending timer of a key.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground, ContextSystem}},
		},
	},
	{
		// Bundled only. A feed is a dataset the plugin publishes; the host
		// projects it as the Data Source provider <plugin>.<feed>.
		ID:          "feeds.publish",
		Version:     1,
		Name:        "Feed publication",
		Description: "Publish the complete record set of one of this plugin's feed datasets.",
		Category:    CategoryManage,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "feeds.publish@1/publish", CapabilityID: "feeds.publish", CapabilityVersion: 1, Title: "Publish feed", Description: "Replace the records of one dataset. The publication names the revision it replaces; a concurrent publication fails with a conflict.", Mutating: true, Contexts: []string{ContextStudio, ContextBackground, ContextSystem},
				Limits: TransportLimits{MaxInputBytes: FeedPublishMaxInputBytes}},
			{Name: "feeds.publish@1/revision", CapabilityID: "feeds.publish", CapabilityVersion: 1, Title: "Read feed revision", Description: "Read the current revision of one dataset, the one the next publication replaces.", Contexts: []string{ContextStudio, ContextBackground, ContextSystem}},
		},
	},
	{
		// Bundled only. A timer callback or another hook without an
		// instance in hand reads one of the plugin's own instances.
		ID:          "instances.read",
		Version:     1,
		Name:        "Own instances",
		Description: "Read one of this plugin's own instances: name, enabled state, revision, and configuration, never a secret.",
		Category:    CategoryRead,
		Contexts:    []string{ContextStudio, ContextBackground, ContextSystem},
		Callers:     []string{CallerBundled},
		Operations: []Operation{
			{Name: "instances.read@1/get", CapabilityID: "instances.read", CapabilityVersion: 1, Title: "Read instance", Description: "Read one instance of this plugin by kind and ID. A missing instance answers not_found.", Contexts: []string{ContextStudio, ContextBackground, ContextSystem},
				Limits: TransportLimits{MaxOutputBytes: 160 << 10}},
			{Name: "instances.read@1/list", CapabilityID: "instances.read", CapabilityVersion: 1, Title: "List instances", Description: "List the IDs, names, and enabled state of this plugin's instances of one kind.", Contexts: []string{ContextStudio, ContextBackground, ContextSystem},
				Limits: TransportLimits{MaxOutputBytes: 160 << 10}},
		},
	},
}

// feeds.publish@1 transport bound: a publication is at most 512 KiB of
// canonical JSON; the request JSON around it, whitespace and escapes
// included, gets 128 KiB more.
const FeedPublishMaxInputBytes = 512<<10 + 128<<10

// storage.kv@1 transport bounds. A value is bytes, so JSON carries it in
// base64: a 64 KiB value is 87,384 bytes, and the key and the JSON need
// a little more. compareAndSet carries two values.
const (
	kvEnvelopeRoom             = 4 << 10
	KVMaxValueTransportBytes   = (64<<10+2)/3*4 + kvEnvelopeRoom
	KVMaxCompareTransportBytes = 2*((64<<10+2)/3*4) + kvEnvelopeRoom
)

// http.fetch@1 transport bounds. The input holds a body of at most 1 MiB in
// base64, the URL, and at most 16 KiB of headers. The answer holds a body of
// at most 16 MiB in base64 and bounded response headers.
const (
	httpFetchEnvelopeRoom   = 64 << 10
	HTTPFetchMaxInputBytes  = (1<<20+2)/3*4 + httpFetchEnvelopeRoom
	HTTPFetchMaxOutputBytes = (16<<20+2)/3*4 + httpFetchEnvelopeRoom
)

// All returns the registry in stable ID order.
func All() []Capability {
	out := make([]Capability, 0, len(capabilities))
	out = append(out, capabilities...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].ID == out[j].ID {
			return out[i].Version < out[j].Version
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Find returns the capability for one grant, or false when the registry
// knows no such identity and version.
func Find(id string, version int) (Capability, bool) {
	for _, capability := range capabilities {
		if capability.ID == id && capability.Version == version {
			return capability, true
		}
	}
	return Capability{}, false
}

// LookupOperation returns one fixed operation token and its capability,
// or false when the token is unknown.
func LookupOperation(name string) (Operation, Capability, bool) {
	for _, capability := range capabilities {
		for _, operation := range capability.Operations {
			if operation.Name == name {
				return operation, capability, true
			}
		}
	}
	return Operation{}, Capability{}, false
}

// AllowsContext reports whether a context may invoke an operation.
func AllowsContext(operation Operation, context string) bool {
	for _, allowed := range operation.Contexts {
		if allowed == context {
			return true
		}
	}
	return false
}

// Granted reports whether grants include the exact operation capability.
func Granted(grants []packagemanifest.ServiceGrant, operation Operation) bool {
	for _, grant := range grants {
		if grant.ID == operation.CapabilityID && grant.Version == operation.CapabilityVersion {
			return true
		}
	}
	return false
}

// ValidateGrants rejects unknown service identities and versions. Shape,
// bounds, and uniqueness already validated in the manifest.
func ValidateGrants(grants []packagemanifest.ServiceGrant) error {
	for _, grant := range grants {
		if capability, ok := Find(grant.ID, grant.Version); !ok || !capability.AllowsCaller(CallerPackage) {
			return fmt.Errorf("%w: %s@%d", ErrUnknownService, grant.ID, grant.Version)
		}
	}
	return nil
}

// Details resolves grants to registry display metadata in grant order.
// Unknown grants are a caller bug: installation and review validate
// first, so resolution fails closed rather than rendering a raw token.
func Details(grants []packagemanifest.ServiceGrant) ([]Detail, error) {
	details := make([]Detail, 0, len(grants))
	for _, grant := range grants {
		capability, ok := Find(grant.ID, grant.Version)
		if !ok || !capability.AllowsCaller(CallerPackage) {
			return nil, fmt.Errorf("%w: %s@%d", ErrUnknownService, grant.ID, grant.Version)
		}
		detail := Detail{
			ID:          capability.ID,
			Version:     capability.Version,
			Name:        capability.Name,
			Description: capability.Description,
			Category:    capability.Category,
			Operations:  make([]OperationDetail, 0, len(capability.Operations)),
		}
		for _, operation := range capability.Operations {
			detail.Operations = append(detail.Operations, OperationDetail{
				Name:        operation.Name,
				Title:       operation.Title,
				Description: operation.Description,
				Mutating:    operation.Mutating,
			})
		}
		details = append(details, detail)
	}
	return details, nil
}
