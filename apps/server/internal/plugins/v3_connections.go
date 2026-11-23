package plugins

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Host-owned connection records of Plugin Manifest API 3 plugins
// (docs/plugin-connections.md). The manifest declares what a connection may
// do; a record is one configured connection. The host owns the origin of an
// operator connection, the consents, and the references from settings and
// instances. Plugin code names a record by ID through http.fetch@1.

// MaxConnectionRecords bounds the records of one plugin. A record per room
// or per location fits; more is a sign of a loop that creates them.
const MaxConnectionRecords = 50

// Connection status reasons Studio explains. A connection with no blocking
// reason is ready.
const (
	ConnectionReady                  = "ready"
	ReasonOriginRequired             = "origin_required"
	ReasonPrivateNetworkConsent      = "private_network_consent_required"
	ReasonPlainHTTPConsent           = "plain_http_consent_required"
	ReasonDeclarationRemoved         = "declaration_removed"
	ReasonConsentsNeedConfirmation   = "consents_need_confirmation"
	ReasonPrivateAddressesNotAllowed = "private_addresses_need_consent"
	ReasonOAuthClientRequired        = "oauth_client_required"
	ReasonOAuthNotConnected          = "oauth_not_connected"
	ReasonOAuthReconnectRequired     = "oauth_reconnect_required"
	ReasonOAuthRefreshFailing        = "oauth_refresh_failing"
	ReasonOAuthRevocationFailed      = "oauth_revocation_failed"
)

// ConsentState is one consent as the API returns it.
type ConsentState struct {
	// Available is false when the declaration does not make the consent
	// possible. Studio shows no control for it.
	Available bool       `json:"available"`
	Given     bool       `json:"given"`
	GivenAt   *time.Time `json:"givenAt,omitempty"`
	GivenBy   *uuid.UUID `json:"givenBy,omitempty"`
}

// ConnectionConsents are the three separate consents.
type ConnectionConsents struct {
	PrivateNetwork  ConsentState `json:"privateNetwork"`
	PlainHTTP       ConsentState `json:"plainHttp"`
	PlaintextSecret ConsentState `json:"plaintextSecret"`
}

// ConnectionReference is one setting or instance that names a connection.
type ConnectionReference struct {
	OwnerType string    `json:"ownerType"`
	OwnerID   uuid.UUID `json:"ownerId"`
	FieldKey  string    `json:"fieldKey"`
	Label     string    `json:"label"`
}

// ConnectionDocument is one connection record as the API returns it. It
// never holds a credential.
type ConnectionDocument struct {
	ID         uuid.UUID `json:"id"`
	Plugin     string    `json:"plugin"`
	Definition string    `json:"definition"`
	Name       string    `json:"name"`
	// Origin is the configured origin of an operator connection.
	Origin *string `json:"origin,omitempty"`
	// Origins are the approved origins now: the fixed list, or the one
	// configured origin.
	Origins    []string              `json:"origins"`
	Consents   ConnectionConsents    `json:"consents"`
	Status     string                `json:"status"`
	Reasons    []string              `json:"reasons"`
	Notices    []string              `json:"notices"`
	References []ConnectionReference `json:"references"`
	// OAuth is present for an oauth2 connection. It never holds a token or
	// the client secret.
	OAuth     *OAuthState `json:"oauth,omitempty"`
	Revision  int64       `json:"revision"`
	CreatedAt time.Time   `json:"createdAt"`
	UpdatedAt time.Time   `json:"updatedAt"`
}

// ConnectionWrite creates or updates a record. Consents are written only
// through ConsentWrite, never by a general save. ClientID, ClientSecret,
// and ClearClientSecret apply to an oauth2 connection; the client secret is
// write-only.
type ConnectionWrite struct {
	Definition        string  `json:"definition"`
	Name              *string `json:"name"`
	Origin            *string `json:"origin"`
	ClientID          *string `json:"clientId"`
	ClientSecret      *string `json:"clientSecret"`
	ClearClientSecret bool    `json:"clearClientSecret"`
	ExpectedRevision  *int64  `json:"expectedRevision"`
}

