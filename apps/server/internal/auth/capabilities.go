package auth

import (
	"sort"
	"strings"
)

// Capability is one unit of management authority. The vocabulary is closed:
// it is defined here, in code, and nothing read from the database or a
// request can add to it. A role is a named bundle of capabilities, and every
// management authorization decision asks whether the principal holds one.
//
// The set is deliberately coarse. Each capability names a kind of work an
// operator would recognize ("upload media", "publish playlists"), not an
// endpoint. Resource scope (which screens, which folders) is a separate
// dimension: a capability says what someone may do, a scope narrows where.
type Capability string

const (
	CapMediaRead              Capability = "media.read"
	CapMediaUpload            Capability = "media.upload"
	CapMediaEdit              Capability = "media.edit"
	CapMediaOrganize          Capability = "media.organize"
	CapMediaArchive           Capability = "media.archive"
	CapMediaDelete            Capability = "media.delete"
	CapMediaTagsAssign        Capability = "media.tags.assign"
	CapMediaTagsManage        Capability = "media.tags.manage"
	CapMediaFoldersManage     Capability = "media.folders.manage"
	CapMediaCollectionsManage Capability = "media.collections.manage"

	CapWidgetRead   Capability = "widget.read"
	CapWidgetEdit   Capability = "widget.edit"
	CapWidgetDelete Capability = "widget.delete"

	CapDataSourceRead   Capability = "datasource.read"
	CapDataSourceEdit   Capability = "datasource.edit"
	CapDataSourceManage Capability = "datasource.manage"

	CapPlaylistRead    Capability = "playlist.read"
	CapPlaylistEdit    Capability = "playlist.edit"
	CapPlaylistPublish Capability = "playlist.publish"
	CapPlaylistDelete  Capability = "playlist.delete"

	CapLayoutRead    Capability = "layout.read"
	CapLayoutEdit    Capability = "layout.edit"
	CapLayoutPublish Capability = "layout.publish"
	CapLayoutDelete  Capability = "layout.delete"

	CapCampaignRead    Capability = "campaign.read"
	CapCampaignEdit    Capability = "campaign.edit"
	CapCampaignPublish Capability = "campaign.publish"

	CapContentReview Capability = "content.review"

	CapScreenRead   Capability = "screen.read"
	CapScreenManage Capability = "screen.manage"
	CapScreenPair   Capability = "screen.pair"
	CapScreenAssign Capability = "screen.assign"

	CapScheduleRead Capability = "schedule.read"
	CapScheduleEdit Capability = "schedule.edit"

	CapActivityRead   Capability = "activity.read"
	CapActivityAudit  Capability = "activity.audit"
	CapActivityManage Capability = "activity.manage"

	CapPluginsUse    Capability = "plugins.use"
	CapPluginsManage Capability = "plugins.manage"

	CapUsersManage    Capability = "users.manage"
	CapRolesManage    Capability = "roles.manage"
	CapSettingsManage Capability = "settings.manage"
	CapSystemManage   Capability = "system.manage"

	// Owner-reserved. These are whole-installation authority: a backup holds
	// every password hash and TOTP secret, an integration token is a standing
	// credential, and a Player release reaches every screen. Only the
	// built-in Owner role holds them; a custom role can never include them.
	CapSystemBackups      Capability = "system.backups"
	CapIntegrationsManage Capability = "integrations.manage"
	CapPlayerReleases     Capability = "player.releases"
)

// CapabilityGroup names the Studio area a capability belongs to. It is
// presentation metadata for the role editor and never affects a decision.
type CapabilityGroup string

const (
	GroupMedia          CapabilityGroup = "media"
	GroupWidgets        CapabilityGroup = "widgets"
	GroupDataSources    CapabilityGroup = "dataSources"
	GroupPlaylists      CapabilityGroup = "playlists"
	GroupLayouts        CapabilityGroup = "layouts"
	GroupCampaigns      CapabilityGroup = "campaigns"
	GroupReview         CapabilityGroup = "review"
	GroupScreens        CapabilityGroup = "screens"
	GroupSchedules      CapabilityGroup = "schedules"
	GroupActivity       CapabilityGroup = "activity"
	GroupPlugins        CapabilityGroup = "plugins"
	GroupAdministration CapabilityGroup = "administration"
)

// CapabilityDefinition describes one vocabulary entry.
type CapabilityDefinition struct {
	Key   Capability      `json:"key"`
	Group CapabilityGroup `json:"group"`
	// Requires lists capabilities that must accompany this one. Upload is
	// meaningless without seeing the library, for example. A custom role that
	// omits a requirement is rejected rather than silently completed.
	Requires []Capability `json:"requires"`
	// OwnerReserved capabilities are held only by the built-in Owner role.
	OwnerReserved bool `json:"ownerReserved"`
	// Delegable is false for capabilities that administer access itself.
	// Only the Owner may put them in a custom role, which keeps the existing
	// rule that only an Owner can create someone with Administrator reach.
	Delegable bool `json:"delegable"`
}

