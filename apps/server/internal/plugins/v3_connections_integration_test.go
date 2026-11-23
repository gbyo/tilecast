package plugins

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleconnections"
)

// Connection records of a Plugin Manifest API 3 plugin: the host owns the
// origin, the consents, and the references, and no general save changes a
// consent.

type connectionEnvironment struct {
	installationEnvironment
	service *Service
}

func withConnections(t *testing.T, run func(connectionEnvironment)) {
	t.Helper()
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, err := env.pool.Exec(env.ctx, `TRUNCATE plugin_secret_deks CASCADE`); err != nil {
			t.Fatal(err)
		}
		ring, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "kek.json"))
		if err != nil {
			t.Fatal(err)
		}
		service := NewService(env.pool, nil, WithPlugins(sampleconnections.New()), WithSecrets(pluginsecrets.NewStore(env.pool, ring, nil)))
		if _, _, err := service.Install(env.ctx, sampleconnections.ID, env.userID); err != nil {
			t.Fatal(err)
		}
		run(connectionEnvironment{installationEnvironment: env, service: service})
	})
}

func apiCode(err error) string {
	var explicit *plugin.APIError
	if errors.As(err, &explicit) {
		return explicit.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func revisionOf(value int64) *int64 { return &value }

func (e connectionEnvironment) create(t *testing.T, definition, name string, origin *string) ConnectionDocument {
	t.Helper()
	document, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: definition, Name: str(name), Origin: origin})
	if err != nil {
		t.Fatalf("create %s: %v", definition, err)
	}
	return document
}

func TestConnectionRecordsAndOrigins(t *testing.T) {
	withConnections(t, func(e connectionEnvironment) {
		fixed := e.create(t, "api", "Example API", nil)
		if fixed.Status != ConnectionReady || fixed.Origin != nil || strings.Join(fixed.Origins, ",") != "https://api.example.com,https://files.example.com" {
			t.Fatalf("fixed = %+v", fixed)
		}
		if fixed.Consents.PrivateNetwork.Available || fixed.Consents.PlainHTTP.Available || fixed.Consents.PlaintextSecret.Available {
			t.Fatalf("a fixed HTTPS connection offers consents: %+v", fixed.Consents)
		}
		// A fixed connection takes no origin; an operator one needs one.
		if _, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: "api", Name: str("x"), Origin: str("https://evil.example")}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("fixed with origin: %v", err)
		}
		if _, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: "lan", Name: str("x")}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("operator without origin: %v", err)
		}
		for _, bad := range []string{"https://gw.lan/path", "https://user@gw.lan", "http://localhost:8080", "ftp://gw.lan", "https://gw.lan?x=1"} {
			if _, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: "lan", Name: str("x"), Origin: str(bad)}); apiCode(err) != "invalid_plugin_connection" {
				t.Fatalf("%s accepted: %v", bad, err)
			}
		}
		// HTTPS-only declarations refuse an http origin.
		if _, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: "private_https", Name: str("x"), Origin: str("http://nas.lan")}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("http on an HTTPS-only connection: %v", err)
		}
		if _, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: "nope", Name: str("x")}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("unknown declaration: %v", err)
		}
		lan := e.create(t, "lan", "Gateway", str("HTTP://Gateway.LAN:80/"))
		if *lan.Origin != "http://gateway.lan" || lan.Status != ReasonPrivateNetworkConsent ||
			strings.Join(lan.Reasons, ",") != ReasonPrivateNetworkConsent+","+ReasonPlainHTTPConsent {
			t.Fatalf("lan = %+v", lan)
		}
		private := e.create(t, "private_https", "NAS", str("https://nas.lan"))
		if private.Status != ConnectionReady || len(private.Notices) != 1 || private.Notices[0] != ReasonPrivateAddressesNotAllowed {
			t.Fatalf("private HTTPS = %+v", private)
		}
		list, err := e.service.ListConnections(e.ctx, sampleconnections.ID)
		if err != nil || len(list) != 3 {
			t.Fatalf("list = %d %v", len(list), err)
		}
		if _, err := e.service.GetConnection(e.ctx, sampleconnections.ID, uuid.New()); apiCode(err) != "plugin_connection_not_found" {
			t.Fatalf("missing = %v", err)
		}
		// Another plugin's ID never reads a record.
		if _, err := e.service.GetConnection(e.ctx, "sample_signs", fixed.ID); !errors.Is(err, ErrPluginNotFound) {
			t.Fatalf("another plugin: %v", err)
		}
	})
}

