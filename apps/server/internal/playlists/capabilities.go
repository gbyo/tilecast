package playlists

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

type presentationWidgetRequirement struct {
	AssetID       uuid.UUID
	Name          string
	Provider      string
	PresetID      *string
	Configuration json.RawMessage
	Presentation  *WidgetPresentation
	// Component is the first-class presentation, when the Widget has one.
	Component *WidgetPresentation
}

type playerPresentationCapabilities struct {
	SchemaVersions []int32
	Native         map[string]int
	WebRuntime     int
	PlayerVersion  int
	Reported       bool
}

type presentationQuery interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// ValidatePresentationTargets checks the content reachable from one playlist or
// published Layout against every explicitly targeted screen and group member.
func (s *Service) ValidatePresentationTargets(ctx context.Context, playlistID, layoutID *uuid.UUID, screenIDs, groupIDs []uuid.UUID) error {
	if (playlistID == nil) == (layoutID == nil) {
		return errors.New("presentation requires exactly one playlist or Layout")
	}
	contentType, contentID := "layout", layoutID
	if playlistID != nil {
		contentType, contentID = "playlist", playlistID
	}
	if err := s.ValidatePresentation(ctx, contentType, *contentID, time.Now().UTC()); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT sc.id
		FROM screens sc
		LEFT JOIN screen_group_memberships membership ON membership.screen_id=sc.id
		WHERE sc.deleted_at IS NULL
		  AND (sc.id=ANY($1::uuid[]) OR membership.screen_group_id=ANY($2::uuid[]))
		ORDER BY sc.id`, screenIDs, groupIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	targets := make([]uuid.UUID, 0, len(screenIDs))
	for rows.Next() {
		var screenID uuid.UUID
		if err = rows.Scan(&screenID); err != nil {
			return err
		}
		targets = append(targets, screenID)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return s.validatePresentationForScreens(ctx, s.db, playlistID, layoutID, targets)
}

func (s *Service) validatePresentationForScreens(ctx context.Context, q presentationQuery, playlistID, layoutID *uuid.UUID, screenIDs []uuid.UUID) error {
	requirements, v13Blocker, err := s.presentationRequirements(ctx, q, playlistID, layoutID)
	if err != nil {
		return err
	}
	for _, screenID := range screenIDs {
		player, err := readPlayerPresentationCapabilities(ctx, q, screenID)
		if err != nil {
			return err
		}
		if !player.Reported {
			if v13Blocker != "" {
				screenName := screenDisplayName(ctx, q, screenID)
				return fmt.Errorf("%w: %s", ErrConflict, sourceCapabilityError(screenName, v13Blocker))
			}
			for _, requirement := range requirements {
				if requirement.Presentation == nil {
					return fmt.Errorf("%w: %v", ErrConflict, checkPresentationCompatibility(ctx, q, screenID, requirement.Name, requirement.Component, player))
				}
			}
			continue
		}
		for _, requirement := range requirements {
			if err := checkWidgetCompatibility(ctx, q, screenID, requirement, player); err != nil {
				return fmt.Errorf("%w: %v", ErrConflict, err)
			}
		}
	}
	return nil
}

// presentationRequirements returns the compiled Widget presentation requirements
// reachable from a playlist or Layout, plus the name of a Data Source (or Widget)
// that requires manifest v13 when one is reachable ("" otherwise). Reachability
// mirrors manifest generation: playlist items, nested playlists, Layout widget,
// data_source, and playlist dependencies, and every Data Source referenced by a
// reachable Widget's configuration.
// orgPrivateHTTP reports website.private_http_enabled for the singleton
// organization, false when unreadable. It mirrors
// settings.Service.Organization without depending on the settings package:
// the merged default is false, so an absent key fails closed the same way.
// orgTimezone is the organization's regional timezone, or UTC.
func (s *Service) orgTimezone(ctx context.Context) string {
	var values []byte
	if err := s.db.QueryRow(ctx, `SELECT settings FROM organization_runtime_settings`).Scan(&values); err != nil {
		return "UTC"
	}
	var v map[string]any
	if err := json.Unmarshal(values, &v); err != nil {
		return "UTC"
	}
	if timezone, _ := v["organization.timezone"].(string); timezone != "" {
		return timezone
	}
	return "UTC"
}

func (s *Service) orgPrivateHTTP(ctx context.Context) bool {
	return orgPrivateHTTPFrom(ctx, s.db)
}

func orgPrivateHTTPFrom(ctx context.Context, q presentationQuery) bool {
	var values []byte
	if err := q.QueryRow(ctx, `SELECT settings FROM organization_runtime_settings`).Scan(&values); err != nil {
		return false
	}
	var v map[string]any
	if err := json.Unmarshal(values, &v); err != nil {
		return false
	}
	enabled, _ := v["website.private_http_enabled"].(bool)
	return enabled
}

func (s *Service) presentationRequirements(ctx context.Context, q presentationQuery, playlistID, layoutID *uuid.UUID) ([]presentationWidgetRequirement, string, error) {
	return s.presentationRequirementsForRoot(ctx, q, playlistID, layoutID, nil)
}

func (s *Service) presentationRequirementsForRoot(ctx context.Context, q presentationQuery, playlistID, layoutID, assetID *uuid.UUID) ([]presentationWidgetRequirement, string, error) {
	allowPrivateHTTP := orgPrivateHTTPFrom(ctx, q)
	// Effective availability is evaluated once per requirements pass: a
	// plugin-owned provider whose plugin is not installed cannot be
	// assigned or projected, while preserved rows stay in the database.
	// This reads before the widget rows open below because q may be a
	// transaction pinned to one connection.
	installed, err := plugins.InstalledSet(ctx, q)
	if err != nil {
		return nil, "", err
	}
	rows, err := q.Query(ctx, `
		WITH RECURSIVE refs(kind,id) AS (
			SELECT 'playlist', $1::uuid WHERE $1::uuid IS NOT NULL
			UNION
			SELECT 'layout', $2::uuid WHERE $2::uuid IS NOT NULL
			UNION
			SELECT next.kind,next.id
			FROM refs ref
			CROSS JOIN LATERAL (
				SELECT 'layout'::text AS kind,item.layout_id AS id
				FROM playlist_items item
				WHERE ref.kind='playlist' AND item.playlist_id=ref.id AND item.layout_id IS NOT NULL
				UNION
				SELECT 'playlist'::text,dependency.dependency_id
				FROM layouts layout
				JOIN layout_revision_dependencies dependency
				  ON dependency.revision_id=layout.published_revision_id
				 AND dependency.dependency_type='playlist'
				WHERE ref.kind='layout' AND layout.id=ref.id
			) next
		),
		selected_widgets AS (
			SELECT item.asset_id
			FROM playlist_items item
			WHERE item.playlist_id IN (SELECT id FROM refs WHERE kind='playlist')
			  AND item.asset_id IS NOT NULL
			UNION
			SELECT dependency.dependency_id
			FROM layouts layout
			JOIN layout_revision_dependencies dependency
			  ON dependency.revision_id=layout.published_revision_id
			 AND dependency.dependency_type='widget'
			WHERE layout.id IN (SELECT id FROM refs WHERE kind='layout')
			UNION
			SELECT $3::uuid WHERE $3::uuid IS NOT NULL
		)
		SELECT asset.id,asset.name,widget.provider,widget.preset_id,widget.configuration
		FROM selected_widgets selected
		JOIN widgets widget ON widget.asset_id=selected.asset_id
		JOIN assets asset ON asset.id=widget.asset_id
		WHERE asset.deleted_at IS NULL
		ORDER BY asset.name,widget.asset_id`, playlistID, layoutID, assetID)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	requirements := []presentationWidgetRequirement{}
	v13Blocker := ""
	sourceIDs := []uuid.UUID{}
	for rows.Next() {
		var requirement presentationWidgetRequirement
		if err = rows.Scan(&requirement.AssetID, &requirement.Name, &requirement.Provider, &requirement.PresetID, &requirement.Configuration); err != nil {
			return nil, "", err
		}
		if err = s.requireWidgetSourceUsable(installed, requirement.Name, requirement.Provider); err != nil {
			// A conflict the author can resolve by installing the plugin,
			// reported exactly as manifest generation reports it.
			return nil, "", fmt.Errorf("%w: %v", ErrConflict, err)
		}
		sourceIDs = append(sourceIDs, s.widgetDataSourceIDs(requirement.Provider, requirement.Configuration)...)
		requirement.Presentation, err = s.compileWidgetPresentationForPreset(requirement.Provider, requirement.PresetID, requirement.Configuration, allowPrivateHTTP)
		if err != nil {
			return nil, "", fmt.Errorf("compile Widget %q: %w", requirement.Name, err)
		}
		requirement.Component, err = s.compileWidgetComponent(requirement.Provider, requirement.Configuration)
		if err != nil {
			return nil, "", fmt.Errorf("compile Widget %q: %w", requirement.Name, err)
		}
		if requirement.Presentation == nil && requirement.Component == nil {
			continue
		}
		if v13Blocker == "" && s.widgetRequiresV13(requirement.Provider) {
			v13Blocker = "Widget “" + requirement.Name + "”"
		}
		requirements = append(requirements, requirement)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	// Data Sources bound directly through Layout text or visibility bindings are
	// reachable without any Widget; include them alongside Widget-referenced Sources.
	if layoutID != nil || playlistID != nil {
		bindingRows, bindingErr := q.Query(ctx, `
			WITH RECURSIVE refs(kind,id) AS (
				SELECT 'playlist', $1::uuid WHERE $1::uuid IS NOT NULL
				UNION
				SELECT 'layout', $2::uuid WHERE $2::uuid IS NOT NULL
				UNION
				SELECT next.kind,next.id
				FROM refs ref
				CROSS JOIN LATERAL (
					SELECT 'layout'::text AS kind,item.layout_id AS id
					FROM playlist_items item
					WHERE ref.kind='playlist' AND item.playlist_id=ref.id AND item.layout_id IS NOT NULL
					UNION
					SELECT 'playlist'::text,dependency.dependency_id
					FROM layouts layout
					JOIN layout_revision_dependencies dependency
					  ON dependency.revision_id=layout.published_revision_id
					 AND dependency.dependency_type='playlist'
					WHERE ref.kind='layout' AND layout.id=ref.id
				) next
			)
			SELECT dependency.dependency_id
			FROM layouts layout
			JOIN layout_revision_dependencies dependency
			  ON dependency.revision_id=layout.published_revision_id
			 AND dependency.dependency_type='data_source'
			WHERE layout.id IN (SELECT id FROM refs WHERE kind='layout')`, playlistID, layoutID)
		if bindingErr != nil {
			return nil, "", bindingErr
		}
		for bindingRows.Next() {
			var id uuid.UUID
			if err = bindingRows.Scan(&id); err != nil {
				bindingRows.Close()
				return nil, "", err
			}
			sourceIDs = append(sourceIDs, id)
		}
		if err = bindingRows.Err(); err != nil {
			bindingRows.Close()
			return nil, "", err
		}
		bindingRows.Close()
	}
	// A preserved plugin-owned Data Source is never a usable assignment
	// target while its plugin is missing, just like a plugin-owned
	// Widget above.
	if err = s.requireReachableSourcesUsable(ctx, q, installed, sourceIDs); err != nil {
		return nil, "", err
	}
	if v13Blocker == "" {
		blocker, blockerErr := s.reachableSourceRequiringV13(ctx, q, uniqueUUIDs(sourceIDs))
		if blockerErr != nil {
			return nil, "", blockerErr
		}
		v13Blocker = blocker
	}
	return requirements, v13Blocker, nil
}

// requireReachableSourcesUsable refuses an assignment that reaches a
// Data Source whose provider comes from a plugin that is not installed.
// Unknown rows pass through: missing rows fail later with the existing
// unavailable-source error.
func (s *Service) requireReachableSourcesUsable(ctx context.Context, q presentationQuery, installed map[string]bool, sourceIDs []uuid.UUID) error {
	for _, id := range uniqueUUIDs(sourceIDs) {
		var provider, name string
		err := q.QueryRow(ctx, `SELECT provider,name FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&provider, &name)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if err := s.requireDataSourceSourceUsable(installed, name, provider); err != nil {
			return fmt.Errorf("%w: %v", ErrConflict, err)
		}
	}
	return nil
}

