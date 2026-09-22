package edge

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Node certificates (RFC §11).
//
// A node generates its Ed25519 key locally and sends a CSR. The server never
// sees the private key. The CSR must be signed by that key and must name
// exactly the installation and node the server already knows for the
// authenticated device credential. The server then builds its own template:
// no extension, name or usage requested in the CSR is copied.
//
// Issued certificates carry machine-readable identity as URI SANs:
//
//	urn:tilecast:edge:installation:<installation id>
//	urn:tilecast:edge:node:<player installation id>
//	urn:tilecast:edge:screen:<screen id at issue time>
//	urn:tilecast:edge:purpose:node
//
// and CN = node ID (for Zenoh ACL subjects). A node certificate grants mesh
// membership and read access to peerable objects only; it is never a server
// API credential.

const (
	NodeCertificateValidity = 180 * 24 * time.Hour
	RenewBefore             = 30 * 24 * time.Hour
	MaxCSRBytes             = 8 * 1024
	maxIssuancesPerDay      = 20
)

var (
	ErrInvalidCSR       = errors.New("the certificate request is invalid")
	ErrNodeMismatch     = errors.New("the certificate request names a different node")
	ErrIssuanceLimited  = errors.New("too many certificates were issued for this screen today")
	ErrScreenNotEnabled = errors.New("the screen is not active")
)

type IssueRequest struct {
	ScreenID     uuid.UUID
	CredentialID uuid.UUID
	CSRPEM       string
}

type IssuedCertificate struct {
	CertificatePEM string
	NodeID         string
	ScreenID       uuid.UUID
	Serial         string
	Fingerprint    string
	NotBefore      time.Time
	NotAfter       time.Time
	RenewAfter     time.Time
}

