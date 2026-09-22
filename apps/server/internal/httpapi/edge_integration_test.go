package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/edge"
)

// End-to-end Tilecast Edge trust tests through the real handlers and the
// device-credential middleware, against PostgreSQL.

type edgeEnv struct {
	activityTestEnvironment
	root       string
	nodeID     string
	credential string
	nodeKey    ed25519.PrivateKey
}

func withEdgeDatabase(t *testing.T, run func(edgeEnv)) {
	t.Helper()
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		if _, err := env.pool.Exec(ctx, `TRUNCATE edge_authority, edge_changes, edge_change_outbox, edge_revocation_state, edge_node_status CASCADE`); err != nil {
			t.Fatal(err)
		}
		nodeID := uuid.NewString()
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET player_installation_id=$2, platform='linux', enabled=TRUE WHERE id=$1`, env.screenID, nodeID); err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(t.TempDir(), "edge")
		service := edge.NewService(env.pool, root, nil)
		if err := service.Initialize(ctx); err != nil {
			t.Fatalf("initialize edge authority: %v", err)
		}
		env.server.edge = service
		env.server.wireEdgeRevocation()
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		run(edgeEnv{activityTestEnvironment: env, root: root, nodeID: nodeID, credential: testDeviceCredential(t, env, env.screenID), nodeKey: key})
	})
}

func installationID(t *testing.T, env edgeEnv) string {
	t.Helper()
	var id string
	if err := env.pool.QueryRow(context.Background(), `SELECT installation_id FROM organization_settings`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func edgeCSR(t *testing.T, key ed25519.PrivateKey, commonName string, uris ...string) string {
	t.Helper()
	parsed := make([]*url.URL, 0, len(uris))
	for _, value := range uris {
		u, err := url.Parse(value)
		if err != nil {
			t.Fatal(err)
		}
		parsed = append(parsed, u)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: commonName}, URIs: parsed}, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}))
}

func (env edgeEnv) validCSR(t *testing.T) string {
	return edgeCSR(t, env.nodeKey, env.nodeID,
		"urn:tilecast:edge:installation:"+installationID(t, env), "urn:tilecast:edge:node:"+env.nodeID)
}

func (env edgeEnv) player(t *testing.T, method, path string, body any, handler http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if env.credential != "" {
		request.Header.Set("Authorization", "Bearer "+env.credential)
	}
	response := httptest.NewRecorder()
	env.server.requireDevice(handler).ServeHTTP(response, request)
	return response
}

type enrollData struct {
	Data struct {
		CertificatePEM   string `json:"certificatePem"`
		CACertificatePEM string `json:"caCertificatePem"`
		InstallationID   string `json:"installationId"`
		ScreenID         string `json:"screenId"`
		NodeID           string `json:"nodeId"`
		Authority        struct {
			Epoch     int    `json:"epoch"`
			KeyID     string `json:"keyId"`
			PublicKey string `json:"publicKey"`
		} `json:"authority"`
		RenewAfter         time.Time           `json:"renewAfter"`
		NotAfter           time.Time           `json:"notAfter"`
		LatestSequence     int64               `json:"latestSequence"`
		RevocationSnapshot edge.SignedDocument `json:"revocationSnapshot"`
	} `json:"data"`
}

func parsePEMCertificate(t *testing.T, text string) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode([]byte(text))
	if block == nil {
		t.Fatalf("not PEM: %q", text)
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

func TestEdgeEnrollmentIssuesInstallationScopedCertificate(t *testing.T) {
	withEdgeDatabase(t, func(env edgeEnv) {
		response := env.player(t, http.MethodPost, "/api/v1/player/edge/enroll",
			map[string]any{"csrPem": env.validCSR(t), "meshProtocolVersion": 1}, env.server.playerEdgeEnroll)
		if response.Code != http.StatusOK {
			t.Fatalf("enroll status=%d body=%s", response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("enrollment response must be no-store")
		}
		if strings.Contains(response.Body.String(), "PRIVATE KEY") {
			t.Fatal("enrollment response must never contain private key material")
		}
		var data enrollData
		if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		certificate := parsePEMCertificate(t, data.Data.CertificatePEM)
		ca := parsePEMCertificate(t, data.Data.CACertificatePEM)
		roots := x509.NewCertPool()
		roots.AddCert(ca)
		if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
			t.Fatalf("node certificate does not chain to the installation CA: %v", err)
		}
		if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
			t.Fatalf("node certificate is not valid for serving: %v", err)
		}
		if !bytes.Equal(certificate.PublicKey.(ed25519.PublicKey), env.nodeKey.Public().(ed25519.PublicKey)) {
			t.Fatal("certificate must certify the node's own key")
		}
		want := map[string]bool{
			"urn:tilecast:edge:installation:" + installationID(t, env): true,
			"urn:tilecast:edge:node:" + env.nodeID:                     true,
			"urn:tilecast:edge:screen:" + env.screenID.String():        true,
			"urn:tilecast:edge:purpose:node":                           true,
		}
		if len(certificate.URIs) != len(want) {
			t.Fatalf("unexpected SANs %v", certificate.URIs)
		}
		for _, uri := range certificate.URIs {
			if !want[uri.String()] {
				t.Fatalf("unexpected SAN %s", uri)
			}
		}
		if certificate.Subject.CommonName != env.nodeID || certificate.IsCA || len(certificate.DNSNames) != 0 {
			t.Fatalf("unexpected certificate identity %+v", certificate.Subject)
		}
		if got := certificate.NotAfter.Sub(certificate.NotBefore); got < 179*24*time.Hour || got > 181*24*time.Hour {
			t.Fatalf("validity %s is not 180 days", got)
		}
		if data.Data.RenewAfter.After(data.Data.NotAfter.Add(-29 * 24 * time.Hour)) {
			t.Fatal("renewal must start 30 days before expiry")
		}
		authority, _ := env.server.edge.Authority()
		public, _ := base64.RawURLEncoding.DecodeString(data.Data.Authority.PublicKey)
		if !bytes.Equal(public, authority.PublicKey()) || data.Data.Authority.KeyID != authority.KeyID() {
			t.Fatal("enrollment must pin the Edge authority key")
		}
		if bytes.Equal(public, ca.PublicKey.(ed25519.PublicKey)) {
			t.Fatal("the authority signing key must differ from the CA key")
		}
		if _, err := edge.Verify(data.Data.RevocationSnapshot, edge.PurposeServerSnapshot, authority.PublicKey()); err != nil {
			t.Fatalf("revocation snapshot must be signed: %v", err)
		}
		var stored int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM edge_node_certificates WHERE screen_id=$1 AND node_id=$2`, env.screenID, env.nodeID).Scan(&stored); err != nil || stored != 1 {
			t.Fatalf("stored certificates=%d err=%v", stored, err)
		}
	})
}