func TestConsentsAreExplicitLayeredAndBoundToTheDestination(t *testing.T) {
	withConnections(t, func(e connectionEnvironment) {
		lan := e.create(t, "lan", "Gateway", str("http://gateway.lan:8080"))
		consent := func(revision int64, private, plain, plaintext bool) (ConnectionDocument, error) {
			return e.service.SetConsents(e.ctx, sampleconnections.ID, lan.ID, e.userID, ConsentWrite{PrivateNetwork: private, PlainHTTP: plain, PlaintextSecret: plaintext, ExpectedRevision: revisionOf(revision)})
		}
		if _, err := e.service.SetConsents(e.ctx, sampleconnections.ID, lan.ID, e.userID, ConsentWrite{PrivateNetwork: true}); apiCode(err) != "expected_revision_required" {
			t.Fatalf("no revision: %v", err)
		}
		if _, err := consent(lan.Revision, false, true, false); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("plain HTTP without private network: %v", err)
		}
		if _, err := consent(lan.Revision, true, false, true); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("plaintext secret without plain HTTP: %v", err)
		}
		document, err := consent(lan.Revision, true, true, false)
		if err != nil || document.Status != ConnectionReady || !document.Consents.PrivateNetwork.Given || !document.Consents.PlainHTTP.Given || document.Consents.PlaintextSecret.Given {
			t.Fatalf("consents = %+v %v", document, err)
		}
		if _, err := consent(lan.Revision, true, true, true); apiCode(err) != "plugin_connection_revision_conflict" {
			t.Fatalf("stale revision: %v", err)
		}
		document, err = consent(document.Revision, true, true, true)
		if err != nil || !document.Consents.PlaintextSecret.Given {
			t.Fatalf("plaintext consent = %+v %v", document, err)
		}
		// A rename keeps the consents; a new origin clears every one.
		document, err = e.service.UpdateConnection(e.ctx, sampleconnections.ID, lan.ID, e.userID, ConnectionWrite{Name: str("Gateway A"), Origin: str("http://gateway.lan:8080"), ExpectedRevision: revisionOf(document.Revision)})
		if err != nil || !document.Consents.PlainHTTP.Given {
			t.Fatalf("rename = %+v %v", document, err)
		}
		document, err = e.service.UpdateConnection(e.ctx, sampleconnections.ID, lan.ID, e.userID, ConnectionWrite{Name: str("Gateway A"), Origin: str("http://gateway-b.lan:8080"), ExpectedRevision: revisionOf(document.Revision)})
		if err != nil || document.Consents.PrivateNetwork.Given || document.Consents.PlainHTTP.Given || document.Consents.PlaintextSecret.Given || document.Status == ConnectionReady {
			t.Fatalf("new origin kept consents: %+v %v", document, err)
		}
		var private, plain *string
		if err := e.pool.QueryRow(e.ctx, `SELECT private_network_consent_at::text,plain_http_consent_at::text FROM plugin_connections WHERE id=$1`, lan.ID).Scan(&private, &plain); err != nil || private != nil || plain != nil {
			t.Fatalf("stored consents after an origin change: %v %v %v", private, plain, err)
		}
		// A consent given for another declaration applies to nothing, and is
		// cleared rather than revived by the next consent write.
		document, err = consent(document.Revision, true, true, true)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.pool.Exec(e.ctx, `UPDATE plugin_connections SET consent_fingerprint=repeat('0',64) WHERE id=$1`, lan.ID); err != nil {
			t.Fatal(err)
		}
		document, err = e.service.GetConnection(e.ctx, sampleconnections.ID, lan.ID)
		if err != nil || document.Consents.PrivateNetwork.Given || document.Notices[0] != ReasonConsentsNeedConfirmation {
			t.Fatalf("stale consents = %+v %v", document, err)
		}
		document, err = consent(document.Revision, true, false, false)
		if err != nil || !document.Consents.PrivateNetwork.Given || document.Consents.PlainHTTP.Given || document.Consents.PlaintextSecret.Given {
			t.Fatalf("after re-consent = %+v %v", document, err)
		}
		// A declaration without allowPlaintextSecret refuses that consent.
		strict := e.create(t, "lan_strict", "Strict", str("http://strict.lan"))
		if _, err := e.service.SetConsents(e.ctx, sampleconnections.ID, strict.ID, e.userID, ConsentWrite{PrivateNetwork: true, PlainHTTP: true, PlaintextSecret: true, ExpectedRevision: revisionOf(strict.Revision)}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("plaintext consent on a strict declaration: %v", err)
		}
		fixed := e.create(t, "api", "API", nil)
		if _, err := e.service.SetConsents(e.ctx, sampleconnections.ID, fixed.ID, e.userID, ConsentWrite{PrivateNetwork: true, ExpectedRevision: revisionOf(fixed.Revision)}); apiCode(err) != "invalid_plugin_connection" {
			t.Fatalf("private consent on a public declaration: %v", err)
		}
		audit := e.auditText(t, "plugin.connection.consents_changed")
		if !strings.Contains(audit, `"plainHttp": true`) && !strings.Contains(audit, `"plainHttp":true`) {
			t.Fatalf("consent audit = %s", audit)
		}
	})
}