// parseCSR validates the request and returns the node public key and the
// identity it claims.
func parseCSR(csrPEM string) (ed25519.PublicKey, map[string]string, string, error) {
	if len(csrPEM) == 0 || len(csrPEM) > MaxCSRBytes {
		return nil, nil, "", ErrInvalidCSR
	}
	block, rest := pem.Decode([]byte(csrPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, nil, "", ErrInvalidCSR
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		return nil, nil, "", ErrInvalidCSR
	}
	public, ok := csr.PublicKey.(ed25519.PublicKey)
	if !ok || len(csr.DNSNames) > 0 || len(csr.IPAddresses) > 0 || len(csr.EmailAddresses) > 0 {
		return nil, nil, "", ErrInvalidCSR
	}
	claims := map[string]string{}
	for _, uri := range csr.URIs {
		value := uri.String()
		if !strings.HasPrefix(value, edgeURNPrefix) {
			return nil, nil, "", ErrInvalidCSR
		}
		kind, id, found := strings.Cut(strings.TrimPrefix(value, edgeURNPrefix), ":")
		if !found || claims[kind] != "" {
			return nil, nil, "", ErrInvalidCSR
		}
		claims[kind] = id
	}
	return public, claims, csr.Subject.CommonName, nil
}

// Issue validates the CSR against the authenticated screen and signs a node
// certificate, recording only public metadata.
func (s *Service) Issue(ctx context.Context, request IssueRequest) (IssuedCertificate, error) {
	authority, err := s.Authority()
	if err != nil {
		return IssuedCertificate{}, err
	}
	public, claims, commonName, err := parseCSR(request.CSRPEM)
	if err != nil {
		return IssuedCertificate{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return IssuedCertificate{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var nodeID string
	var enabled bool
	var archived bool
	if err := tx.QueryRow(ctx, `SELECT player_installation_id,enabled,archived_at IS NOT NULL FROM screens WHERE id=$1 FOR UPDATE`, request.ScreenID).
		Scan(&nodeID, &enabled, &archived); err != nil {
		return IssuedCertificate{}, fmt.Errorf("load screen: %w", err)
	}
	if !enabled || archived {
		return IssuedCertificate{}, ErrScreenNotEnabled
	}
	if _, err := uuid.Parse(nodeID); err != nil || strings.ToLower(nodeID) != nodeID {
		return IssuedCertificate{}, ErrNodeMismatch
	}
	if len(claims) != 2 || claims["installation"] != authority.InstallationID || claims["node"] != nodeID || commonName != nodeID {
		return IssuedCertificate{}, ErrNodeMismatch
	}
	var issuedToday int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM edge_node_certificates WHERE screen_id=$1 AND created_at > now() - interval '1 day'`, request.ScreenID).
		Scan(&issuedToday); err != nil {
		return IssuedCertificate{}, err
	}
	if issuedToday >= maxIssuancesPerDay {
		return IssuedCertificate{}, ErrIssuanceLimited
	}

	serial, err := randomSerial()
	if err != nil {
		return IssuedCertificate{}, err
	}
	now := s.now().UTC().Truncate(time.Second)
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: nodeID},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.Add(NodeCertificateValidity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		URIs: []*url.URL{
			edgeURN("installation", authority.InstallationID),
			edgeURN("node", nodeID),
			edgeURN("screen", request.ScreenID.String()),
			mustURL(purposeNodeURN),
		},
		BasicConstraintsValid: true,
		IsCA:                  false,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, authority.caCert, public, authority.caKey)
	if err != nil {
		return IssuedCertificate{}, fmt.Errorf("sign node certificate: %w", err)
	}
	certificateSum := sha256.Sum256(der)
	keySum := sha256.Sum256(public)
	issued := IssuedCertificate{
		CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		NodeID:         nodeID,
		ScreenID:       request.ScreenID,
		Serial:         serial.Text(16),
		Fingerprint:    hex.EncodeToString(certificateSum[:]),
		NotBefore:      template.NotBefore,
		NotAfter:       template.NotAfter,
		RenewAfter:     template.NotAfter.Add(-RenewBefore),
	}
	if _, err := tx.Exec(ctx, `INSERT INTO edge_node_certificates(id,screen_id,credential_id,node_id,serial_number,public_key_fingerprint,certificate_fingerprint,not_before,not_after)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, uuid.New(), request.ScreenID, request.CredentialID, nodeID, issued.Serial,
		hex.EncodeToString(keySum[:]), issued.Fingerprint, issued.NotBefore, issued.NotAfter); err != nil {
		return IssuedCertificate{}, fmt.Errorf("record node certificate: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,action,resource_type,resource_id) VALUES($1,'edge.certificate.issued','screen',$2)`, uuid.New(), request.ScreenID); err != nil {
		return IssuedCertificate{}, fmt.Errorf("audit certificate issuance: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return IssuedCertificate{}, err
	}
	return issued, nil
}

// RevokeScreenCertificates revokes the Edge certificates of a screen whose
// device credential was revoked or replaced, and queues a signed
// edge.node.revoked change for each affected node. It runs inside the
// caller's transaction (devices.Service revocation paths), so a credential
// can never be revoked while its Edge identity stays valid. keep, when set,
// is the credential that remains active (certificates bound to it survive).
func RevokeScreenCertificates(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, keep *uuid.UUID, reason string) error {
	rows, err := tx.Query(ctx, `UPDATE edge_node_certificates SET revoked_at=now(),revocation_reason=$3
		WHERE screen_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR credential_id IS DISTINCT FROM $2::uuid)
		RETURNING node_id`, screenID, keep, reason)
	if err != nil {
		return fmt.Errorf("revoke edge certificates: %w", err)
	}
	nodes := map[string]bool{}
	for rows.Next() {
		var node string
		if err := rows.Scan(&node); err != nil {
			rows.Close()
			return err
		}
		nodes[node] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for node := range nodes {
		var expiresAt time.Time
		if err := tx.QueryRow(ctx, `SELECT max(not_after) FROM edge_node_certificates WHERE node_id=$1`, node).Scan(&expiresAt); err != nil {
			return err
		}
		var generation int64
		if err := tx.QueryRow(ctx, `INSERT INTO edge_revocation_state(singleton,generation) VALUES(TRUE,1)
			ON CONFLICT(singleton) DO UPDATE SET generation=edge_revocation_state.generation+1 RETURNING generation`).Scan(&generation); err != nil {
			return err
		}
		payload := map[string]any{
			"nodeId":               node,
			"screenId":             screenID.String(),
			"certificatesExpireAt": expiresAt.UTC().Format(time.RFC3339),
		}
		if err := AppendChange(ctx, tx, Change{
			Type:       "edge.node.revoked",
			TargetKind: "node",
			TargetID:   uuidPointer(node),
			Payload:    payload,
			ExpiresAt:  &expiresAt,
		}); err != nil {
			return err
		}
	}
	return nil
}

func uuidPointer(value string) *uuid.UUID {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return nil
	}
	return &parsed
}
