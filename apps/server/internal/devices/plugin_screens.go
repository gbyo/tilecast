package devices

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	plugin "github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// PluginScreens projects live screens to the shared non-secret facts the
// bundled Plugin Host and external Tilecast services both serve. A nil
// user lists the whole fleet for system callers; a Studio caller passes
// its account so scoping narrows the list exactly like the dashboard.
// Archived screens never appear. The projection carries facts only:
// no credentials, tokens, or network addresses.
func (s *Service) PluginScreens(ctx context.Context, user *uuid.UUID, role string, query plugin.ScreenListQuery) (plugin.ScreenListResult, error) {
	var screens []Screen
	var err error
	if user == nil {
		screens, err = s.ListScreens(ctx)
	} else {
		screens, err = s.ListScreensForUser(ctx, *user, role)
	}
	if err != nil {
		return plugin.ScreenListResult{}, err
	}
	search := strings.ToLower(strings.TrimSpace(query.Search))
	filtered := make([]Screen, 0, len(screens))
	for _, screen := range screens {
		if search != "" && !strings.Contains(strings.ToLower(screen.Name), search) {
			continue
		}
		filtered = append(filtered, screen)
	}
	page := query.Page
	if page < 1 {
		page = 1
	}
	pageSize := query.PageSize
	if pageSize < 1 || pageSize > 100 {
		pageSize = 50
	}
	start := (page - 1) * pageSize
	if start > len(filtered) {
		start = len(filtered)
	}
	end := start + pageSize
	if end > len(filtered) {
		end = len(filtered)
	}
	window := filtered[start:end]
	ids := make([]uuid.UUID, 0, len(window))
	for _, screen := range window {
		ids = append(ids, screen.ID)
	}
	reported, err := s.reportedCapabilities(ctx, ids)
	if err != nil {
		return plugin.ScreenListResult{}, err
	}
	items := make([]plugin.ScreenFacts, 0, len(window))
	for _, screen := range window {
		items = append(items, screenFacts(screen, reported[screen.ID]))
	}
	return plugin.ScreenListResult{Items: items, Page: page, PageSize: pageSize, Total: len(filtered)}, nil
}

// PluginScreen projects one live screen to shared non-secret facts.
// Unknown and archived screens answer ErrNotFound.
func (s *Service) PluginScreen(ctx context.Context, id uuid.UUID) (plugin.ScreenFacts, error) {
	screen, err := s.GetScreen(ctx, id)
	if err != nil {
		return plugin.ScreenFacts{}, err
	}
	if screen.ArchivedAt != nil {
		return plugin.ScreenFacts{}, ErrNotFound
	}
	reported, err := s.reportedCapabilities(ctx, []uuid.UUID{id})
	if err != nil {
		return plugin.ScreenFacts{}, err
	}
	return screenFacts(screen, reported[id]), nil
}

func screenFacts(screen Screen, capabilities plugin.ScreenCapabilities) plugin.ScreenFacts {
	family := ""
	if screen.PlayerFamily != nil {
		family = *screen.PlayerFamily
	}
	return plugin.ScreenFacts{
		ID:            screen.ID,
		Name:          screen.Name,
		Enabled:       screen.Enabled,
		Status:        string(screen.Status),
		LastContactAt: screen.LastContactAt,
		Platform:      screen.Platform,
		PlayerFamily:  family,
		PlayerVersion: screen.PlayerVersion,
		Capabilities:  capabilities,
	}
}

func (s *Service) reportedCapabilities(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]plugin.ScreenCapabilities, error) {
	reported := make(map[uuid.UUID]plugin.ScreenCapabilities, len(ids))
	if len(ids) == 0 {
		return reported, nil
	}
	rows, err := s.db.Query(ctx, `SELECT screen_id,presentation_schema_versions,native_presentation_capabilities,web_runtime_version,web_bundle_limit_bytes FROM screen_player_status WHERE screen_id=ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("read reported player capabilities: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var capabilities plugin.ScreenCapabilities
		if err := rows.Scan(&id, &capabilities.PresentationSchemaVersions, &capabilities.Native, &capabilities.WebRuntimeVersion, &capabilities.WebBundleLimitBytes); err != nil {
			return nil, fmt.Errorf("read reported player capabilities: %w", err)
		}
		reported[id] = capabilities
	}
	return reported, rows.Err()
}