// ConsentWrite sets the three consents explicitly. Each member is the
// desired state.
type ConsentWrite struct {
	PrivateNetwork   bool   `json:"privateNetwork"`
	PlainHTTP        bool   `json:"plainHttp"`
	PlaintextSecret  bool   `json:"plaintextSecret"`
	ExpectedRevision *int64 `json:"expectedRevision"`
}

type connectionRow struct {
	id                   uuid.UUID
	pluginID             string
	definition           string
	name                 string
	origin               *string
	fingerprint          *string
	privateAt, plainAt   *time.Time
	privateBy, plainBy   *uuid.UUID
	plaintextAt          *time.Time
	plaintextBy          *uuid.UUID
	revision             int64
	createdAt, updatedAt time.Time
	oauth                oauthColumns
}

// oauthColumns are the OAuth state of an oauth2 connection row.
type oauthColumns struct {
	clientID        *string
	status          *string
	fingerprint     *string
	accessExpiresAt *time.Time
	connectedAt     *time.Time
	connectedBy     *uuid.UUID
	refreshedAt     *time.Time
	lastError       *string
	lastErrorAt     *time.Time
	revocation      *string
	disconnectedAt  *time.Time
}

const connectionColumns = `id,plugin_id,definition_id,name,origin,consent_fingerprint,private_network_consent_at,private_network_consent_by,
	plain_http_consent_at,plain_http_consent_by,plaintext_secret_consent_at,plaintext_secret_consent_by,revision,created_at,updated_at,
	oauth_client_id,oauth_status,oauth_fingerprint,oauth_access_expires_at,oauth_connected_at,oauth_connected_by,oauth_refreshed_at,
	oauth_last_error,oauth_last_error_at,oauth_revocation,oauth_disconnected_at`

func scanConnection(row pgx.Row) (connectionRow, error) {
	var out connectionRow
	o := &out.oauth
	err := row.Scan(&out.id, &out.pluginID, &out.definition, &out.name, &out.origin, &out.fingerprint, &out.privateAt, &out.privateBy,
		&out.plainAt, &out.plainBy, &out.plaintextAt, &out.plaintextBy, &out.revision, &out.createdAt, &out.updatedAt,
		&o.clientID, &o.status, &o.fingerprint, &o.accessExpiresAt, &o.connectedAt, &o.connectedBy, &o.refreshedAt,
		&o.lastError, &o.lastErrorAt, &o.revocation, &o.disconnectedAt)
	return out, err
}

func connectionNotFound() error {
	return &plugin.APIError{Status: http.StatusNotFound, Code: "plugin_connection_not_found", Message: "The connection was not found."}
}

func invalidConnection(format string, args ...any) error {
	return &plugin.APIError{Status: http.StatusBadRequest, Code: "invalid_plugin_connection", Message: fmt.Sprintf(format, args...)}
}

func connectionConflict(current int64) error {
	return &plugin.APIError{Status: http.StatusConflict, Code: "plugin_connection_revision_conflict",
		Message: "Someone else changed this connection. Reload it, then make your change again.",
		Details: map[string]any{"currentRevision": current}}
}

