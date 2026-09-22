// Package edge is the Tilecast Server side of Tilecast Edge
// (docs/tilecast-edge.md): the Edge authority and installation CA, node
// certificate issuance and revocation, the signed change feed, signed
// snapshots, and the current node status projection.
//
// The server remains the only authority. Everything this package produces
// for nodes is either signed by the Edge authority key or delivered over the
// authenticated player API; nodes relay signed documents but never originate
// authoritative state.
package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrDisabled = errors.New("tilecast edge is not enabled on this server")

// MeshProtocolVersion is the mesh protocol version this server issues
// certificates for (edge_protocol::MESH_PROTOCOL_VERSION).
const MeshProtocolVersion = 1

type Service struct {
	db     *pgxpool.Pool
	root   string
	logger *slog.Logger
	now    func() time.Time

	mu           sync.RWMutex
	authority    *Authority
	authorityErr error
}

func NewService(db *pgxpool.Pool, root string, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{db: db, root: root, logger: logger, now: time.Now, authorityErr: ErrDisabled}
}

// Initialize loads or creates the Edge authority. A failure is kept and
// reported by every Edge endpoint; the rest of the server keeps running.
func (s *Service) Initialize(ctx context.Context) error {
	authority, err := LoadOrInitAuthority(ctx, s.db, s.root)
	s.mu.Lock()
	s.authority, s.authorityErr = authority, err
	s.mu.Unlock()
	if err != nil {
		s.logger.Error("edge authority unavailable", "error", err)
		return err
	}
	s.logger.Info("edge authority ready", "authority_key", authority.KeyID()[:19], "ca", authority.CAFingerprint()[:12])
	return nil
}

func (s *Service) Authority() (*Authority, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.authority == nil {
		return nil, s.authorityErr
	}
	return s.authority, nil
}