func capability(key Capability, group CapabilityGroup, requires ...Capability) CapabilityDefinition {
	if requires == nil {
		requires = []Capability{}
	}
	return CapabilityDefinition{Key: key, Group: group, Requires: requires, Delegable: true}
}

func reserved(key Capability, group CapabilityGroup) CapabilityDefinition {
	return CapabilityDefinition{Key: key, Group: group, Requires: []Capability{}, OwnerReserved: true}
}

func accessAdministration(key Capability) CapabilityDefinition {
	return CapabilityDefinition{Key: key, Group: GroupAdministration, Requires: []Capability{}}
}

// capabilityCatalog is the closed vocabulary, in the order Studio presents it.
var capabilityCatalog = []CapabilityDefinition{
	capability(CapMediaRead, GroupMedia),
	capability(CapMediaUpload, GroupMedia, CapMediaRead),
	capability(CapMediaEdit, GroupMedia, CapMediaRead),
	capability(CapMediaOrganize, GroupMedia, CapMediaRead),
	capability(CapMediaTagsAssign, GroupMedia, CapMediaRead),
	capability(CapMediaArchive, GroupMedia, CapMediaRead),
	capability(CapMediaDelete, GroupMedia, CapMediaRead),
	capability(CapMediaFoldersManage, GroupMedia, CapMediaRead),
	capability(CapMediaTagsManage, GroupMedia, CapMediaRead),
	capability(CapMediaCollectionsManage, GroupMedia, CapMediaRead),

	capability(CapWidgetRead, GroupWidgets),
	capability(CapWidgetEdit, GroupWidgets, CapWidgetRead),
	capability(CapWidgetDelete, GroupWidgets, CapWidgetRead),

	capability(CapDataSourceRead, GroupDataSources),
	capability(CapDataSourceEdit, GroupDataSources, CapDataSourceRead),
	capability(CapDataSourceManage, GroupDataSources, CapDataSourceRead),

	capability(CapPlaylistRead, GroupPlaylists),
	capability(CapPlaylistEdit, GroupPlaylists, CapPlaylistRead),
	capability(CapPlaylistPublish, GroupPlaylists, CapPlaylistRead),
	capability(CapPlaylistDelete, GroupPlaylists, CapPlaylistRead),

	capability(CapLayoutRead, GroupLayouts),
	capability(CapLayoutEdit, GroupLayouts, CapLayoutRead),
	capability(CapLayoutPublish, GroupLayouts, CapLayoutRead),
	capability(CapLayoutDelete, GroupLayouts, CapLayoutRead),

	capability(CapCampaignRead, GroupCampaigns),
	capability(CapCampaignEdit, GroupCampaigns, CapCampaignRead),
	capability(CapCampaignPublish, GroupCampaigns, CapCampaignRead),

	capability(CapContentReview, GroupReview),

	capability(CapScreenRead, GroupScreens),
	capability(CapScreenManage, GroupScreens, CapScreenRead),
	capability(CapScreenPair, GroupScreens, CapScreenRead),
	capability(CapScreenAssign, GroupScreens, CapScreenRead),

	capability(CapScheduleRead, GroupSchedules),
	capability(CapScheduleEdit, GroupSchedules, CapScheduleRead),

	capability(CapActivityRead, GroupActivity),
	capability(CapActivityAudit, GroupActivity, CapActivityRead),
	capability(CapActivityManage, GroupActivity, CapActivityRead, CapActivityAudit),

	capability(CapPluginsUse, GroupPlugins),
	capability(CapPluginsManage, GroupPlugins, CapPluginsUse),

	accessAdministration(CapUsersManage),
	accessAdministration(CapRolesManage),
	capability(CapSettingsManage, GroupAdministration),
	capability(CapSystemManage, GroupAdministration),
	reserved(CapSystemBackups, GroupAdministration),
	reserved(CapIntegrationsManage, GroupAdministration),
	reserved(CapPlayerReleases, GroupAdministration),
}

var capabilityIndex = func() map[Capability]CapabilityDefinition {
	index := make(map[Capability]CapabilityDefinition, len(capabilityCatalog))
	for _, definition := range capabilityCatalog {
		index[definition.Key] = definition
	}
	return index
}()

// CapabilityCatalog returns the closed vocabulary in presentation order.
func CapabilityCatalog() []CapabilityDefinition {
	out := make([]CapabilityDefinition, len(capabilityCatalog))
	copy(out, capabilityCatalog)
	return out
}

// LookupCapability reports whether key names a vocabulary entry.
func LookupCapability(key string) (CapabilityDefinition, bool) {
	definition, ok := capabilityIndex[Capability(key)]
	return definition, ok
}

// CapabilitySet is an immutable-by-convention set of capabilities.
type CapabilitySet map[Capability]struct{}

// NewCapabilitySet builds a set, keeping only vocabulary entries. Unknown
// strings are dropped: a stale or tampered database value can never become
// authority.
func NewCapabilitySet(values ...Capability) CapabilitySet {
	set := make(CapabilitySet, len(values))
	for _, value := range values {
		if _, ok := capabilityIndex[value]; ok {
			set[value] = struct{}{}
		}
	}
	return set
}

