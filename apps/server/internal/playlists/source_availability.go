package playlists

import (
	"fmt"

	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// requireWidgetSourceUsable refuses a Widget whose provider comes from a
// plugin that is not installed. Assignment validation and manifest
// generation share this check, so preserved plugin-owned content can never
// be projected as playable while its plugin is missing. Core providers
// and unknown provider IDs pass through: unknown IDs fail later with the
// existing unsupported-provider error.
func (s *Service) requireWidgetSourceUsable(installed map[string]bool, name, provider string) error {
	definition, ok := s.definitions.Widget(provider)
	if !ok {
		return nil
	}
	usable, reason := definition.Source.Usable(installed)
	if usable {
		return nil
	}
	plugin := definition.Source.Normalized().PluginID
	if definition, known := plugins.Lookup(plugin); known {
		return fmt.Errorf("Widget %q uses provider %q from plugin %q, which is not installed", name, provider, definition.Name)
	}
	return fmt.Errorf("Widget %q uses provider %q: %s", name, provider, reason)
}

// requireDataSourceSourceUsable refuses a Data Source whose provider comes
// from a plugin that is not installed. It shares the widget rule's shape:
// assignment validation and manifest generation both apply it, so a
// preserved plugin-owned row can never be projected as a valid live
// source while its plugin is missing. Core providers and unknown provider
// IDs pass through.
func (s *Service) requireDataSourceSourceUsable(installed map[string]bool, name, provider string) error {
	definition, ok := s.definitions.DataSource(provider)
	if !ok {
		return nil
	}
	usable, reason := definition.Source.Usable(installed)
	if usable {
		return nil
	}
	plugin := definition.Source.Normalized().PluginID
	if definition, known := plugins.Lookup(plugin); known {
		return fmt.Errorf("Data Source %q uses provider %q from plugin %q, which is not installed", name, provider, definition.Name)
	}
	return fmt.Errorf("Data Source %q uses provider %q: %s", name, provider, reason)
}
