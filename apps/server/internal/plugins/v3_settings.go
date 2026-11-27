package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Host-owned settings of Plugin Manifest API 3 plugins. The organization
// scope holds one document; the screen scope holds one document for each
// screen. The instance scope is the instance kind's field list and is
// written through the instance API.

func (s *Service) settingsFields(pluginID, scope string) (hostedPlugin, []configschema.Field, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || hosted.manifest.Settings == nil {
		return hostedPlugin{}, nil, ErrPluginNotFound
	}
	var fields []configschema.Field
	switch scope {
	case scopeOrganization:
		fields = hosted.manifest.Settings.Organization
	case scopeScreen:
		fields = hosted.manifest.Settings.Screen
	}
	if len(fields) == 0 {
		return hostedPlugin{}, nil, ErrNotFound
	}
	return hosted, fields, nil
}

// authorizeScreenSettings decides a screen-scoped settings read or write
// for the Studio operator of ctx, with the screen rule core screen pages
// use. An out-of-reach screen answers not found.
func (s *Service) authorizeScreenSettings(ctx context.Context, q authz.Querier, screenID uuid.UUID, capability auth.Capability) error {
	principal, ok := plugin.PrincipalFrom(ctx)
	if !ok {
		return nil
	}
	held := make([]auth.Capability, 0, len(principal.Capabilities))
	for _, value := range principal.Capabilities {
		held = append(held, auth.Capability(value))
	}
	actor := authz.ActorForRole(principal.UserID, principal.Role, auth.NewCapabilitySet(held...))
	err := authz.New(q).Screen(ctx, actor, capability, screenID)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, authz.ErrNotFound), errors.Is(err, authz.ErrOutOfScope), errors.Is(err, authz.ErrForbidden):
		return &plugin.APIError{Status: 404, Code: "screen_not_found", Message: "The screen was not found."}
	default:
		return err
	}
}

func ownerFor(scope string, organizationID, screenID uuid.UUID) (string, uuid.UUID) {
	if scope == scopeScreen {
		return pluginsecrets.OwnerScreen, screenID
	}
	return pluginsecrets.OwnerOrganization, organizationID
}