func TestEdgeEnrollmentRejectsForeignIdentitiesAndCredentials(t *testing.T) {
	withEdgeDatabase(t, func(env edgeEnv) {
		installation := installationID(t, env)
		otherNode := uuid.NewString()
		cases := []struct {
			name string
			csr  string
			code int
		}{
			{"another node", edgeCSR(t, env.nodeKey, otherNode, "urn:tilecast:edge:installation:"+installation, "urn:tilecast:edge:node:"+otherNode), http.StatusForbidden},
			{"another installation", edgeCSR(t, env.nodeKey, env.nodeID, "urn:tilecast:edge:installation:"+uuid.NewString(), "urn:tilecast:edge:node:"+env.nodeID), http.StatusForbidden},
			{"extra identity claim", edgeCSR(t, env.nodeKey, env.nodeID, "urn:tilecast:edge:installation:"+installation, "urn:tilecast:edge:node:"+env.nodeID, "urn:tilecast:edge:screen:"+uuid.NewString()), http.StatusForbidden},
			{"foreign URI", edgeCSR(t, env.nodeKey, env.nodeID, "urn:tilecast:edge:installation:"+installation, "urn:tilecast:edge:node:"+env.nodeID, "https://example.org"), http.StatusBadRequest},
			{"not a CSR", "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n", http.StatusBadRequest},
			{"oversized", strings.Repeat("A", edge.MaxCSRBytes+1), http.StatusBadRequest},
		}
		for _, c := range cases {
			response := env.player(t, http.MethodPost, "/api/v1/player/edge/enroll", map[string]any{"csrPem": c.csr, "meshProtocolVersion": 1}, env.server.playerEdgeEnroll)
			if response.Code != c.code {
				t.Fatalf("%s: status=%d body=%s", c.name, response.Code, response.Body.String())
			}
		}
		// Unknown request fields and unsupported mesh versions fail closed.
		response := env.player(t, http.MethodPost, "/api/v1/player/edge/enroll", map[string]any{"csrPem": env.validCSR(t), "meshProtocolVersion": 1, "privateKey": "x"}, env.server.playerEdgeEnroll)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("unknown field status=%d", response.Code)
		}
		response = env.player(t, http.MethodPost, "/api/v1/player/edge/enroll", map[string]any{"csrPem": env.validCSR(t), "meshProtocolVersion": 2}, env.server.playerEdgeEnroll)
		if response.Code != http.StatusConflict {
			t.Fatalf("mesh version status=%d", response.Code)
		}
		// Without the device bearer credential nothing is issued.
		env.credential = ""
		response = env.player(t, http.MethodPost, "/api/v1/player/edge/enroll", map[string]any{"csrPem": env.validCSR(t), "meshProtocolVersion": 1}, env.server.playerEdgeEnroll)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("missing credential status=%d", response.Code)
		}
	})
}