func (e connectionEnvironment) auditText(t *testing.T, action string) string {
	t.Helper()
	rows, err := e.pool.Query(e.ctx, `SELECT coalesce(metadata::text,'') FROM audit_logs WHERE action=$1`, action)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var all strings.Builder
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			t.Fatal(err)
		}
		all.WriteString(text)
	}
	return all.String()
}

func TestConnectionFieldsAndDeletion(t *testing.T) {
	withConnections(t, func(e connectionEnvironment) {
		api := e.create(t, "api", "API", nil)
		lan := e.create(t, "lan", "Gateway", str("http://gateway.lan"))
		// A connection field accepts only a record of a declaration it lists.
		_, err := e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{"primary": lan.ID.String()}, ExpectedRevision: revisionOf(0)})
		if !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("wrong declaration accepted: %v", err)
		}
		_, err = e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{"primary": uuid.NewString()}, ExpectedRevision: revisionOf(0)})
		if !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("missing connection accepted: %v", err)
		}
		_, err = e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{"primary": map[string]any{"origin": "https://evil.example"}}, ExpectedRevision: revisionOf(0)})
		if !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("an origin object accepted: %v", err)
		}
		// Another plugin's record is not this plugin's connection.
		other := uuid.New()
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO plugin_connections(id,organization_id,plugin_id,definition_id,name) VALUES($1,$2,'sample_signs','api','Other')`, other, e.orgID); err != nil {
			t.Fatal(err)
		}
		_, err = e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{"primary": other.String()}, ExpectedRevision: revisionOf(0)})
		if !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("another plugin's connection accepted: %v", err)
		}
		settings, err := e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{"primary": api.ID.String()}, ExpectedRevision: revisionOf(0)})
		if err != nil || settings.Values["primary"] != api.ID.String() {
			t.Fatalf("settings = %+v %v", settings, err)
		}
		enabled := true
		instance, err := e.service.CreateInstance(e.ctx, sampleconnections.ID, "source", e.userID, instanceWrite{Name: str("Lobby"), Enabled: &enabled,
			Configuration: map[string]any{"title": "Lobby", "gateway": lan.ID.String()}})
		if err != nil {
			t.Fatal(err)
		}
		document, _ := e.service.GetConnection(e.ctx, sampleconnections.ID, lan.ID)
		if len(document.References) != 1 || document.References[0].OwnerType != "instance" || document.References[0].FieldKey != "gateway" {
			t.Fatalf("references = %+v", document.References)
		}
		err = e.service.DeleteConnection(e.ctx, sampleconnections.ID, lan.ID, e.userID)
		var explicit *plugin.APIError
		if !errors.As(err, &explicit) || explicit.Code != "plugin_connection_in_use" || len(explicit.Details["references"].([]ConnectionReference)) != 1 {
			t.Fatalf("delete in use = %v", err)
		}
		if err := e.service.DeleteConnection(e.ctx, sampleconnections.ID, api.ID, e.userID); apiCode(err) != "plugin_connection_in_use" {
			t.Fatalf("delete of a settings connection = %v", err)
		}
		// Deleting the instance releases its reference.
		if err := e.service.DeleteInstance(e.ctx, sampleconnections.ID, "source", instance.ID, e.userID); err != nil {
			t.Fatal(err)
		}
		if err := e.service.DeleteConnection(e.ctx, sampleconnections.ID, lan.ID, e.userID); err != nil {
			t.Fatalf("delete after release = %v", err)
		}
		// Clearing the setting releases the other.
		if _, err := e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{}, ExpectedRevision: revisionOf(settings.Revision)}); err != nil {
			t.Fatal(err)
		}
		if err := e.service.DeleteConnection(e.ctx, sampleconnections.ID, api.ID, e.userID); err != nil {
			t.Fatalf("delete after clearing = %v", err)
		}
		// The database refuses a referenced delete even without the check.
		again := e.create(t, "api", "API again", nil)
		if _, err := e.service.UpdateSettings(e.ctx, sampleconnections.ID, scopeOrganization, uuid.Nil, e.userID, SettingsWrite{Values: map[string]any{"primary": again.ID.String()}, ExpectedRevision: revisionOf(settings.Revision + 1)}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.pool.Exec(e.ctx, `DELETE FROM plugin_connections WHERE id=$1`, again.ID); err == nil {
			t.Fatal("the database deleted a referenced connection")
		}
	})
}

func TestConnectionRecordLimit(t *testing.T) {
	withConnections(t, func(e connectionEnvironment) {
		for i := 0; i < MaxConnectionRecords; i++ {
			if _, err := e.pool.Exec(e.ctx, `INSERT INTO plugin_connections(id,organization_id,plugin_id,definition_id,name) VALUES($1,$2,$3,'api','x')`, uuid.New(), e.orgID, sampleconnections.ID); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := e.service.CreateConnection(e.ctx, sampleconnections.ID, e.userID, ConnectionWrite{Definition: "api", Name: str("one more")}); apiCode(err) != "plugin_connection_limit" {
			t.Fatalf("over the limit: %v", err)
		}
	})
}