// GetSettings returns one settings document. A scope never written answers
// its defaults at revision 0.
func (s *Service) GetSettings(ctx context.Context, pluginID, scope string, screenID uuid.UUID) (SettingsDocument, error) {
	_, fields, err := s.settingsFields(pluginID, scope)
	if err != nil {
		return SettingsDocument{}, err
	}
	if scope == scopeScreen {
		if err := s.authorizeScreenSettings(ctx, s.db, screenID, auth.CapScreenRead); err != nil {
			return SettingsDocument{}, err
		}
		var exists bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens WHERE id=$1 AND archived_at IS NULL)`, screenID).Scan(&exists); err != nil {
			return SettingsDocument{}, err
		}
		if !exists {
			return SettingsDocument{}, &plugin.APIError{Status: 404, Code: "screen_not_found", Message: "The screen was not found."}
		}
	}
	return s.readSettings(ctx, s.db, pluginID, scope, screenID, fields)
}

func (s *Service) readSettings(ctx context.Context, q queryer, pluginID, scope string, screenID uuid.UUID, fields []configschema.Field) (SettingsDocument, error) {
	document, err := readSettingsValues(ctx, q, pluginID, scope, screenID, fields)
	if err != nil {
		return SettingsDocument{}, err
	}
	if keys := configschema.SecretKeys(fields); len(keys) > 0 {
		organizationID, err := organizationService{service: s}.ID(ctx)
		if err != nil {
			return SettingsDocument{}, err
		}
		ownerType, ownerID := ownerFor(scope, organizationID, screenID)
		if s.secrets == nil {
			document.Secrets = map[string]pluginsecrets.State{}
			for _, key := range keys {
				document.Secrets[key] = pluginsecrets.StateNeedsValue
			}
		} else if document.Secrets, err = s.secrets.States(ctx, q, pluginID, ownerType, ownerID, keys); err != nil {
			return SettingsDocument{}, err
		}
	}
	return document, nil
}

func readSettingsValues(ctx context.Context, q queryer, pluginID, scope string, screenID uuid.UUID, fields []configschema.Field) (SettingsDocument, error) {
	document := SettingsDocument{Scope: scope, Values: map[string]any{}}
	if scope == scopeScreen {
		id := screenID
		document.ScreenID = &id
	}
	var raw []byte
	var updatedAt time.Time
	var err error
	if scope == scopeOrganization {
		err = q.QueryRow(ctx, `SELECT "values",revision,updated_at FROM plugin_settings WHERE plugin_id=$1 AND scope='organization'`, pluginID).Scan(&raw, &document.Revision, &updatedAt)
	} else {
		err = q.QueryRow(ctx, `SELECT "values",revision,updated_at FROM plugin_settings WHERE plugin_id=$1 AND scope='screen' AND screen_id=$2`, pluginID, screenID).Scan(&raw, &document.Revision, &updatedAt)
	}
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		defaultFields := slices.DeleteFunc(slices.Clone(fields), func(field configschema.Field) bool {
			return field.Default == nil
		})
		defaults, normalizeErr := configschema.Normalize(ctx, defaultFields, nil, nil)
		if normalizeErr == nil {
			document.Values = defaults
		}
	case err != nil:
		return SettingsDocument{}, err
	default:
		document.UpdatedAt = &updatedAt
		if err := json.Unmarshal(raw, &document.Values); err != nil {
			return SettingsDocument{}, err
		}
	}
	return document, nil
}

// UpdateSettings replaces one settings document when expectedRevision is
// current (0 for a scope never written). Secret fields are written and
// cleared through the secret store; their values never reach the document,
// the audit event, or a log.
func (s *Service) UpdateSettings(ctx context.Context, pluginID, scope string, screenID, userID uuid.UUID, write SettingsWrite) (SettingsDocument, error) {
	hosted, fields, err := s.settingsFields(pluginID, scope)
	if err != nil {
		return SettingsDocument{}, err
	}
	if write.ExpectedRevision == nil {
		return SettingsDocument{}, revisionRequiredError()
	}
	values := map[string]any{}
	for key, value := range write.Values {
		if value != nil {
			values[key] = value
		}
	}
	normalized, err := configschema.Normalize(ctx, fields, values, s.pluginConfigReferences(pluginID))
	if err != nil {
		return SettingsDocument{}, fmt.Errorf("%w: %v", plugin.ErrInvalid, err)
	}
	secretFields := map[string]configschema.Field{}
	for _, field := range fields {
		if field.Control == configschema.ControlSecret {
			secretFields[field.Key] = field
		}
	}
	secrets := map[string]string{}
	for key, value := range write.Secrets {
		field, ok := secretFields[key]
		if !ok {
			return SettingsDocument{}, plugin.Invalidf("%s is not a secret setting", key)
		}
		if secrets[key], err = configschema.NormalizeSecret(field, value); err != nil {
			return SettingsDocument{}, fmt.Errorf("%w: %v", plugin.ErrInvalid, err)
		}
	}
	for _, key := range write.ClearSecrets {
		if _, ok := secretFields[key]; !ok {
			return SettingsDocument{}, plugin.Invalidf("%s is not a secret setting", key)
		}
		if _, set := secrets[key]; set {
			return SettingsDocument{}, plugin.Invalidf("%s cannot be set and cleared in one request", key)
		}
	}
	if (len(secrets) > 0 || len(write.ClearSecrets) > 0) && s.secrets == nil {
		return SettingsDocument{}, &plugin.APIError{Status: 503, Code: "secrets_unavailable", Message: "Plugin secrets are unavailable on this server."}
	}
	organizationID, err := organizationService{service: s}.ID(ctx)
	if err != nil {
		return SettingsDocument{}, err
	}
	notes, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		if err := s.lockInstallation(ctx, tx, pluginID); err != nil {
			return nil, err
		}
		if scope == scopeScreen {
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens WHERE id=$1 AND archived_at IS NULL)`, screenID).Scan(&exists); err != nil {
				return nil, err
			}
			if !exists {
				return nil, &plugin.APIError{Status: 404, Code: "screen_not_found", Message: "The screen was not found."}
			}
			if err := s.authorizeScreenSettings(ctx, tx, screenID, auth.CapScreenManage); err != nil {
				return nil, err
			}
		}
		var rowID uuid.UUID
		var revision int64
		var before map[string]any
		var raw []byte
		query := `SELECT id,revision,"values" FROM plugin_settings WHERE plugin_id=$1 AND scope='organization' FOR UPDATE`
		args := []any{pluginID}
		if scope == scopeScreen {
			query = `SELECT id,revision,"values" FROM plugin_settings WHERE plugin_id=$1 AND scope='screen' AND screen_id=$2 FOR UPDATE`
			args = append(args, screenID)
		}
		err := tx.QueryRow(ctx, query, args...).Scan(&rowID, &revision, &raw)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if *write.ExpectedRevision != 0 {
				return nil, settingsConflictError(0)
			}
			rowID = uuid.New()
		case err != nil:
			return nil, err
		default:
			if revision != *write.ExpectedRevision {
				return nil, settingsConflictError(revision)
			}
			if err := json.Unmarshal(raw, &before); err != nil {
				return nil, err
			}
		}
		ownerType, ownerID := ownerFor(scope, organizationID, screenID)
		if err := s.requiredSecretsSet(ctx, tx, pluginID, ownerType, ownerID, fields, secrets, write.ClearSecrets); err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return nil, err
		}
		personal := personalWrites(fields, before, normalized, s.clock.Now())
		var screen *uuid.UUID
		if scope == scopeScreen {
			screen = &screenID
		}
		if revision == 0 {
			_, err = tx.Exec(ctx, `INSERT INTO plugin_settings(id,organization_id,plugin_id,scope,screen_id,"values",personal_written_at,updated_by)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, rowID, organizationID, pluginID, scope, screen, encoded, personal, nullableUser(userID))
		} else {
			_, err = tx.Exec(ctx, `UPDATE plugin_settings SET "values"=$2,personal_written_at=personal_written_at||$3::jsonb,revision=revision+1,updated_by=$4,updated_at=now()
				WHERE id=$1`, rowID, encoded, personal, nullableUser(userID))
		}
		if err != nil {
			return nil, err
		}
		label := hosted.definition.Name + " settings"
		if err := storeConfigReferences(ctx, tx, pluginID, rowID, label, fields, normalized); err != nil {
			return nil, err
		}
		if err := useConnections(ctx, tx, pluginID, "settings", rowID, label, fields, normalized); err != nil {
			return nil, err
		}
		secretKeys := []string{}
		for key, value := range secrets {
			ref := pluginsecrets.SecretRef{PluginID: pluginID, OwnerType: ownerType, OwnerID: ownerID, Key: key}
			if err := s.secrets.WriteInTx(ctx, tx, ref, value, nullableUser(userID)); err != nil {
				return nil, err
			}
			secretKeys = append(secretKeys, key)
		}
		for _, key := range write.ClearSecrets {
			ref := pluginsecrets.SecretRef{PluginID: pluginID, OwnerType: ownerType, OwnerID: ownerID, Key: key}
			if _, err := s.secrets.DeleteInTx(ctx, tx, ref); err != nil {
				return nil, err
			}
			secretKeys = append(secretKeys, key)
		}
		sortStrings(secretKeys)
		metadata := map[string]any{"pluginId": pluginID, "scope": scope, "changedKeys": changedKeys(before, normalized)}
		if len(secretKeys) > 0 {
			metadata["secretKeys"] = secretKeys
		}
		event := audit.Event{Action: "plugin.settings.updated", ResourceType: "plugin_settings", ResourceID: rowID.String(), ResourceName: label, Metadata: metadata}
		if userID != uuid.Nil {
			actor := userID
			event.Actor = &actor
		}
		if err := audit.RecordTx(ctx, tx, event); err != nil {
			return nil, err
		}
		return s.invalidateSettings(ctx, tx, hosted, scope, screenID)
	})
	if err != nil {
		return SettingsDocument{}, err
	}
	s.notify(notes)
	return s.readSettings(ctx, s.db, pluginID, scope, screenID, fields)
}

// invalidateSettings bumps only the manifests a settings change can affect:
// the one screen for a screen setting, and for an organization setting the
// screens that receive one of the plugin's instances. A plugin with its
// own state projector can use organization settings on any screen.
func (s *Service) invalidateSettings(ctx context.Context, tx pgx.Tx, hosted hostedPlugin, scope string, screenID uuid.UUID) ([]note, error) {
	if !hosted.manifest.PlayerFacing() {
		return nil, nil
	}
	reason := "plugin.settings.updated:" + hosted.manifest.ID
	if scope == scopeScreen {
		return bumpScreens(ctx, tx, []uuid.UUID{screenID}, reason)
	}
	if _, ok := hosted.plugin.(plugin.PlayerStateProjector); ok {
		return bumpAllScreens(ctx, tx, reason)
	}
	rows, err := tx.Query(ctx, `SELECT id FROM plugin_instances WHERE plugin_id=$1 AND enabled AND target_scope IS NOT NULL`, hosted.manifest.ID)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	targets := []plugin.Target{}
	for _, id := range ids {
		row := instanceRow{id: id}
		var scopeValue string
		if err := tx.QueryRow(ctx, `SELECT target_scope FROM plugin_instances WHERE id=$1`, id).Scan(&scopeValue); err != nil {
			return nil, err
		}
		row.targetScope = &scopeValue
		if row.targetIDs, err = readTargets(ctx, tx, id); err != nil {
			return nil, err
		}
		targets = append(targets, row.target())
	}
	screens, all, err := resolveTargetScreens(ctx, tx, targets)
	if err != nil {
		return nil, err
	}
	if all {
		return bumpAllScreens(ctx, tx, reason)
	}
	return bumpScreens(ctx, tx, screens, reason)
}

// ReadPluginSecret returns one of a plugin's secrets for secrets.read@1.
// Owner is uuid.Nil for the organization scope.
func (s *Service) ReadPluginSecret(ctx context.Context, pluginID, scope string, ownerID uuid.UUID, key string) (string, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || s.secrets == nil {
		return "", pluginsecrets.ErrUnavailable
	}
	var fields []configschema.Field
	var ownerType string
	switch scope {
	case plugin.ScopeOrganization:
		if hosted.manifest.Settings != nil {
			fields = hosted.manifest.Settings.Organization
		}
		ownerType = pluginsecrets.OwnerOrganization
		id, err := organizationService{service: s}.ID(ctx)
		if err != nil {
			return "", err
		}
		ownerID = id
	case plugin.ScopeScreen:
		if hosted.manifest.Settings != nil {
			fields = hosted.manifest.Settings.Screen
		}
		ownerType = pluginsecrets.OwnerScreen
	case plugin.ScopeInstance:
		var kind string
		if err := s.db.QueryRow(ctx, `SELECT kind FROM plugin_instances WHERE id=$1 AND plugin_id=$2`, ownerID, pluginID).Scan(&kind); err != nil {
			return "", ErrNotFound
		}
		declared, _ := hosted.manifest.InstanceKindByName(kind)
		fields = declared.Fields
		ownerType = pluginsecrets.OwnerInstance
	default:
		return "", plugin.Invalidf("unknown secret scope")
	}
	field, ok := configschema.Lookup(fields, key)
	if !ok || field.Control != configschema.ControlSecret || ownerID == uuid.Nil {
		return "", ErrNotFound
	}
	return s.secrets.Read(ctx, s.db, pluginsecrets.SecretRef{PluginID: pluginID, OwnerType: ownerType, OwnerID: ownerID, Key: key})
}

// ReadPluginSettings returns a plugin's non-secret settings and secret
// states for settings.read@1.
func (s *Service) ReadPluginSettings(ctx context.Context, pluginID, scope string, screenID uuid.UUID) (SettingsDocument, error) {
	_, fields, err := s.settingsFields(pluginID, scope)
	if err != nil {
		return SettingsDocument{}, err
	}
	return s.readSettings(ctx, s.db, pluginID, scope, screenID, fields)
}