// consentFingerprint binds consents to the declaration's security members
// and the configured origin.
func consentFingerprint(declaration plugin.Connection, origin *string) string {
	value := declaration.SecurityFingerprint() + "\n"
	if origin != nil {
		value += *origin
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// activeConsents reports the consents that apply now. A consent given for a
// different origin or declaration applies to nothing.
type activeConsents struct {
	privateNetwork, plainHTTP, plaintextSecret bool
	stale                                      bool
}

func (row connectionRow) consents(declaration plugin.Connection) activeConsents {
	given := row.privateAt != nil || row.plainAt != nil || row.plaintextAt != nil
	if row.fingerprint == nil || *row.fingerprint != consentFingerprint(declaration, row.origin) {
		return activeConsents{stale: given}
	}
	return activeConsents{
		privateNetwork:  row.privateAt != nil && declaration.AllowsPrivateNetwork(),
		plainHTTP:       row.plainAt != nil && row.privateAt != nil && declaration.AllowsPlainHTTP(),
		plaintextSecret: row.plaintextAt != nil && row.plainAt != nil && declaration.AllowPlaintextSecret,
	}
}

// approvedOrigins returns the origins of a record now.
func (row connectionRow) approvedOrigins(declaration plugin.Connection) []plugin.Origin {
	if declaration.Origins.Operator {
		if row.origin == nil {
			return nil
		}
		origin, err := plugin.ParseCanonicalOrigin(*row.origin)
		if err != nil {
			return nil
		}
		return []plugin.Origin{origin}
	}
	return declaration.FixedOrigins()
}

func (s *Service) connectionDeclaration(pluginID, definition string) (hostedPlugin, plugin.Connection, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return hostedPlugin{}, plugin.Connection{}, ErrPluginNotFound
	}
	declaration, ok := hosted.manifest.ConnectionByID(definition)
	if !ok {
		return hosted, plugin.Connection{}, invalidConnection("This plugin declares no connection %q.", definition)
	}
	return hosted, declaration, nil
}

func (s *Service) documentFor(ctx context.Context, q queryer, hosted hostedPlugin, row connectionRow) (ConnectionDocument, error) {
	document := ConnectionDocument{ID: row.id, Plugin: row.pluginID, Definition: row.definition, Name: row.name, Origin: row.origin,
		Origins: []string{}, Reasons: []string{}, Notices: []string{}, References: []ConnectionReference{},
		Revision: row.revision, CreatedAt: row.createdAt, UpdatedAt: row.updatedAt}
	declaration, declared := hosted.manifest.ConnectionByID(row.definition)
	if !declared {
		document.Status = ReasonDeclarationRemoved
		document.Reasons = append(document.Reasons, ReasonDeclarationRemoved)
	} else {
		for _, origin := range row.approvedOrigins(declaration) {
			document.Origins = append(document.Origins, origin.String())
		}
		active := row.consents(declaration)
		state := func(available, given bool, at *time.Time, by *uuid.UUID) ConsentState {
			out := ConsentState{Available: available, Given: available && given}
			if out.Given {
				out.GivenAt, out.GivenBy = at, by
			}
			return out
		}
		document.Consents = ConnectionConsents{
			PrivateNetwork:  state(declaration.AllowsPrivateNetwork(), active.privateNetwork, row.privateAt, row.privateBy),
			PlainHTTP:       state(declaration.AllowsPlainHTTP(), active.plainHTTP, row.plainAt, row.plainBy),
			PlaintextSecret: state(declaration.AllowPlaintextSecret, active.plaintextSecret, row.plaintextAt, row.plaintextBy),
		}
		if active.stale {
			document.Notices = append(document.Notices, ReasonConsentsNeedConfirmation)
		}
		if declaration.Origins.Operator && row.origin == nil {
			document.Reasons = append(document.Reasons, ReasonOriginRequired)
		}
		if row.origin != nil && strings.HasPrefix(*row.origin, plugin.SchemeHTTP+"://") {
			if !active.privateNetwork {
				document.Reasons = append(document.Reasons, ReasonPrivateNetworkConsent)
			}
			if !active.plainHTTP {
				document.Reasons = append(document.Reasons, ReasonPlainHTTPConsent)
			}
		} else if declaration.AllowsPrivateNetwork() && !active.privateNetwork {
			document.Notices = append(document.Notices, ReasonPrivateAddressesNotAllowed)
		}
		if declaration.IsOAuth() {
			state, err := s.oauthState(ctx, q, row, declaration)
			if err != nil {
				return ConnectionDocument{}, err
			}
			document.OAuth = state
			switch {
			case state.Status == OAuthReconnectRequired:
				document.Reasons = append(document.Reasons, ReasonOAuthReconnectRequired)
			case state.Status != OAuthConnected && (state.ConnectBlocker == ConnectNeedsClientID || state.ConnectBlocker == ConnectNeedsClientSecret):
				document.Reasons = append(document.Reasons, ReasonOAuthClientRequired)
			case state.Status != OAuthConnected:
				document.Reasons = append(document.Reasons, ReasonOAuthNotConnected)
			}
			if state.Status == OAuthConnected && state.LastError != nil {
				document.Notices = append(document.Notices, ReasonOAuthRefreshFailing)
			}
			if state.Revocation != nil && *state.Revocation == "failed" {
				document.Notices = append(document.Notices, ReasonOAuthRevocationFailed)
			}
		}
		document.Status = ConnectionReady
		if len(document.Reasons) > 0 {
			document.Status = document.Reasons[0]
		}
	}
	rows, err := q.Query(ctx, `SELECT owner_type,owner_id,field_key,label FROM plugin_connection_references WHERE connection_id=$1 ORDER BY label,field_key`, row.id)
	if err != nil {
		return ConnectionDocument{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var reference ConnectionReference
		if err := rows.Scan(&reference.OwnerType, &reference.OwnerID, &reference.FieldKey, &reference.Label); err != nil {
			return ConnectionDocument{}, err
		}
		document.References = append(document.References, reference)
	}
	return document, rows.Err()
}

func (s *Service) hostedV3(pluginID string) (hostedPlugin, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || len(hosted.manifest.Connections) == 0 {
		return hostedPlugin{}, ErrPluginNotFound
	}
	return hosted, nil
}

// ListConnections returns a plugin's connection records.
func (s *Service) ListConnections(ctx context.Context, pluginID string) ([]ConnectionDocument, error) {
	hosted, err := s.hostedV3(pluginID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+connectionColumns+` FROM plugin_connections WHERE plugin_id=$1 ORDER BY lower(name),id`, pluginID)
	if err != nil {
		return nil, err
	}
	list := []connectionRow{}
	for rows.Next() {
		row, err := scanConnection(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]ConnectionDocument, 0, len(list))
	for _, row := range list {
		document, err := s.documentFor(ctx, s.db, hosted, row)
		if err != nil {
			return nil, err
		}
		out = append(out, document)
	}
	return out, nil
}

// GetConnection returns one record.
func (s *Service) GetConnection(ctx context.Context, pluginID string, id uuid.UUID) (ConnectionDocument, error) {
	hosted, err := s.hostedV3(pluginID)
	if err != nil {
		return ConnectionDocument{}, err
	}
	row, err := scanConnection(s.db.QueryRow(ctx, `SELECT `+connectionColumns+` FROM plugin_connections WHERE id=$1 AND plugin_id=$2`, id, pluginID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ConnectionDocument{}, connectionNotFound()
	}
	if err != nil {
		return ConnectionDocument{}, err
	}
	return s.documentFor(ctx, s.db, hosted, row)
}

func normalizeConnectionName(value *string) (string, error) {
	if value == nil {
		return "", invalidConnection("Enter a name.")
	}
	name := strings.TrimSpace(*value)
	if count := utf8.RuneCountInString(name); count < 1 || count > 120 {
		return "", invalidConnection("A name has 1 to 120 characters.")
	}
	return name, nil
}

// normalizeConnectionOrigin checks an operator origin against the
// declaration. It returns nil for a fixed-origin declaration.
func normalizeConnectionOrigin(declaration plugin.Connection, value *string) (*string, error) {
	if !declaration.Origins.Operator {
		if value != nil && strings.TrimSpace(*value) != "" {
			return nil, invalidConnection("This connection uses the origins the plugin declares. It takes no origin.")
		}
		return nil, nil
	}
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, invalidConnection("Enter the origin of this connection, for example https://calendar.example.org.")
	}
	origin, err := plugin.ParseOrigin(*value)
	if err != nil {
		return nil, invalidConnection("%s", strings.TrimPrefix(err.Error(), plugin.ErrInvalidOrigin.Error()+": "))
	}
	if origin.Scheme == plugin.SchemeHTTP && !declaration.AllowsPlainHTTP() {
		return nil, invalidConnection("This connection uses HTTPS only.")
	}
	text := origin.String()
	return &text, nil
}

// CreateConnection adds a record.
func (s *Service) CreateConnection(ctx context.Context, pluginID string, userID uuid.UUID, write ConnectionWrite) (ConnectionDocument, error) {
	hosted, declaration, err := s.connectionDeclaration(pluginID, write.Definition)
	if err != nil {
		return ConnectionDocument{}, err
	}
	name, err := normalizeConnectionName(write.Name)
	if err != nil {
		return ConnectionDocument{}, err
	}
	origin, err := normalizeConnectionOrigin(declaration, write.Origin)
	if err != nil {
		return ConnectionDocument{}, err
	}
	organizationID, err := organizationService{service: s}.ID(ctx)
	if err != nil {
		return ConnectionDocument{}, err
	}
	id := uuid.New()
	if _, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		if err := s.lockInstallation(ctx, tx, pluginID); err != nil {
			return nil, err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM plugin_connections WHERE plugin_id=$1`, pluginID).Scan(&count); err != nil {
			return nil, err
		}
		if count >= MaxConnectionRecords {
			return nil, &plugin.APIError{Status: http.StatusConflict, Code: "plugin_connection_limit",
				Message: fmt.Sprintf("A plugin has at most %d connections. Delete one you no longer use.", MaxConnectionRecords)}
		}
		var oauthStatus *string
		if declaration.IsOAuth() {
			value := OAuthNotConnected
			oauthStatus = &value
		} else if write.ClientID != nil || write.ClientSecret != nil || write.ClearClientSecret {
			return nil, invalidConnection("Only an OAuth connection takes a client ID or a client secret.")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO plugin_connections(id,organization_id,plugin_id,definition_id,name,origin,oauth_status,created_by,updated_by)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, id, organizationID, pluginID, declaration.ID, name, origin, oauthStatus, nullableUser(userID)); err != nil {
			return nil, err
		}
		metadata := map[string]any{"definition": declaration.ID, "origin": origin}
		if declaration.IsOAuth() {
			row, err := s.lockConnection(ctx, tx, pluginID, id)
			if err != nil {
				return nil, err
			}
			changes, err := s.writeOAuthClient(ctx, tx, row, declaration, write, userID)
			if err != nil {
				return nil, err
			}
			for key, value := range changes {
				metadata[key] = value
			}
		}
		return nil, s.auditConnection(ctx, tx, "plugin.connection.created", pluginID, id, name, userID, metadata)
	}); err != nil {
		return ConnectionDocument{}, err
	}
	return s.GetConnection(ctx, hosted.manifest.ID, id)
}

// UpdateConnection changes the name or the origin. A changed origin clears
// every consent: a consent for one destination never carries to another.
func (s *Service) UpdateConnection(ctx context.Context, pluginID string, id, userID uuid.UUID, write ConnectionWrite) (ConnectionDocument, error) {
	if _, err := s.hostedV3(pluginID); err != nil {
		return ConnectionDocument{}, err
	}
	if write.ExpectedRevision == nil {
		return ConnectionDocument{}, revisionRequiredError()
	}
	name, err := normalizeConnectionName(write.Name)
	if err != nil {
		return ConnectionDocument{}, err
	}
	if _, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		if err := s.lockInstallation(ctx, tx, pluginID); err != nil {
			return nil, err
		}
		row, err := s.lockConnection(ctx, tx, pluginID, id)
		if err != nil {
			return nil, err
		}
		if row.revision != *write.ExpectedRevision {
			return nil, connectionConflict(row.revision)
		}
		if write.Definition != "" && write.Definition != row.definition {
			return nil, invalidConnection("The declaration of a connection never changes.")
		}
		_, declaration, err := s.connectionDeclaration(pluginID, row.definition)
		if err != nil {
			return nil, err
		}
		origin, err := normalizeConnectionOrigin(declaration, write.Origin)
		if err != nil {
			return nil, err
		}
		originChanged := (origin == nil) != (row.origin == nil) || origin != nil && *origin != *row.origin
		if originChanged {
			_, err = tx.Exec(ctx, `UPDATE plugin_connections SET name=$2,origin=$3,consent_fingerprint=NULL,
				private_network_consent_at=NULL,private_network_consent_by=NULL,plain_http_consent_at=NULL,plain_http_consent_by=NULL,
				plaintext_secret_consent_at=NULL,plaintext_secret_consent_by=NULL,revision=revision+1,updated_by=$4,updated_at=now() WHERE id=$1`,
				id, name, origin, nullableUser(userID))
		} else {
			_, err = tx.Exec(ctx, `UPDATE plugin_connections SET name=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`, id, name, nullableUser(userID))
		}
		if err != nil {
			return nil, err
		}
		metadata := map[string]any{"definition": row.definition, "originChanged": originChanged}
		if declaration.IsOAuth() {
			changes, err := s.writeOAuthClient(ctx, tx, row, declaration, write, userID)
			if err != nil {
				return nil, err
			}
			for key, value := range changes {
				metadata[key] = value
			}
		} else if write.ClientID != nil || write.ClientSecret != nil || write.ClearClientSecret {
			return nil, invalidConnection("Only an OAuth connection takes a client ID or a client secret.")
		}
		if originChanged {
			metadata["origin"] = origin
			metadata["consentsCleared"] = row.privateAt != nil || row.plainAt != nil || row.plaintextAt != nil
		}
		return nil, s.auditConnection(ctx, tx, "plugin.connection.updated", pluginID, id, name, userID, metadata)
	}); err != nil {
		return ConnectionDocument{}, err
	}
	return s.GetConnection(ctx, pluginID, id)
}

// SetConsents writes the three consents. A consent the declaration does not
// make possible is refused. Plain HTTP needs the private network consent,
// and a plaintext secret needs plain HTTP.
func (s *Service) SetConsents(ctx context.Context, pluginID string, id, userID uuid.UUID, write ConsentWrite) (ConnectionDocument, error) {
	if _, err := s.hostedV3(pluginID); err != nil {
		return ConnectionDocument{}, err
	}
	if write.ExpectedRevision == nil {
		return ConnectionDocument{}, revisionRequiredError()
	}
	if write.PlainHTTP && !write.PrivateNetwork {
		return ConnectionDocument{}, invalidConnection("Plain HTTP reaches only private addresses. Allow the private network first.")
	}
	if write.PlaintextSecret && !write.PlainHTTP {
		return ConnectionDocument{}, invalidConnection("A plaintext secret needs plain HTTP. Allow plain HTTP first.")
	}
	if _, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		if err := s.lockInstallation(ctx, tx, pluginID); err != nil {
			return nil, err
		}
		row, err := s.lockConnection(ctx, tx, pluginID, id)
		if err != nil {
			return nil, err
		}
		if row.revision != *write.ExpectedRevision {
			return nil, connectionConflict(row.revision)
		}
		_, declaration, err := s.connectionDeclaration(pluginID, row.definition)
		if err != nil {
			return nil, err
		}
		if write.PrivateNetwork && !declaration.AllowsPrivateNetwork() || write.PlainHTTP && !declaration.AllowsPlainHTTP() ||
			write.PlaintextSecret && !declaration.AllowPlaintextSecret {
			return nil, invalidConnection("This connection's declaration does not allow that consent.")
		}
		if write.PlainHTTP && row.origin == nil {
			return nil, invalidConnection("Enter the origin before you allow plain HTTP.")
		}
		// A stale consent is cleared, never revived by writing the new
		// fingerprint.
		active := row.consents(declaration)
		keep := func(want, current bool, at *time.Time, by *uuid.UUID) (*time.Time, *uuid.UUID) {
			switch {
			case !want:
				return nil, nil
			case current:
				return at, by
			default:
				now := s.clock.Now().UTC()
				return &now, nullableUser(userID)
			}
		}
		privateAt, privateBy := keep(write.PrivateNetwork, active.privateNetwork, row.privateAt, row.privateBy)
		plainAt, plainBy := keep(write.PlainHTTP, active.plainHTTP, row.plainAt, row.plainBy)
		plaintextAt, plaintextBy := keep(write.PlaintextSecret, active.plaintextSecret, row.plaintextAt, row.plaintextBy)
		if _, err := tx.Exec(ctx, `UPDATE plugin_connections SET consent_fingerprint=$2,private_network_consent_at=$3,private_network_consent_by=$4,
			plain_http_consent_at=$5,plain_http_consent_by=$6,plaintext_secret_consent_at=$7,plaintext_secret_consent_by=$8,
			revision=revision+1,updated_by=$9,updated_at=now() WHERE id=$1`,
			id, consentFingerprint(declaration, row.origin), privateAt, privateBy, plainAt, plainBy, plaintextAt, plaintextBy, nullableUser(userID)); err != nil {
			return nil, err
		}
		return nil, s.auditConnection(ctx, tx, "plugin.connection.consents_changed", pluginID, id, row.name, userID, map[string]any{
			"definition": row.definition, "origin": row.origin,
			"privateNetwork": write.PrivateNetwork, "plainHttp": write.PlainHTTP, "plaintextSecret": write.PlaintextSecret,
		})
	}); err != nil {
		return ConnectionDocument{}, err
	}
	return s.GetConnection(ctx, pluginID, id)
}

// DeleteConnection removes an unused record. A record that a setting or an
// instance names is refused with the list of those references.
func (s *Service) DeleteConnection(ctx context.Context, pluginID string, id, userID uuid.UUID) error {
	if _, err := s.hostedV3(pluginID); err != nil {
		return err
	}
	_, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		row, err := s.lockConnection(ctx, tx, pluginID, id)
		if err != nil {
			return nil, err
		}
		hosted, _ := s.hostedPlugin(pluginID)
		document, err := s.documentFor(ctx, tx, hosted, row)
		if err != nil {
			return nil, err
		}
		if len(document.References) > 0 {
			return nil, &plugin.APIError{Status: http.StatusConflict, Code: "plugin_connection_in_use",
				Message: "Settings or instances use this connection. Choose another connection there first.",
				Details: map[string]any{"references": document.References}}
		}
		if row.oauth.status != nil && *row.oauth.status == OAuthConnected {
			return nil, &plugin.APIError{Status: http.StatusConflict, Code: "plugin_connection_connected",
				Message: "Disconnect this connection first, so the provider can revoke Tilecast's access."}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_connections WHERE id=$1`, id); err != nil {
			return nil, err
		}
		return nil, s.auditConnection(ctx, tx, "plugin.connection.deleted", pluginID, id, row.name, userID, map[string]any{"definition": row.definition})
	})
	return err
}

