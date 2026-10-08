package services

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
	"github.com/tilecast/tilecast/apps/server/internal/playercaps"
	"github.com/tilecast/tilecast/apps/server/internal/takeovers"
	plugin "github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// This file implements the mutating operations. Every mutation runs in
// one transaction through a canonical domain service, writes its audit
// event in the same transaction, and runs AfterCommit callbacks only
// after commit. Studio mutations enforce the dashboard's role policy;
// background mutations run under the install-time grant with system
// attribution that never names a user.

// packageAuditAction keeps guest-written audit actions inside the
// package namespace so a guest can never forge a core audit event.
var packageAuditAction = regexp.MustCompile(`^package\.[a-z0-9_.:-]{1,79}$`)

func (d *Dispatcher) actorID(call Call) uuid.UUID {
	if call.Context == ContextStudio && call.Actor != nil {
		return call.Actor.UserID
	}
	return uuid.Nil
}

// auditContext attributes package audit writes: Studio calls carry the
// studio surface with the actor, background calls stay unattributed so
// the shared audit path names the server client.
func auditContext(ctx context.Context, call Call) context.Context {
	if call.Context == ContextStudio {
		return audit.WithSurface(ctx, audit.SurfaceStudio)
	}
	return ctx
}

func packageMetadata(call Call) map[string]any {
	return map[string]any{"package_id": call.PackageID}
}

// ---------------------------------------------------------------- managed

