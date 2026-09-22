package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/edge"
)

// Tilecast Edge player and dashboard endpoints (docs/tilecast-edge.md §33).
//
// Player routes authenticate with the existing device bearer credential and
// nothing else; dashboard sessions are never accepted there. A node
// certificate is never accepted as a server credential either: it is mesh
// identity only.

// wireEdgeRevocation makes device credential revocation and replacement
// revoke the screen's Edge certificates in the same transaction, then signs
// the resulting edge.node.revoked changes right away.
func (s *server) wireEdgeRevocation() {
	s.devices.SetCredentialRevocationHooks(devices.CredentialRevocationHooks{
		InTransaction: edge.RevokeScreenCertificates,
		AfterCommit: func(screenID uuid.UUID) {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if _, err := s.edge.Publish(ctx); err != nil && !errors.Is(err, edge.ErrDisabled) {
					s.logger.Warn("edge revocation publication deferred", "screen_id", screenID, "error", err)
				}
			}()
		},
	})
}

const maxEdgeEnrollBytes = 16 * 1024
const maxEdgeStatusBytes = 128 * 1024

func (s *server) edgeAvailable(w http.ResponseWriter) bool {
	if s.edge == nil {
		writeError(w, http.StatusNotFound, "edge_disabled", "Tilecast Edge is not enabled on this server.")
		return false
	}
	if _, err := s.edge.Authority(); err != nil {
		if errors.Is(err, edge.ErrDisabled) {
			writeError(w, http.StatusNotFound, "edge_disabled", "Tilecast Edge is not enabled on this server.")
		} else {
			writeError(w, http.StatusServiceUnavailable, "edge_authority_unavailable",
				"The Tilecast Edge authority is unavailable. Restore the Edge data directory from the same backup as the database.")
		}
		return false
	}
	return true
}

type edgeEnrollRequest struct {
	CSRPEM              string `json:"csrPem"`
	MeshProtocolVersion int    `json:"meshProtocolVersion"`
}

type edgeAuthorityKey struct {
	Epoch     int    `json:"epoch"`
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

type edgeEnrollResponse struct {
	CertificatePEM      string              `json:"certificatePem"`
	CACertificatePEM    string              `json:"caCertificatePem"`
	InstallationID      string              `json:"installationId"`
	ScreenID            string              `json:"screenId"`
	NodeID              string              `json:"nodeId"`
	Authority           edgeAuthorityKey    `json:"authority"`
	MeshProtocolVersion int                 `json:"meshProtocolVersion"`
	NotBefore           time.Time           `json:"notBefore"`
	NotAfter            time.Time           `json:"notAfter"`
	RenewAfter          time.Time           `json:"renewAfter"`
	LatestSequence      int64               `json:"latestSequence"`
	RevocationSnapshot  edge.SignedDocument `json:"revocationSnapshot"`
}

// playerEdgeEnroll issues (or renews) this node's Edge certificate from a CSR
// generated on the node. The private key never leaves the node.
func (s *server) playerEdgeEnroll(w http.ResponseWriter, r *http.Request) {
	if !s.edgeAvailable(w) {
		return
	}
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	var body edgeEnrollRequest
	if err := decodeJSONLimit(w, r, &body, maxEdgeEnrollBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.MeshProtocolVersion != edge.MeshProtocolVersion {
		writeError(w, http.StatusConflict, "edge_protocol_unsupported", "This server does not support the node's mesh protocol version.")
		return
	}
	issued, err := s.edge.Issue(r.Context(), edge.IssueRequest{ScreenID: principal.ScreenID, CredentialID: principal.CredentialID, CSRPEM: body.CSRPEM})
	switch {
	case errors.Is(err, edge.ErrInvalidCSR):
		writeError(w, http.StatusBadRequest, "invalid_certificate_request", "The certificate request is invalid.")
		return
	case errors.Is(err, edge.ErrNodeMismatch):
		writeError(w, http.StatusForbidden, "edge_identity_mismatch", "The certificate request does not match this screen's player.")
		return
	case errors.Is(err, edge.ErrIssuanceLimited):
		writeError(w, http.StatusTooManyRequests, "edge_issuance_limited", "Too many certificates were issued for this screen today.")
		return
	case errors.Is(err, edge.ErrScreenNotEnabled):
		writeError(w, http.StatusForbidden, "screen_disabled", "The screen is disabled.")
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	authority, _ := s.edge.Authority()
	latest, err := s.edge.LatestSequence(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	snapshot, err := s.edge.RevocationSnapshot(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"data": edgeEnrollResponse{
		CertificatePEM:      issued.CertificatePEM,
		CACertificatePEM:    string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: authority.CACertificateDER()})),
		InstallationID:      authority.InstallationID,
		ScreenID:            issued.ScreenID.String(),
		NodeID:              issued.NodeID,
		Authority:           edgeAuthorityKey{Epoch: authority.Epoch, KeyID: authority.KeyID(), PublicKey: base64.RawURLEncoding.EncodeToString(authority.PublicKey())},
		MeshProtocolVersion: edge.MeshProtocolVersion,
		NotBefore:           issued.NotBefore,
		NotAfter:            issued.NotAfter,
		RenewAfter:          issued.RenewAfter,
		LatestSequence:      latest,
		RevocationSnapshot:  snapshot,
	}})
}

// playerEdgeChanges returns signed changes after ?after=, in order.
func (s *server) playerEdgeChanges(w http.ResponseWriter, r *http.Request) {
	if !s.edgeAvailable(w) {
		return
	}
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if err != nil || after < 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "after must be a non-negative integer.")
		return
	}
	limit := edge.MaxChangesPerPage
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > edge.MaxChangesPerPage {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be between 1 and 500.")
			return
		}
	}
	page, err := s.edge.ChangesAfter(r.Context(), after, limit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": page})
}

func (s *server) playerEdgeRevocations(w http.ResponseWriter, r *http.Request) {
	if !s.edgeAvailable(w) {
		return
	}
	snapshot, err := s.edge.RevocationSnapshot(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": snapshot})
}

// playerEdgeStatus records the node's current Edge status projection. It
// does not count as player contact: lastContactAt stays owned by the
// heartbeat and socket, so a broken Edge document can never make an active
// screen look offline (RFC §33.3, §52.2).
func (s *server) playerEdgeStatus(w http.ResponseWriter, r *http.Request) {
	if !s.edgeAvailable(w) {
		return
	}
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	var status edge.NodeStatus
	if err := decodeJSONLimit(w, r, &status, maxEdgeStatusBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	err := s.edge.RecordStatus(r.Context(), principal.ScreenID, status)
	switch {
	case errors.Is(err, edge.ErrNodeMismatch):
		writeError(w, http.StatusForbidden, "edge_identity_mismatch", "This node has no active Edge certificate for this screen.")
		return
	case err != nil && !errors.Is(err, context.Canceled):
		writeError(w, http.StatusBadRequest, "invalid_edge_status", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"accepted": true}})
}

// listEdgeNodes returns the current status projection of enrolled nodes.
func (s *server) listEdgeNodes(w http.ResponseWriter, r *http.Request) {
	if !s.edgeAvailable(w) {
		return
	}
	nodes, err := s.edge.Nodes(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": nodes}})
}