func (s *Service) lockConnection(ctx context.Context, tx pgx.Tx, pluginID string, id uuid.UUID) (connectionRow, error) {
	row, err := scanConnection(tx.QueryRow(ctx, `SELECT `+connectionColumns+` FROM plugin_connections WHERE id=$1 AND plugin_id=$2 FOR UPDATE`, id, pluginID))
	if errors.Is(err, pgx.ErrNoRows) {
		return connectionRow{}, connectionNotFound()
	}
	return row, err
}

func (s *Service) auditConnection(ctx context.Context, tx pgx.Tx, action, pluginID string, id uuid.UUID, name string, userID uuid.UUID, metadata map[string]any) error {
	return s.auditPluginResource(ctx, tx, action, "plugin_connection", pluginID, id, name, userID, metadata)
}

// auditPluginResource writes one audit row about a host-owned plugin
// resource. Work without a human actor names the server as the client.
func (s *Service) auditPluginResource(ctx context.Context, tx pgx.Tx, action, resourceType, pluginID string, id uuid.UUID, name string, userID uuid.UUID, metadata map[string]any) error {
	metadata["pluginId"] = pluginID
	event := audit.Event{Action: action, ResourceType: resourceType, ResourceID: id.String(), ResourceName: name, Metadata: metadata}
	if userID != uuid.Nil {
		actor := userID
		event.Actor = &actor
	}
	if userID == uuid.Nil || audit.SurfaceFrom(ctx) == "" {
		// A refresh or a publication during a plugin hook has no HTTP
		// principal and no human actor: the server is the client.
		event.Surface = audit.SurfaceSystem
		event.ClientID = "tilecast-server"
	}
	return audit.RecordTx(ctx, tx, event)
}

