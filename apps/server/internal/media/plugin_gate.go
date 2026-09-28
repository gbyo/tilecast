package media

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// PluginSourceGate confirms a plugin-owned contribution may be created.
// The plugins package implements it; content packages hold it as an
// injected boundary so media never imports plugin implementation details
// (plugins imports media, so the reverse import would be a cycle).
type PluginSourceGate interface {
	// LockPluginSource confirms the plugin is installed inside the
	// caller's transaction and holds a share lock on its installation
	// row until commit, so a concurrent plugin removal cannot slip
	// between the availability check and the insert.
	LockPluginSource(ctx context.Context, tx pgx.Tx, pluginID string) error
}

// PluginUnavailableError reports that a plugin-owned provider cannot be
// used because its plugin is not installed. Persisted rows are preserved;
// only new creation (and projection elsewhere) is refused.
type PluginUnavailableError struct {
	Kind     string
	Provider string
	PluginID string
}

func (e *PluginUnavailableError) Error() string {
	return fmt.Sprintf("%s %q requires plugin %q, which is not installed", e.Kind, e.Provider, e.PluginID)
}

// SetPluginSourceGate installs the plugin installation gate used when
// creating plugin-owned content. Nil fails closed: plugin-owned creation
// is refused when no gate is wired.
func (s *Service) SetPluginSourceGate(gate PluginSourceGate) { s.pluginGate = gate }

// lockDataSourceProvider locks the owning plugin's installation row when
// the provider is a plugin-owned Data Source definition. It must run
// inside the creation transaction before the insert.
func (s *Service) lockDataSourceProvider(ctx context.Context, tx pgx.Tx, provider string) error {
	definition, ok := s.definitions.DataSource(provider)
	if !ok {
		return nil
	}
	source := definition.Source.Normalized()
	if source.Kind != contentdefs.SourceKindPlugin {
		return nil
	}
	if s.pluginGate == nil {
		return &PluginUnavailableError{Kind: "data source provider", Provider: provider, PluginID: source.PluginID}
	}
	if err := s.pluginGate.LockPluginSource(ctx, tx, source.PluginID); err != nil {
		return &PluginUnavailableError{Kind: "data source provider", Provider: provider, PluginID: source.PluginID}
	}
	return nil
}

// lockWidgetSource locks the owning plugin's installation row when the
// provider is a plugin-owned Widget definition. It must run inside the
// creation transaction before the insert.
func (s *Service) lockWidgetSource(ctx context.Context, tx pgx.Tx, provider string) error {
	definition, ok := s.definitions.Widget(provider)
	if !ok {
		return nil
	}
	source := definition.Source.Normalized()
	if source.Kind != contentdefs.SourceKindPlugin {
		return nil
	}
	if s.pluginGate == nil {
		return &PluginUnavailableError{Kind: "widget provider", Provider: provider, PluginID: source.PluginID}
	}
	if err := s.pluginGate.LockPluginSource(ctx, tx, source.PluginID); err != nil {
		return &PluginUnavailableError{Kind: "widget provider", Provider: provider, PluginID: source.PluginID}
	}
	return nil
}