func (d *Dispatcher) managedEnsure(ctx context.Context, call Call) (any, *Denial, *CallError) {
	// Managed presentations create playlists and data sources, so Studio
	// callers need content-author roles, matching the dashboard.
	if failure := studioRole(call, "owner", "administrator", "editor", "contributor"); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		Name                    string `json:"name"`
		Description             string `json:"description"`
		DataSourceProvider      string `json:"dataSourceProvider"`
		DataSourceConfiguration string `json:"dataSourceConfiguration"`
		CachedPayload           string `json:"cachedPayload"`
		CacheCategory           string `json:"cacheCategory"`
		CacheExpiresAt          string `json:"cacheExpiresAt"`
		WidgetProvider          string `json:"widgetProvider"`
		WidgetConfiguration     string `json:"widgetConfiguration"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	name := strings.TrimSpace(input.Name)
	description := strings.TrimSpace(input.Description)
	if name == "" || len(name) > 180 || len(description) > 2000 {
		return nil, nil, invalidInput("name or description is invalid")
	}
	if strings.TrimSpace(input.DataSourceProvider) == "" || len(input.DataSourceProvider) > 80 ||
		strings.TrimSpace(input.WidgetProvider) == "" || len(input.WidgetProvider) > 80 {
		return nil, nil, invalidInput("providers are required")
	}
	if !json.Valid([]byte(input.DataSourceConfiguration)) || !json.Valid([]byte(input.CachedPayload)) {
		return nil, nil, invalidInput("data source configuration and payload must be JSON")
	}
	var widgetConfig map[string]any
	if err := json.Unmarshal([]byte(input.WidgetConfiguration), &widgetConfig); err != nil {
		return nil, nil, invalidInput("widget configuration must be a JSON object")
	}
	if len(input.CacheCategory) > 80 {
		return nil, nil, invalidInput("cache category is too long")
	}
	var expires time.Time
	if strings.TrimSpace(input.CacheExpiresAt) != "" {
		parsed, err := time.Parse(time.RFC3339, input.CacheExpiresAt)
		if err != nil {
			return nil, nil, invalidInput("cacheExpiresAt must be RFC 3339")
		}
		expires = parsed
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	existing, err := d.ownedManaged(ctx, tx, call.PackageID)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	managed, err := d.deps.Shared.ManagedPresentations.EnsureInTx(ctx, tx, existing, plugin.ManagedPresentationRequest{
		Name: name, Description: description,
		DataSourceProvider:      strings.TrimSpace(input.DataSourceProvider),
		DataSourceConfiguration: input.DataSourceConfiguration,
		CachedPayload:           input.CachedPayload, CacheCategory: input.CacheCategory, CacheExpiresAt: expires,
		WidgetProvider: strings.TrimSpace(input.WidgetProvider),
		// The host binds the widget to the managed data source it just
		// created: the guest names every other field, never the link.
		WidgetConfiguration: func(sourceID uuid.UUID) string {
			widgetConfig["dataSourceId"] = sourceID.String()
			bytes, _ := json.Marshal(widgetConfig)
			return string(bytes)
		},
		CreatedBy: d.actorID(call),
	})
	if err != nil {
		return nil, nil, unavailable(err)
	}
	if existing != managed {
		if err := d.rememberManaged(ctx, tx, call.PackageID, managed); err != nil {
			return nil, nil, unavailable(err)
		}
	}
	if err := d.deps.Shared.Audit.RecordInTx(auditContext(ctx, call), tx, plugin.AuditEvent{
		Action: "package.managed_presentation.ensured", ResourceType: "playlist",
		ResourceID: managed.PlaylistID.String(), ResourceName: name,
		Metadata: packageMetadata(call), UserID: d.actorID(call),
	}); err != nil {
		return nil, nil, unavailable(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"dataSourceId": managed.DataSourceID, "widgetId": managed.WidgetID, "playlistId": managed.PlaylistID}, nil, nil
}

func (d *Dispatcher) managedUpdateData(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := studioRole(call, "owner", "administrator", "editor", "contributor"); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		Configuration  string `json:"configuration"`
		CachedPayload  string `json:"cachedPayload"`
		CacheCategory  string `json:"cacheCategory"`
		CacheExpiresAt string `json:"cacheExpiresAt"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if !json.Valid([]byte(input.Configuration)) || !json.Valid([]byte(input.CachedPayload)) {
		return nil, nil, invalidInput("configuration and payload must be JSON")
	}
	if len(input.CacheCategory) > 80 {
		return nil, nil, invalidInput("cache category is too long")
	}
	var expires time.Time
	if strings.TrimSpace(input.CacheExpiresAt) != "" {
		parsed, err := time.Parse(time.RFC3339, input.CacheExpiresAt)
		if err != nil {
			return nil, nil, invalidInput("cacheExpiresAt must be RFC 3339")
		}
		expires = parsed
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	owned, err := d.ownedManaged(ctx, tx, call.PackageID)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	if owned == (plugin.ManagedPresentation{}) {
		return nil, nil, conflict("no managed presentation exists; call ensure first")
	}
	updated, err := d.deps.Shared.ManagedPresentations.UpdateDataInTx(ctx, tx, owned.DataSourceID, input.Configuration, input.CachedPayload, input.CacheCategory, expires)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	if updated {
		if err := d.deps.Shared.Audit.RecordInTx(auditContext(ctx, call), tx, plugin.AuditEvent{
			Action: "package.managed_presentation.data_updated", ResourceType: "data_source",
			ResourceID: owned.DataSourceID.String(),
			Metadata:   packageMetadata(call), UserID: d.actorID(call),
		}); err != nil {
			return nil, nil, unavailable(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"updated": updated}, nil, nil
}

func (d *Dispatcher) managedGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct{}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	var owned plugin.ManagedPresentation
	err := d.deps.DB.QueryRow(ctx, `SELECT data_source_id,widget_id,playlist_id FROM external_package_managed_presentations WHERE organization_id=(SELECT id FROM organization_settings WHERE singleton) AND package_id=$1`, call.PackageID).Scan(&owned.DataSourceID, &owned.WidgetID, &owned.PlaylistID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, notFound("no managed presentation exists")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"dataSourceId": owned.DataSourceID, "widgetId": owned.WidgetID, "playlistId": owned.PlaylistID}, nil, nil
}

// ownedManaged reads the package's managed row under lock. A zero value
// means the package owns nothing yet.
func (d *Dispatcher) ownedManaged(ctx context.Context, tx pgx.Tx, packageID string) (plugin.ManagedPresentation, error) {
	var owned plugin.ManagedPresentation
	err := tx.QueryRow(ctx, `SELECT data_source_id,widget_id,playlist_id FROM external_package_managed_presentations WHERE organization_id=(SELECT id FROM organization_settings WHERE singleton) AND package_id=$1 FOR UPDATE`, packageID).Scan(&owned.DataSourceID, &owned.WidgetID, &owned.PlaylistID)
	if errors.Is(err, pgx.ErrNoRows) {
		return plugin.ManagedPresentation{}, nil
	}
	return owned, err
}

func (d *Dispatcher) rememberManaged(ctx context.Context, tx pgx.Tx, packageID string, managed plugin.ManagedPresentation) error {
	_, err := tx.Exec(ctx, `INSERT INTO external_package_managed_presentations(organization_id,package_id,data_source_id,widget_id,playlist_id) VALUES((SELECT id FROM organization_settings WHERE singleton),$1,$2,$3,$4) ON CONFLICT(organization_id,package_id) DO UPDATE SET data_source_id=$2,widget_id=$3,playlist_id=$4,updated_at=now()`, packageID, managed.DataSourceID, managed.WidgetID, managed.PlaylistID)
	return err
}

// ---------------------------------------------------------------- takeovers

func (d *Dispatcher) takeoverActivate(ctx context.Context, call Call) (any, *Denial, *CallError) {
	// Takeovers are the most disruptive Studio action: only Owners and
	// Administrators trigger them from Studio, matching the dashboard.
	// Background activation runs under the install-time grant.
	if failure := studioRole(call, "owner", "administrator"); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		Name        string      `json:"name"`
		Description string      `json:"description"`
		PlaylistID  uuid.UUID   `json:"playlistId"`
		ScreenIDs   []uuid.UUID `json:"screenIds"`
		GroupIDs    []uuid.UUID `json:"groupIds"`
		ExpiresAt   time.Time   `json:"expiresAt"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	now := d.now()
	if call.Context == ContextStudio && d.reauthenticationRequired(ctx) {
		// The organization requires a password confirmation a package
		// call cannot provide. Refuse rather than bypass the policy.
		return nil, nil, forbidden("this organization requires password confirmation to start a takeover")
	}
	name := strings.TrimSpace(input.Name)
	description := strings.TrimSpace(input.Description)
	if name == "" || len(name) > 180 || len(description) > 2000 {
		return nil, nil, invalidInput("name or description is invalid")
	}
	if input.PlaylistID == uuid.Nil {
		return nil, nil, invalidInput("playlistId is required")
	}
	if len(input.ScreenIDs)+len(input.GroupIDs) == 0 {
		return nil, nil, invalidInput("select at least one screen or group")
	}
	if len(input.ScreenIDs)+len(input.GroupIDs) > d.deps.Limits.MaxTakeoverTargets {
		return nil, nil, invalidInput("a takeover may have at most %d targets", d.deps.Limits.MaxTakeoverTargets)
	}
	if !input.ExpiresAt.After(now) || input.ExpiresAt.Sub(now) > d.deps.Takeovers.MaximumDuration() {
		return nil, nil, invalidInput("expiration must be within the maximum takeover duration")
	}
	if err := d.deps.Playlists.ValidatePresentationNow(ctx, "playlist", input.PlaylistID, now); err != nil {
		return nil, nil, invalidInput("select a ready, non-empty playlist")
	}
	if call.Context == ContextStudio && call.Actor != nil {
		resolved, err := d.resolveTargets(ctx, input.ScreenIDs, input.GroupIDs)
		if err != nil {
			return nil, nil, unavailable(err)
		}
		if err := d.deps.Devices.AuthorizeScreens(ctx, call.Actor.UserID, call.Actor.Role, resolved); err != nil {
			if errors.Is(err, devices.ErrOutOfScope) {
				return nil, nil, forbidden("some of the selected screens are outside your assigned scope")
			}
			return nil, nil, unavailable(err)
		}
	}
	if err := d.deps.Playlists.ValidatePresentationTargets(ctx, &input.PlaylistID, nil, input.ScreenIDs, input.GroupIDs); err != nil {
		return nil, nil, invalidInput("the playlist cannot play on the selected targets")
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	result, afterCommit, err := d.deps.Shared.Takeovers.ActivateInTx(ctx, tx, plugin.TakeoverRequest{
		Name: name, Description: description, PlaylistID: input.PlaylistID,
		Targets:     plugin.ScreenTargets{ScreenIDs: input.ScreenIDs, GroupIDs: input.GroupIDs},
		ActivatedBy: d.actorID(call), ActivatedAt: now, ExpiresAt: input.ExpiresAt,
		AuditMetadata: packageMetadata(call),
	})
	if errors.Is(err, takeovers.ErrNoEligibleScreens) {
		return nil, nil, invalidInput("no eligible screens matched the targets")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, unavailable(err)
	}
	afterCommit()
	return map[string]any{"id": result.ID, "status": "active", "affectedCount": result.AffectedCount, "expiresAt": input.ExpiresAt}, nil, nil
}

func (d *Dispatcher) reauthenticationRequired(ctx context.Context) bool {
	if d.deps.Settings == nil {
		return false
	}
	document, err := d.deps.Settings.Organization(ctx)
	if err != nil {
		return false
	}
	required, _ := document.Values["takeover.reauthentication_required"].(bool)
	return required
}

func (d *Dispatcher) resolveTargets(ctx context.Context, screens, groups []uuid.UUID) ([]uuid.UUID, error) {
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	resolved, err := d.deps.Shared.Targets.ResolveScreensInTx(ctx, tx, plugin.ScreenTargets{ScreenIDs: screens, GroupIDs: groups})
	if err != nil {
		return nil, err
	}
	return resolved, tx.Commit(ctx)
}

func (d *Dispatcher) takeoverCancel(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := studioRole(call, "owner", "administrator"); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		ID     uuid.UUID `json:"id"`
		Reason string    `json:"reason"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	if len(input.Reason) > 1000 {
		return nil, nil, invalidInput("reason is too long")
	}
	if call.Context == ContextStudio && call.Actor != nil {
		// Mirror the dashboard's takeover middleware: outside scope
		// reads as not found.
		screens, err := d.deps.Takeovers.TargetScreens(ctx, input.ID)
		if err != nil {
			return nil, nil, unavailable(err)
		}
		if err := d.deps.Devices.AuthorizeScreens(ctx, call.Actor.UserID, call.Actor.Role, screens); err != nil {
			if errors.Is(err, devices.ErrOutOfScope) {
				return nil, nil, notFound("takeover was not found")
			}
			return nil, nil, unavailable(err)
		}
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	afterCommit, err := d.deps.Shared.Takeovers.CancelInTx(ctx, tx, input.ID, d.actorID(call), strings.TrimSpace(input.Reason))
	if errors.Is(err, takeovers.ErrInactive) {
		return nil, nil, conflict("takeover is no longer active")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	if d.actorID(call) == uuid.Nil {
		// The canonical service audits user cancels itself; a system
		// cancel needs its explicit event here.
		if err := d.deps.Shared.Audit.RecordInTx(auditContext(ctx, call), tx, plugin.AuditEvent{
			Action: "takeover.cancelled", ResourceType: "takeover",
			ResourceID: input.ID.String(), Metadata: packageMetadata(call),
		}); err != nil {
			return nil, nil, unavailable(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, unavailable(err)
	}
	afterCommit()
	return map[string]any{"id": input.ID, "status": "cancelled"}, nil, nil
}

// ---------------------------------------------------------------- audit

func (d *Dispatcher) auditWrite(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct {
		Action       string         `json:"action"`
		ResourceType string         `json:"resourceType"`
		ResourceID   string         `json:"resourceId"`
		ResourceName string         `json:"resourceName"`
		Metadata     map[string]any `json:"metadata"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	action := strings.TrimSpace(input.Action)
	if !packageAuditAction.MatchString(action) {
		return nil, nil, invalidInput("action must be a package-namespaced audit action")
	}
	resourceType := strings.TrimSpace(input.ResourceType)
	if resourceType == "" || len(resourceType) > 80 {
		return nil, nil, invalidInput("resourceType is required")
	}
	if len(input.ResourceID) > 128 || len(input.ResourceName) > 200 {
		return nil, nil, invalidInput("resource reference is too long")
	}
	metadata := input.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	if len(metadata) > 16 {
		return nil, nil, invalidInput("metadata holds at most 16 entries")
	}
	metadata["package_id"] = call.PackageID
	encoded, err := json.Marshal(metadata)
	if err != nil || len(encoded) > 4096 {
		return nil, nil, invalidInput("metadata must be JSON under 4 KiB")
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := d.deps.Shared.Audit.RecordInTx(auditContext(ctx, call), tx, plugin.AuditEvent{
		Action: action, ResourceType: resourceType,
		ResourceID: input.ResourceID, ResourceName: input.ResourceName,
		Metadata: metadata, UserID: d.actorID(call),
	}); err != nil {
		return nil, nil, unavailable(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"written": true}, nil, nil
}

// ---------------------------------------------------------------- players

// playerCommand maps one Player Capability operation to the persistent
// command system. The checks run in order: grant (by the transport),
// Studio role, operation schema, target eligibility, reported
// capability, then ordinary command eligibility inside the enqueue.
// Guests never name a command type or touch the queue directly.
func (d *Dispatcher) playerCommand(ctx context.Context, call Call, operation string) (any, *Denial, *CallError) {
	// Display commands are Owner/Administrator actions on the dashboard;
	// Studio package calls match. Background runs under the grant.
	if failure := studioRole(call, "owner", "administrator"); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		ScreenID uuid.UUID      `json:"screenId"`
		Input    map[string]any `json:"input"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ScreenID == uuid.Nil {
		return nil, nil, invalidInput("screenId is required")
	}
	operationInput := input.Input
	if operationInput == nil {
		operationInput = map[string]any{}
	}
	resolved, err := playercaps.Resolve(operation, operationInput)
	if err != nil {
		return nil, nil, invalidInput("operation input is invalid: %v", err)
	}
	var enabled, active, hasCredential bool
	var genericRaw, legacyRaw []byte
	err = d.deps.DB.QueryRow(ctx, `SELECT s.enabled,(s.archived_at IS NULL),
	       EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=s.id AND c.revoked_at IS NULL),
	       COALESCE(ps.player_capabilities,'{}'::jsonb),
	       COALESCE(ps.display_control_capabilities,'{}'::jsonb)
		FROM screens s LEFT JOIN screen_player_status ps ON ps.screen_id=s.id
		WHERE s.id=$1 AND s.deleted_at IS NULL`, input.ScreenID).
		Scan(&enabled, &active, &hasCredential, &genericRaw, &legacyRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, notFound("screen was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	if !enabled {
		return nil, nil, forbidden("screen is disabled")
	}
	if !active {
		return nil, nil, forbidden("screen hardware is archived")
	}
	if !hasCredential {
		return nil, nil, forbidden("screen has no active player credential")
	}
	if !playerReportsCapability(genericRaw, legacyRaw, operation) {
		return nil, nil, forbidden("player does not report " + operation + " control")
	}
	payload, err := json.Marshal(resolved.Payload)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	var creator *uuid.UUID
	if call.Context == ContextStudio && call.Actor != nil {
		creator = &call.Actor.UserID
	}
	id, expires, err := d.deps.Devices.EnqueuePlayerCommand(ctx, input.ScreenID, creator,
		resolved.Command, payload, uuid.New(),
		d.deps.Limits.MaxPendingCommands, d.deps.Limits.DefaultCommandExpiryMinutes)
	if errors.Is(err, devices.ErrCommandScreenNotFound) {
		return nil, nil, notFound("screen was not found")
	}
	if errors.Is(err, devices.ErrCommandLimit) {
		return nil, nil, unavailable(errors.New("screen reached its pending-command limit"))
	}
	if errors.Is(err, devices.ErrCommandUnsupported) {
		return nil, nil, forbidden("player cannot run this command")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	metadata := packageMetadata(call)
	metadata["operation"] = operation
	metadata["command"] = resolved.Command
	if err := d.deps.Shared.Audit.RecordInTx(auditContext(ctx, call), tx, plugin.AuditEvent{
		Action: "package.player.command_queued", ResourceType: "player_command",
		ResourceID: id.String(), Metadata: metadata, UserID: d.actorID(call),
	}); err != nil {
		return nil, nil, unavailable(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{
		"queued": true, "commandId": id.String(), "commandType": resolved.Command,
		"screenId": input.ScreenID.String(), "expiresAt": expires.UTC().Format(time.RFC3339),
	}, nil, nil
}

// playerReportsCapability accepts the generic capability report first
// and the legacy display-control map second, so players that predate
// the generic report keep working while new reporters use versions.
func playerReportsCapability(genericRaw, legacyRaw []byte, operation string) bool {
	var generic map[string]struct {
		Version  int    `json:"version"`
		Provider string `json:"provider"`
	}
	if json.Unmarshal(genericRaw, &generic) == nil {
		if entry, ok := generic[operation]; ok && entry.Version == playercaps.Version1 && playercaps.KnownProvider(entry.Provider) {
			return true
		}
	}
	legacyName, ok := playercaps.DisplayControlName(operation)
	if !ok {
		return false
	}
	var legacy map[string]string
	if json.Unmarshal(legacyRaw, &legacy) != nil {
		return false
	}
	provider, ok := legacy[legacyName]
	return ok && provider != displaycontrol.ProviderUnsupported && displaycontrol.IsProvider(provider)
}