// pluginConfigReferences checks resource identifiers in one plugin's
// settings and instances, connections included.
func (s *Service) pluginConfigReferences(pluginID string) configschema.References {
	return connectionReferences{pluginReferences: pluginReferences{db: s.db}, pluginID: pluginID}
}

type connectionReferences struct {
	pluginReferences
	pluginID string
}

// Connection accepts a record of the same plugin whose declaration the
// field accepts. Writing a setting or an instance already needs
// plugins.manage, the capability that manages connections, so a writer may
// reference any connection of the plugin.
func (r connectionReferences) Connection(ctx context.Context, field configschema.Field, id uuid.UUID) error {
	var definition string
	err := r.db.QueryRow(ctx, `SELECT definition_id FROM plugin_connections WHERE id=$1 AND plugin_id=$2`, id, r.pluginID).Scan(&definition)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%s names a connection that does not exist", field.Label)
	}
	if err != nil {
		return err
	}
	for _, accepted := range field.Connections {
		if accepted == definition {
			return nil
		}
	}
	return fmt.Errorf("%s needs a different kind of connection", field.Label)
}

// useConnections replaces the connection references of one settings row or
// instance. Each named connection is locked FOR SHARE, so a concurrent
// delete waits for this transaction and then sees the reference.
func useConnections(ctx context.Context, tx pgx.Tx, pluginID, ownerType string, ownerID uuid.UUID, label string, fields []configschema.Field, values map[string]any) error {
	if _, err := tx.Exec(ctx, `DELETE FROM plugin_connection_references WHERE owner_type=$1 AND owner_id=$2`, ownerType, ownerID); err != nil {
		return err
	}
	for key, value := range configschema.ConnectionValues(fields, values) {
		id, err := uuid.Parse(value)
		if err != nil {
			return plugin.Invalidf("%s does not identify a connection", key)
		}
		var found uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM plugin_connections WHERE id=$1 AND plugin_id=$2 FOR SHARE`, id, pluginID).Scan(&found); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return plugin.Invalidf("%s names a connection that does not exist", key)
			}
			return err
		}
		settingsID, instanceID := &ownerID, (*uuid.UUID)(nil)
		if ownerType == "instance" {
			settingsID, instanceID = nil, &ownerID
		}
		if _, err := tx.Exec(ctx, `INSERT INTO plugin_connection_references(connection_id,plugin_id,owner_type,owner_id,settings_id,instance_id,field_key,label)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, pluginID, ownerType, ownerID, settingsID, instanceID, key, truncateLabel(label)); err != nil {
			return err
		}
	}
	return nil
}

