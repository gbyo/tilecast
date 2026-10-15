package plugin

import "fmt"

// validate applies every structural and cross-field rule of a v2 Player
// contribution. It mirrors the Zod schema and playerContributionProblems in
// packages/plugin-sdk/src/manifest.ts; the shared fixtures keep them equal.
func (p *PlayerEntry) validate() error {
	if p == nil {
		return nil
	}
	if len(p.State) == 0 || len(p.State) > 16 {
		return fmt.Errorf("player.state needs 1-16 declarations")
	}
	if p.Runtime == nil && len(p.Native) == 0 {
		return fmt.Errorf("a player contribution needs a runtime entrypoint or a native contribution")
	}
	states := map[string]bool{}
	for _, state := range p.State {
		if !IDPattern.MatchString(state.Type) {
			return fmt.Errorf("invalid player state type %q", state.Type)
		}
		if ReservedPlayerEntryTypes[state.Type] {
			return fmt.Errorf("state type %s is reserved", state.Type)
		}
		if state.Version < 1 || state.Version > 1000 {
			return fmt.Errorf("player state %s has an invalid version", state.Type)
		}
		key := fmt.Sprintf("%s@%d", state.Type, state.Version)
		if states[key] {
			return fmt.Errorf("state %s is declared twice", key)
		}
		states[key] = true
	}
	if p.Runtime != nil {
		if p.Runtime.Entrypoint != RuntimeEntrypoint {
			return fmt.Errorf("player.runtime.entrypoint must be %s", RuntimeEntrypoint)
		}
		names, err := p.Runtime.Services.validate("runtime", ServiceRuntime)
		if err != nil {
			return err
		}
		if len(p.Runtime.Surfaces) > 8 {
			return fmt.Errorf("runtime: at most 8 surfaces")
		}
		if len(p.Runtime.Surfaces) > 0 && !names["player.surface"] {
			return fmt.Errorf("runtime: surfaces are declared without requesting player.surface")
		}
		if names["player.surface"] && len(p.Runtime.Surfaces) == 0 {
			return fmt.Errorf("runtime: player.surface is requested without declaring surfaces")
		}
		ids := map[string]bool{}
		for _, surface := range p.Runtime.Surfaces {
			if !ContributionPattern.MatchString(surface.ID) {
				return fmt.Errorf("runtime: invalid surface id %q", surface.ID)
			}
			if ids[surface.ID] {
				return fmt.Errorf("runtime: surface %s is declared twice", surface.ID)
			}
			ids[surface.ID] = true
			if len(surface.Slots) == 0 || len(surface.Slots) > len(surfaceSlots) {
				return fmt.Errorf("runtime: surface %s needs 1-%d slots", surface.ID, len(surfaceSlots))
			}
			slots := map[string]bool{}
			for _, slot := range surface.Slots {
				if !surfaceSlots[slot] {
					return fmt.Errorf("runtime: unknown surface slot %q", slot)
				}
				if slots[slot] {
					return fmt.Errorf("runtime: surface %s repeats a slot", surface.ID)
				}
				slots[slot] = true
			}
			if !surfaceTiers[surface.Tier] {
				return fmt.Errorf("runtime: unknown surface tier %q", surface.Tier)
			}
		}
	}
	if err := p.validateProviders(); err != nil {
		return err
	}
	if err := p.validateEvents(); err != nil {
		return err
	}
	if len(p.Native) > 8 {
		return fmt.Errorf("at most 8 native contributions")
	}
	native := map[string]bool{}
	for _, contribution := range p.Native {
		if !ContributionPattern.MatchString(contribution.ID) {
			return fmt.Errorf("invalid native contribution id %q", contribution.ID)
		}
		if native[contribution.ID] {
			return fmt.Errorf("native contribution %s is declared twice", contribution.ID)
		}
		native[contribution.ID] = true
		if _, err := contribution.Services.validate("native "+contribution.ID, ServiceNative); err != nil {
			return err
		}
	}
	return nil
}