// reachableSourceRequiringV13 returns the name of the first Data Source among the
// given IDs that requires manifest v13, or "" when none do. The requirement is
// read from the injected definition catalog, never from hardcoded provider lists.
func (s *Service) reachableSourceRequiringV13(ctx context.Context, q presentationQuery, sourceIDs []uuid.UUID) (string, error) {
	for _, id := range sourceIDs {
		var provider, name string
		err := q.QueryRow(ctx, `SELECT provider,name FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&provider, &name)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return "", err
		}
		if s.sourceRequiresV13(provider) {
			return "Data Source “" + name + "”", nil
		}
	}
	return "", nil
}

// widgetRequiresV13 reports whether a Widget provider needs manifest v13, using
// the injected definition catalog as the single source of truth.
func (s *Service) widgetRequiresV13(provider string) bool {
	definition, ok := s.definitions.Widget(provider)
	return ok && definition.RequiresManifestV13
}

// sourceRequiresV13 reports whether a Data Source provider needs manifest v13,
// using the injected definition catalog as the single source of truth.
func (s *Service) sourceRequiresV13(provider string) bool {
	definition, ok := s.definitions.DataSource(provider)
	return ok && definition.RequiresManifestV13
}

func readPlayerPresentationCapabilities(ctx context.Context, q presentationQuery, screenID uuid.UUID) (playerPresentationCapabilities, error) {
	var result playerPresentationCapabilities
	err := q.QueryRow(ctx, `
		SELECT COALESCE(presentation_schema_versions,'{}'::int[]),
		       COALESCE(native_presentation_capabilities,'{}'::jsonb),
		       COALESCE(web_runtime_version,0),
		       COALESCE(player_version_code,0)
		FROM screen_player_status
		WHERE screen_id=$1`, screenID).
		Scan(&result.SchemaVersions, &result.Native, &result.WebRuntime, &result.PlayerVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Reported = len(result.SchemaVersions) > 0
	return result, nil
}

func checkPresentationCompatibility(ctx context.Context, q presentationQuery, screenID uuid.UUID, name string, presentation *WidgetPresentation, player playerPresentationCapabilities) error {
	if presentation == nil {
		return nil
	}
	supported, capabilities := presentationSupported(presentation, player)
	if supported {
		return nil
	}
	return errors.New(widgetCapabilityError(screenDisplayName(ctx, q, screenID), name, presentation, player, capabilities))
}

// checkWidgetCompatibility accepts a Widget when the Player renders its
// component or, failing that, its compatibility presentation. A Widget without
// a compatibility presentation is reported against its component.
func checkWidgetCompatibility(ctx context.Context, q presentationQuery, screenID uuid.UUID, requirement presentationWidgetRequirement, player playerPresentationCapabilities) error {
	presentation, _ := widgetCompatibilityTarget(requirement, player)
	return checkPresentationCompatibility(ctx, q, screenID, requirement.Name, presentation, player)
}

// Both validation and structured evidence choose the same renderer target.
func widgetCompatibilityTarget(requirement presentationWidgetRequirement, player playerPresentationCapabilities) (*WidgetPresentation, string) {
	if requirement.Component != nil {
		if supported, _ := presentationSupported(requirement.Component, player); supported {
			return requirement.Component, "component"
		}
		if requirement.Presentation == nil {
			return requirement.Component, "component"
		}
	}
	return requirement.Presentation, "compatibility"
}

// widgetCapabilityError describes exactly why a screen cannot display a Widget:
// the screen (when known), the Widget name, and the required and reported
// presentation schema and capability versions. It never exposes database IDs.
func widgetCapabilityError(screen, name string, presentation *WidgetPresentation, player playerPresentationCapabilities, capabilities []string) string {
	var b strings.Builder
	b.WriteString(screenClause(screen))
	fmt.Fprintf(&b, " cannot display “%s”.\n\nRequired:\npresentation schema v%d", name, presentation.SchemaVersion)
	for _, capability := range capabilities {
		fmt.Fprintf(&b, "\n%s@%d", capability, presentation.RequiredCapabilities[capability])
	}
	fmt.Fprintf(&b, "\n\nReported:\npresentation schema %s", reportedSchemaVersions(player.SchemaVersions))
	for _, capability := range capabilities {
		reported := player.Native[capability]
		if capability == "web.remote" {
			reported = player.WebRuntime
		}
		fmt.Fprintf(&b, "\n%s@%d", capability, reported)
	}
	return b.String()
}

// sourceCapabilityError describes why a screen cannot use content that needs
// manifest v13 when the target Player has not reported compatible capabilities.
// blocker names the reachable Widget or Data Source (already quoted).
func sourceCapabilityError(screen, blocker string) string {
	return fmt.Sprintf("%s cannot use %s.\n\nRequired:\nData Document v1 and manifest v13\n\nThe Player has not reported compatible presentation capabilities.",
		screenClause(screen), blocker)
}

func screenClause(screen string) string {
	if screen == "" {
		return "This screen"
	}
	return fmt.Sprintf("This screen “%s”", screen)
}

// screenDisplayName returns the screen's name for user-facing messages, or ""
// when it cannot be resolved. Errors are non-fatal: messages simply omit the name.
func screenDisplayName(ctx context.Context, q presentationQuery, screenID uuid.UUID) string {
	if q == nil || screenID == uuid.Nil {
		return ""
	}
	var name string
	if err := q.QueryRow(ctx, `SELECT name FROM screens WHERE id=$1 AND deleted_at IS NULL`, screenID).Scan(&name); err != nil {
		return ""
	}
	return name
}

func reportedSchemaVersions(versions []int32) string {
	if len(versions) == 0 {
		return "none"
	}
	values := make([]string, 0, len(versions))
	for _, version := range versions {
		values = append(values, fmt.Sprint(version))
	}
	return strings.Join(values, ", ")
}