// ConnectionReview is one declared connection as the install review shows
// it. Every member except the title and description is a security fact.
type ConnectionReview struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Type        string `json:"type"`
	// OperatorOrigin means an Owner or Administrator enters the origin.
	OperatorOrigin bool     `json:"operatorOrigin"`
	Origins        []string `json:"origins"`
	// PrivateNetwork, PlainHTTP, and PlaintextSecret are what the
	// declaration makes possible. Each still needs its own consent.
	PrivateNetwork   bool `json:"privateNetwork"`
	PlainHTTP        bool `json:"plainHttp"`
	PlaintextSecret  bool `json:"plaintextSecret"`
	MaxResponseBytes int  `json:"maxResponseBytes"`
	TimeoutSeconds   int  `json:"timeoutSeconds"`
	// OAuth is the provider side of an oauth2 connection.
	OAuth *OAuthReview `json:"oauth,omitempty"`
}

// OAuthReview is what an install review shows of an OAuth declaration:
// where Tilecast sends the operator and the tokens, and the access it asks
// for.
type OAuthReview struct {
	AuthorizationEndpoint   string   `json:"authorizationEndpoint"`
	TokenEndpoint           string   `json:"tokenEndpoint"`
	RevocationEndpoint      string   `json:"revocationEndpoint,omitempty"`
	Scopes                  []string `json:"scopes"`
	TokenEndpointAuthMethod string   `json:"tokenEndpointAuthMethod"`
}

func connectionReviews(m plugin.Manifest) []ConnectionReview {
	out := []ConnectionReview{}
	for _, connection := range m.Connections {
		out = append(out, ConnectionReview{
			ID: connection.ID, Title: connection.Title, Description: connection.Description, Type: connection.Type,
			OperatorOrigin: connection.Origins.Operator, Origins: append([]string{}, connection.Origins.Fixed...),
			PrivateNetwork: connection.AllowsPrivateNetwork(), PlainHTTP: connection.AllowsPlainHTTP(),
			PlaintextSecret: connection.AllowPlaintextSecret, MaxResponseBytes: connection.ResponseLimit(),
			TimeoutSeconds: connection.Timeout(), OAuth: oauthReview(connection),
		})
	}
	return out
}

func oauthReview(connection plugin.Connection) *OAuthReview {
	if !connection.IsOAuth() {
		return nil
	}
	o := connection.OAuth
	return &OAuthReview{AuthorizationEndpoint: o.AuthorizationEndpoint, TokenEndpoint: o.TokenEndpoint,
		RevocationEndpoint: o.RevocationEndpoint, Scopes: append([]string{}, o.Scopes...), TokenEndpointAuthMethod: o.TokenEndpointAuthMethod}
}
