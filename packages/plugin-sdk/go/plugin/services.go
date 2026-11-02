package plugin

import (
	"fmt"
	"regexp"
	"strconv"
)

// ServiceExecution names where a Player plugin service is implemented and so
// which contribution may request it.
type ServiceExecution string

const (
	// ServiceRuntime services are implemented by the Shared Player Runtime.
	ServiceRuntime ServiceExecution = "runtime"
	// ServiceNative services are implemented by platform Player builds.
	ServiceNative ServiceExecution = "native"
)

// PlayerService is one entry of the Player plugin service vocabulary. A
// Player that reports version N implements every version from 1 to N.
type PlayerService struct {
	Name        string           `json:"name"`
	Version     int              `json:"version"`
	Execution   ServiceExecution `json:"execution"`
	Description string           `json:"description"`
	// HostCapability names the Runtime host capability a runtime service
	// needs. The Runtime offers such a service only on a host that sets it.
	HostCapability string `json:"hostCapability,omitempty"`
}

// PlayerPluginHostCapability is the capability a Player reports when it hosts
// Plugin API v2 contributions. It receives plugin_state entries only then.
const (
	PlayerPluginHostCapability = "plugin.host"
	PlayerPluginHostVersion    = 2
)

// PlayerServices mirrors packages/plugin-sdk/player-services.json; a test
// replays the file so the mirror cannot drift.
var PlayerServices = []PlayerService{
	{Name: "player.clock", Version: 1, Execution: ServiceRuntime,
		Description: "Corrected server time, local and monotonic time, and plugin-owned timers."},
	{Name: "player.events", Version: 1, Execution: ServiceRuntime,
		Description:    "Ephemeral typed events between a plugin's native and Shared Runtime parts: declared names, bounded payloads, never state.",
		HostCapability: "pluginEvents"},
	{Name: "player.media", Version: 1, Execution: ServiceRuntime,
		Description: "Addresses for verified media variants that the plugin's current state entries declare."},
	{Name: "player.presentation.observe", Version: 1, Execution: ServiceRuntime,
		Description: "Read-only observation of what owns the screen and which item is shown."},
	{Name: "player.presentation.provide", Version: 1, Execution: ServiceRuntime,
		Description: "Registers a declared presentation provider. The host activates it for an external presentation that names it, and owns its visibility, lifecycle, and fallback."},
	{Name: "player.reference.signal", Version: 1, Execution: ServiceNative,
		Description: "Reference service that qualifies the native service model: one typed read of a counter the platform owns. No product Player provides it."},
	{Name: "player.surface", Version: 1, Execution: ServiceRuntime,
		Description: "Host-owned strip, corner, and overlay containers with claim arbitration and content-stage geometry."},
}

var serviceReferencePattern = regexp.MustCompile(`^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)@([1-9][0-9]{0,5})$`)

// ServiceReference is a parsed name@version service request.
type ServiceReference struct {
	Name    string
	Version int
}

func (r ServiceReference) String() string { return fmt.Sprintf("%s@%d", r.Name, r.Version) }

// ParseServiceReference parses name@version, for example player.clock@1.
func ParseServiceReference(value string) (ServiceReference, bool) {
	match := serviceReferencePattern.FindStringSubmatch(value)
	if match == nil {
		return ServiceReference{}, false
	}
	version, err := strconv.Atoi(match[2])
	if err != nil {
		return ServiceReference{}, false
	}
	return ServiceReference{Name: match[1], Version: version}, true
}

// LookupPlayerService returns a vocabulary entry by name.
func LookupPlayerService(name string) (PlayerService, bool) {
	for _, service := range PlayerServices {
		if service.Name == name {
			return service, true
		}
	}
	return PlayerService{}, false
}

// ServiceReferenceProblem explains why a contribution of the given execution
// kind cannot request the reference, or returns "".
func ServiceReferenceProblem(reference ServiceReference, execution ServiceExecution) string {
	service, ok := LookupPlayerService(reference.Name)
	if !ok {
		return reference.Name + " is not a Player plugin service"
	}
	if reference.Version > service.Version {
		return fmt.Sprintf("%s has no version %d; the newest is %d", reference.Name, reference.Version, service.Version)
	}
	if service.Execution != execution {
		return fmt.Sprintf("%s is a %s service; a %s contribution cannot use it", reference.Name, service.Execution, execution)
	}
	return ""
}

// ServicesAvailable reports whether a Player's reported capabilities (name
// to highest version) satisfy every reference.
func ServicesAvailable(reported map[string]int, references []string) bool {
	for _, value := range references {
		reference, ok := ParseServiceReference(value)
		if !ok || reported[reference.Name] < reference.Version {
			return false
		}
	}
	return true
}