// Has reports whether the set holds capability.
func (s CapabilitySet) Has(capability Capability) bool {
	_, ok := s[capability]
	return ok
}

// Can is Has under the name authorization interfaces use, so a bare set can
// stand in for a principal (a background job acting as the Owner, a test).
func (s CapabilitySet) Can(capability Capability) bool {
	return s.Has(capability)
}

// HasAny reports whether the set holds at least one of capabilities.
func (s CapabilitySet) HasAny(capabilities ...Capability) bool {
	for _, capability := range capabilities {
		if s.Has(capability) {
			return true
		}
	}
	return false
}

// Contains reports whether every capability in other is in s.
func (s CapabilitySet) Contains(other CapabilitySet) bool {
	for capability := range other {
		if !s.Has(capability) {
			return false
		}
	}
	return true
}

// Sorted returns the set as a sorted list, for stable JSON and audit output.
func (s CapabilitySet) Sorted() []Capability {
	out := make([]Capability, 0, len(s))
	for capability := range s {
		out = append(out, capability)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Strings returns the sorted set as plain strings.
func (s CapabilitySet) Strings() []string {
	sorted := s.Sorted()
	out := make([]string, len(sorted))
	for i, capability := range sorted {
		out[i] = string(capability)
	}
	return out
}

// MissingRequirements lists requirements of members that the set lacks, as
// "capability needs requirement" pairs in sorted order.
func (s CapabilitySet) MissingRequirements() []string {
	missing := []string{}
	for _, capability := range s.Sorted() {
		for _, requirement := range capabilityIndex[capability].Requires {
			if !s.Has(requirement) {
				missing = append(missing, string(capability)+" needs "+string(requirement))
			}
		}
	}
	return missing
}

// Built-in role keys. They are protected: their capability sets live in code,
// not in the database, so an upgrade changes them predictably and nobody can
// edit them out from under the rest of the installation.
const (
	RoleOwner         = "owner"
	RoleAdministrator = "administrator"
	RoleEditor        = "editor"
	RoleContributor   = "contributor"
	RoleViewer        = "viewer"
)

// BuiltinRoleKeys lists the protected roles from most to least authority.
var BuiltinRoleKeys = []string{RoleOwner, RoleAdministrator, RoleEditor, RoleContributor, RoleViewer}

// CustomRolePrefix starts every custom role key, so a future built-in role
// can never collide with a key an installation already uses.
const CustomRolePrefix = "custom."

var (
	viewerCapabilities = []Capability{
		CapMediaRead, CapWidgetRead, CapDataSourceRead, CapPlaylistRead, CapLayoutRead,
		CapCampaignRead, CapScreenRead, CapScheduleRead, CapActivityRead, CapPluginsUse,
	}
	contributorCapabilities = append(append([]Capability{}, viewerCapabilities...),
		CapMediaUpload, CapMediaEdit, CapMediaOrganize, CapMediaTagsAssign, CapMediaTagsManage,
		CapMediaFoldersManage, CapMediaCollectionsManage,
		CapWidgetEdit, CapDataSourceEdit, CapPlaylistEdit, CapLayoutEdit,
	)
	editorCapabilities = append(append([]Capability{}, contributorCapabilities...),
		CapMediaArchive, CapMediaDelete, CapWidgetDelete, CapDataSourceManage,
		CapPlaylistPublish, CapPlaylistDelete, CapLayoutPublish, CapLayoutDelete,
		CapCampaignEdit, CapContentReview, CapActivityAudit,
	)
)

var builtinRoles = func() map[string]CapabilitySet {
	administrator := CapabilitySet{}
	owner := CapabilitySet{}
	for _, definition := range capabilityCatalog {
		owner[definition.Key] = struct{}{}
		if !definition.OwnerReserved {
			administrator[definition.Key] = struct{}{}
		}
	}
	return map[string]CapabilitySet{
		RoleOwner:         owner,
		RoleAdministrator: administrator,
		RoleEditor:        NewCapabilitySet(editorCapabilities...),
		RoleContributor:   NewCapabilitySet(contributorCapabilities...),
		RoleViewer:        NewCapabilitySet(viewerCapabilities...),
	}
}()

// IsBuiltinRole reports whether key names a protected built-in role.
func IsBuiltinRole(key string) bool {
	_, ok := builtinRoles[key]
	return ok
}

// IsCustomRoleKey reports whether key has the custom role shape.
func IsCustomRoleKey(key string) bool {
	return strings.HasPrefix(key, CustomRolePrefix) && len(key) > len(CustomRolePrefix)
}

// BuiltinCapabilities returns a copy of a built-in role's set, and false for
// any other key.
func BuiltinCapabilities(role string) (CapabilitySet, bool) {
	set, ok := builtinRoles[role]
	if !ok {
		return nil, false
	}
	out := make(CapabilitySet, len(set))
	for capability := range set {
		out[capability] = struct{}{}
	}
	return out, true
}