func TestCredentialRevocationRevokesEdgeIdentityAndPublishesSignedChain(t *testing.T) {
	withEdgeDatabase(t, func(env edgeEnv) {
		ctx := context.Background()
		enroll := env.player(t, http.MethodPost, "/api/v1/player/edge/enroll", map[string]any{"csrPem": env.validCSR(t), "meshProtocolVersion": 1}, env.server.playerEdgeEnroll)
		if enroll.Code != http.StatusOK {
			t.Fatalf("enroll status=%d body=%s", enroll.Code, enroll.Body.String())
		}
		// A second, unrelated change first, so the revocation links to it.
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := edge.AppendChange(ctx, tx, edge.Change{Type: "screen.configuration.changed", TargetKind: "screen", TargetID: &env.screenID}); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if n, err := env.server.edge.Publish(ctx); err != nil || n != 1 {
			t.Fatalf("publish n=%d err=%v", n, err)
		}
		if err := env.server.devices.Revoke(ctx, env.screenID, env.owner.User.ID, "Stolen display"); err != nil {
			t.Fatal(err)
		}
		var active int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM edge_node_certificates WHERE screen_id=$1 AND revoked_at IS NULL`, env.screenID).Scan(&active); err != nil || active != 0 {
			t.Fatalf("active certificates after revocation=%d err=%v", active, err)
		}
		// The after-commit publisher runs asynchronously; publishing again is
		// idempotent and serializes with it.
		deadline := time.Now().Add(5 * time.Second)
		var page edge.ChangePage
		for time.Now().Before(deadline) {
			if _, err := env.server.edge.Publish(ctx); err != nil {
				t.Fatal(err)
			}
			if page, err = env.server.edge.ChangesAfter(ctx, 0, 100); err != nil {
				t.Fatal(err)
			}
			if len(page.Items) == 2 {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if len(page.Items) != 2 {
			t.Fatalf("changes=%d", len(page.Items))
		}
		authority, _ := env.server.edge.Authority()
		var previous int64
		for index, raw := range page.Items {
			var document edge.SignedDocument
			if err := json.Unmarshal(raw, &document); err != nil {
				t.Fatal(err)
			}
			body, err := edge.Verify(document, edge.PurposeServerChange, authority.PublicKey())
			if err != nil {
				t.Fatalf("change %d does not verify: %v", index, err)
			}
			sequence, _ := body["sequence"].(json.Number).Int64()
			prev, _ := body["previousSequence"].(json.Number).Int64()
			if prev != previous || sequence <= previous {
				t.Fatalf("change %d links %d -> %d after %d", index, prev, sequence, previous)
			}
			previous = sequence
			if index == 1 {
				if body["type"] != "edge.node.revoked" || body["installationId"] != installationID(t, env) {
					t.Fatalf("unexpected revocation body %v", body)
				}
				payload := body["payload"].(map[string]any)
				if payload["nodeId"] != env.nodeID {
					t.Fatalf("revocation names %v", payload["nodeId"])
				}
				if generation, _ := body["revocationGeneration"].(json.Number).Int64(); generation < 1 {
					t.Fatal("revocation must advance the generation")
				}
			}
		}
		if page.LatestSequence != previous {
			t.Fatalf("latest=%d chain end=%d", page.LatestSequence, previous)
		}
		snapshot, err := env.server.edge.RevocationSnapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		body, err := edge.Verify(snapshot, edge.PurposeServerSnapshot, authority.PublicKey())
		if err != nil {
			t.Fatal(err)
		}
		revoked := body["revoked"].([]any)
		if len(revoked) != 1 || revoked[0].(map[string]any)["nodeId"] != env.nodeID {
			t.Fatalf("snapshot must list the revoked node: %v", revoked)
		}
		// A revoked credential can no longer reach any Edge endpoint.
		changes := env.player(t, http.MethodGet, "/api/v1/player/edge/changes?after=0", nil, env.server.playerEdgeChanges)
		if changes.Code != http.StatusUnauthorized {
			t.Fatalf("revoked credential status=%d", changes.Code)
		}
	})
}

func TestEdgeStatusIsBoundedAndNeverCountsAsContact(t *testing.T) {
	withEdgeDatabase(t, func(env edgeEnv) {
		ctx := context.Background()
		status := map[string]any{
			"schemaVersion": 1, "edgeVersion": "0.1.0", "nodeId": env.nodeID,
			"renderer": map[string]any{"kind": "wpe", "version": "0.1.0", "state": "healthy"},
			"mesh":     map[string]any{"state": "disabled", "peerCount": 0},
			"capabilities": map[string]any{"schema": 1, "revision": 3, "generatedAt": "2026-09-22T19:00:00Z", "capabilities": []any{
				map[string]any{"id": "renderer.wpe.drm", "state": "blocked", "provider": "wpe", "reasonCode": "drm_permission_denied", "observedAt": "2026-09-22T19:00:00Z"},
			}},
		}
		// Not enrolled yet: rejected.
		response := env.player(t, http.MethodPost, "/api/v1/player/edge/status", status, env.server.playerEdgeStatus)
		if response.Code != http.StatusForbidden {
			t.Fatalf("unenrolled status=%d", response.Code)
		}
		if enroll := env.player(t, http.MethodPost, "/api/v1/player/edge/enroll", map[string]any{"csrPem": env.validCSR(t), "meshProtocolVersion": 1}, env.server.playerEdgeEnroll); enroll.Code != http.StatusOK {
			t.Fatalf("enroll status=%d", enroll.Code)
		}
		var before *time.Time
		_ = env.pool.QueryRow(ctx, `SELECT last_heartbeat_at FROM screens WHERE id=$1`, env.screenID).Scan(&before)
		response = env.player(t, http.MethodPost, "/api/v1/player/edge/status", status, env.server.playerEdgeStatus)
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var after *time.Time
		_ = env.pool.QueryRow(ctx, `SELECT last_heartbeat_at FROM screens WHERE id=$1`, env.screenID).Scan(&after)
		if (before == nil) != (after == nil) || (before != nil && !before.Equal(*after)) {
			t.Fatal("Edge status must not update the screen's contact time")
		}
		nodes, err := env.server.edge.Nodes(ctx)
		if err != nil || len(nodes) != 1 || nodes[0].CapabilityRevision != 3 {
			t.Fatalf("nodes=%+v err=%v", nodes, err)
		}
		// An invalid capability is rejected outright.
		status["capabilities"].(map[string]any)["capabilities"] = []any{map[string]any{"id": "platform.linux", "state": "available", "observedAt": "2026-09-22T19:00:00Z"}}
		response = env.player(t, http.MethodPost, "/api/v1/player/edge/status", status, env.server.playerEdgeStatus)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid capability status=%d", response.Code)
		}
	})
}

func TestEdgeAuthorityIsNeverSilentlyRegenerated(t *testing.T) {
	withEdgeDatabase(t, func(env edgeEnv) {
		ctx := context.Background()
		first, _ := env.server.edge.Authority()
		again, err := edge.LoadOrInitAuthority(ctx, env.pool, env.root)
		if err != nil || !bytes.Equal(again.PublicKey(), first.PublicKey()) || again.CAFingerprint() != first.CAFingerprint() {
			t.Fatalf("reload changed the authority: %v", err)
		}
		for _, name := range []string{"authority.key", "ca.key"} {
			info, err := os.Stat(filepath.Join(env.root, name))
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("%s mode=%v err=%v", name, info.Mode(), err)
			}
		}
		// Files lost while the database still pins the identity: refuse.
		moved := env.root + ".moved"
		if err := os.Rename(env.root, moved); err != nil {
			t.Fatal(err)
		}
		if _, err := edge.LoadOrInitAuthority(ctx, env.pool, env.root); !errors.Is(err, edge.ErrAuthorityMissing) {
			t.Fatalf("missing files must be a recovery condition, got %v", err)
		}
		// Row lost but files kept: the row is recreated from the files.
		if err := os.RemoveAll(env.root); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(moved, env.root); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `DELETE FROM edge_authority`); err != nil {
			t.Fatal(err)
		}
		restored, err := edge.LoadOrInitAuthority(ctx, env.pool, env.root)
		if err != nil || !bytes.Equal(restored.PublicKey(), first.PublicKey()) {
			t.Fatalf("row recreation failed: %v", err)
		}
	})
}
