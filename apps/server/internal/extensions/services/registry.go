// Package services is the source of truth for external Tilecast service
// capabilities: the versioned operations a Package API v3 guest may call
// through tilecast.call_v1. The registry owns stable IDs, versions,
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

// Invocation contexts for external service operations. Studio UI calls
// carry the authenticated operator; background jobs run as the system
// and never impersonate a Studio user. System names future
// server-triggered invocations; no producer uses it yet.
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
}

// Capability is one grantable Tilecast service: its identity, display
// metadata, allowed contexts, and member operations.
type Capability struct {
	ID          string
	Version     int
	Name        string
	Description string
	Category    string
	Contexts    []string
	Operations  []Operation
}

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
		ID:          "organization.read",
		Version:     1,
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
}

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
		if _, ok := Find(grant.ID, grant.Version); !ok {
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
		if !ok {
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