func (s ServiceRequests) validate(where string, execution ServiceExecution) (map[string]bool, error) {
	if len(s.Required) > 16 || len(s.Optional) > 16 {
		return nil, fmt.Errorf("%s: at most 16 required and 16 optional services", where)
	}
	names := map[string]bool{}
	for _, value := range append(append([]string(nil), s.Required...), s.Optional...) {
		reference, ok := ParseServiceReference(value)
		if !ok {
			return nil, fmt.Errorf("%s: %s is not a name@version service reference", where, value)
		}
		if problem := ServiceReferenceProblem(reference, execution); problem != "" {
			return nil, fmt.Errorf("%s: %s", where, problem)
		}
		if names[reference.Name] {
			return nil, fmt.Errorf("%s: %s is requested more than once", where, reference.Name)
		}
		names[reference.Name] = true
	}
	return names, nil
}

// HasSharedRuntime reports whether the v2 Player contribution has portable
// Shared Runtime behavior.
func (p *PlayerEntry) HasSharedRuntime() bool {
	return p != nil && p.Runtime != nil
}

// RequiredServices lists the services the Shared Runtime contribution needs.
func (p *PlayerEntry) RequiredServices() []string {
	if p == nil || p.Runtime == nil {
		return nil
	}
	return append([]string(nil), p.Runtime.Services.Required...)
}

const (
	eventsService  = "player.events"
	provideService = "player.presentation.provide"
)

func (p *PlayerEntry) runtimeRequests(name string) bool {
	if p.Runtime == nil {
		return false
	}
	for _, value := range append(append([]string(nil), p.Runtime.Services.Required...), p.Runtime.Services.Optional...) {
		if reference, ok := ParseServiceReference(value); ok && reference.Name == name {
			return true
		}
	}
	return false
}

func (p *PlayerEntry) validateProviders() error {
	var providers []ProviderContribution
	if p.Runtime != nil {
		providers = p.Runtime.Providers
	}
	if len(providers) > 4 {
		return fmt.Errorf("runtime: at most 4 providers")
	}
	requested := p.runtimeRequests(provideService)
	if len(providers) > 0 && !requested {
		return fmt.Errorf("runtime: providers are declared without requesting player.presentation.provide")
	}
	if requested && len(providers) == 0 {
		return fmt.Errorf("runtime: player.presentation.provide is requested without declaring providers")
	}
	seen := map[string]bool{}
	for _, provider := range providers {
		if !ContributionPattern.MatchString(provider.ID) {
			return fmt.Errorf("runtime: invalid provider id %q", provider.ID)
		}
		if seen[provider.ID] {
			return fmt.Errorf("runtime: provider %s is declared twice", provider.ID)
		}
		seen[provider.ID] = true
	}
	return nil
}

func (p *PlayerEntry) validateEvents() error {
	if len(p.Events) > 16 {
		return fmt.Errorf("player.events needs at most 16 declarations")
	}
	requested := p.runtimeRequests(eventsService)
	if len(p.Events) == 0 {
		if requested {
			return fmt.Errorf("runtime: player.events is requested without declaring events")
		}
		return nil
	}
	if p.Runtime == nil || len(p.Native) == 0 {
		return fmt.Errorf("events connect a native contribution to a Shared Runtime contribution; declare both")
	}
	if !requested {
		return fmt.Errorf("runtime: events are declared without requesting player.events")
	}
	seen := map[string]bool{}
	for _, event := range p.Events {
		if !EventNamePattern.MatchString(event.Name) {
			return fmt.Errorf("invalid event name %q", event.Name)
		}
		if event.Version < 1 || event.Version > 1000 {
			return fmt.Errorf("event %s has an invalid version", event.Name)
		}
		if event.Source != "native" && event.Source != "runtime" {
			return fmt.Errorf("event %s has an unknown source %q", event.Name, event.Source)
		}
		key := fmt.Sprintf("%s@%d", event.Name, event.Version)
		if seen[key] {
			return fmt.Errorf("event %s is declared twice", key)
		}
		seen[key] = true
	}
	return nil
}