// RevocationSnapshot signs the current set of revoked nodes whose
// certificates have not all expired. Nodes adopt it at enrollment and on
// feed gaps older than retention, so a node that enrolls after a revocation
// still rejects the revoked peer.
func (s *Service) RevocationSnapshot(ctx context.Context) (SignedDocument, error) {
	authority, err := s.Authority()
	if err != nil {
		return SignedDocument{}, err
	}
	rows, err := s.db.Query(ctx, `SELECT node_id, max(not_after) FROM edge_node_certificates
		GROUP BY node_id
		HAVING bool_or(revoked_at IS NOT NULL) AND max(not_after) > now()
		ORDER BY node_id LIMIT 10000`)
	if err != nil {
		return SignedDocument{}, err
	}
	revoked := []any{}
	for rows.Next() {
		var node string
		var expires time.Time
		if err := rows.Scan(&node, &expires); err != nil {
			rows.Close()
			return SignedDocument{}, err
		}
		revoked = append(revoked, map[string]any{"nodeId": node, "certificatesExpireAt": expires.UTC().Truncate(time.Second).Format(time.RFC3339)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return SignedDocument{}, err
	}
	var generation, sequence int64
	if err := s.db.QueryRow(ctx, `SELECT COALESCE((SELECT generation FROM edge_revocation_state WHERE singleton=TRUE),0),
		COALESCE((SELECT max(sequence) FROM edge_changes),0)`).Scan(&generation, &sequence); err != nil {
		return SignedDocument{}, err
	}
	body := map[string]any{
		"schema":         int64(1),
		"installationId": authority.InstallationID,
		"authorityEpoch": int64(authority.Epoch),
		"type":           "edge.revocation.snapshot",
		"asOfSequence":   sequence,
		"generation":     generation,
		"issuedAt":       s.now().UTC().Truncate(time.Second).Format(time.RFC3339),
		"revoked":        revoked,
	}
	document, _, err := Sign(authority.signingKey, PurposeServerSnapshot, body)
	return document, err
}

// ---------------------------------------------------------------- status

var capabilityIDPattern = regexp.MustCompile(`^(renderer|video|mesh|time|display|audio|input|network|system|external_presentation)(\.[a-z0-9_]+){1,5}$`)
var tokenPattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)

var capabilityStates = map[string]bool{"supported": true, "available": true, "degraded": true, "blocked": true, "unsupported": true}

type Capability struct {
	ID              string          `json:"id"`
	State           string          `json:"state"`
	Provider        string          `json:"provider,omitempty"`
	ProviderVersion string          `json:"providerVersion,omitempty"`
	ReasonCode      string          `json:"reasonCode,omitempty"`
	Detail          string          `json:"detail,omitempty"`
	ObservedAt      time.Time       `json:"observedAt"`
	Attributes      json.RawMessage `json:"attributes,omitempty"`
}

type CapabilitySnapshot struct {
	Schema       int          `json:"schema"`
	Revision     int64        `json:"revision"`
	GeneratedAt  time.Time    `json:"generatedAt"`
	Capabilities []Capability `json:"capabilities"`
}

type StatusRenderer struct {
	Kind    string `json:"kind,omitempty"`
	Version string `json:"version,omitempty"`
	State   string `json:"state"`
}

type StatusMesh struct {
	State     string `json:"state"`
	PeerCount int    `json:"peerCount"`
}

type StatusCache struct {
	UsedBytes  int64 `json:"usedBytes"`
	LimitBytes int64 `json:"limitBytes"`
}

// NodeStatus is the bounded document a node posts on a low cadence
// (RFC §33.3–34). It never updates the screen's lastContactAt: server
// status authority stays with the player lifecycle path.
type NodeStatus struct {
	SchemaVersion int                `json:"schemaVersion"`
	EdgeVersion   string             `json:"edgeVersion"`
	NodeID        string             `json:"nodeId"`
	Renderer      StatusRenderer     `json:"renderer"`
	Mesh          StatusMesh         `json:"mesh"`
	Cache         *StatusCache       `json:"cache,omitempty"`
	Capabilities  CapabilitySnapshot `json:"capabilities"`
}

func validateStatus(status NodeStatus) error {
	if status.SchemaVersion != 1 {
		return errors.New("unsupported status schema")
	}
	if len(status.EdgeVersion) == 0 || len(status.EdgeVersion) > 64 || !tokenPattern.MatchString(status.Renderer.State) || !tokenPattern.MatchString(status.Mesh.State) {
		return errors.New("status fields are invalid")
	}
	if len(status.Renderer.Kind) > 32 || len(status.Renderer.Version) > 64 || status.Mesh.PeerCount < 0 || status.Mesh.PeerCount > 10000 {
		return errors.New("status fields are out of range")
	}
	if status.Capabilities.Schema != 1 || len(status.Capabilities.Capabilities) > 256 {
		return errors.New("capability snapshot is invalid")
	}
	seen := map[string]bool{}
	for _, c := range status.Capabilities.Capabilities {
		if !capabilityIDPattern.MatchString(c.ID) || len(c.ID) > 96 || seen[c.ID] || !capabilityStates[c.State] {
			return fmt.Errorf("capability %q is invalid", c.ID)
		}
		seen[c.ID] = true
		if len(c.Provider) > 64 || len(c.ProviderVersion) > 64 || len(c.ReasonCode) > 64 || len([]rune(c.Detail)) > 240 || len(c.Attributes) > 4096 {
			return fmt.Errorf("capability %q has oversized fields", c.ID)
		}
	}
	return nil
}

// RecordStatus stores the current status projection for an enrolled node.
func (s *Service) RecordStatus(ctx context.Context, screenID uuid.UUID, status NodeStatus) error {
	if _, err := s.Authority(); err != nil {
		return err
	}
	if err := validateStatus(status); err != nil {
		return err
	}
	var enrolled bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM edge_node_certificates WHERE screen_id=$1 AND node_id=$2 AND revoked_at IS NULL AND not_after > now())`,
		screenID, status.NodeID).Scan(&enrolled); err != nil {
		return err
	}
	if !enrolled {
		return ErrNodeMismatch
	}
	capabilities, err := json.Marshal(status.Capabilities.Capabilities)
	if err != nil {
		return err
	}
	var cacheUsed, cacheLimit *int64
	if status.Cache != nil {
		cacheUsed, cacheLimit = &status.Cache.UsedBytes, &status.Cache.LimitBytes
	}
	_, err = s.db.Exec(ctx, `INSERT INTO edge_node_status(screen_id,node_id,edge_version,renderer_kind,renderer_version,renderer_state,mesh_state,peer_count,cache_used_bytes,cache_limit_bytes,capability_revision,capabilities,last_edge_contact_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now())
		ON CONFLICT(screen_id) DO UPDATE SET node_id=excluded.node_id,edge_version=excluded.edge_version,renderer_kind=excluded.renderer_kind,
			renderer_version=excluded.renderer_version,renderer_state=excluded.renderer_state,mesh_state=excluded.mesh_state,peer_count=excluded.peer_count,
			cache_used_bytes=excluded.cache_used_bytes,cache_limit_bytes=excluded.cache_limit_bytes,
			capability_revision=GREATEST(edge_node_status.capability_revision,excluded.capability_revision),
			capabilities=CASE WHEN excluded.capability_revision >= edge_node_status.capability_revision THEN excluded.capabilities ELSE edge_node_status.capabilities END,
			last_edge_contact_at=now(),updated_at=now()`,
		screenID, status.NodeID, status.EdgeVersion, nullable(status.Renderer.Kind), nullable(status.Renderer.Version), status.Renderer.State,
		status.Mesh.State, status.Mesh.PeerCount, cacheUsed, cacheLimit, status.Capabilities.Revision, capabilities)
	return err
}

func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

type NodeSummary struct {
	ScreenID           uuid.UUID       `json:"screenId"`
	ScreenName         string          `json:"screenName"`
	NodeID             string          `json:"nodeId"`
	EdgeVersion        string          `json:"edgeVersion"`
	RendererKind       *string         `json:"rendererKind"`
	RendererVersion    *string         `json:"rendererVersion"`
	RendererState      *string         `json:"rendererState"`
	MeshState          *string         `json:"meshState"`
	PeerCount          int             `json:"peerCount"`
	CacheUsedBytes     *int64          `json:"cacheUsedBytes"`
	CacheLimitBytes    *int64          `json:"cacheLimitBytes"`
	CapabilityRevision int64           `json:"capabilityRevision"`
	Capabilities       json.RawMessage `json:"capabilities"`
	CertificateExpires *time.Time      `json:"certificateExpiresAt"`
	LastEdgeContactAt  time.Time       `json:"lastEdgeContactAt"`
}

// Nodes lists the current status projection for every enrolled screen.
func (s *Service) Nodes(ctx context.Context) ([]NodeSummary, error) {
	rows, err := s.db.Query(ctx, `SELECT st.screen_id,sc.name,st.node_id,st.edge_version,st.renderer_kind,st.renderer_version,st.renderer_state,
			st.mesh_state,st.peer_count,st.cache_used_bytes,st.cache_limit_bytes,st.capability_revision,st.capabilities,
			(SELECT max(not_after) FROM edge_node_certificates c WHERE c.screen_id=st.screen_id AND c.revoked_at IS NULL),
			st.last_edge_contact_at
		FROM edge_node_status st JOIN screens sc ON sc.id=st.screen_id
		WHERE sc.archived_at IS NULL ORDER BY sc.name LIMIT 2000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := []NodeSummary{}
	for rows.Next() {
		var node NodeSummary
		if err := rows.Scan(&node.ScreenID, &node.ScreenName, &node.NodeID, &node.EdgeVersion, &node.RendererKind, &node.RendererVersion,
			&node.RendererState, &node.MeshState, &node.PeerCount, &node.CacheUsedBytes, &node.CacheLimitBytes, &node.CapabilityRevision,
			&node.Capabilities, &node.CertificateExpires, &node.LastEdgeContactAt); err != nil {
			return nil, err
		}
		nodes = append(nodes, node)
	}
	return nodes, rows.Err()
}
