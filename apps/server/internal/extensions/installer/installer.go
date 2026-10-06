// Package installer records which independently distributed extension
// packages this installation has activated, and what each one contributes.
//
// A package is a distribution container, not a fourth extension API: these
// rows record distribution, version, and provenance, while the
// contributions keep their Widget, Data Source, and plugin contracts.
// Activation is atomic: the manifest revalidates, the Tilecast
// compatibility range holds, every contribution sits inside the package
// namespace, and no other source already supplies the same identity — or
// nothing changes. Every activation persists the resolved immutable digest;
// a floating tag is never executed or recorded.
//
// Trust is explicit. A verified install carries its signer identity.
// Unsigned development installs are refused unless the service is built
// with them allowed, and that allowance is a deliberate constructor choice,
// never a request flag.
package installer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

var (
	// ErrNotFound answers a package this installation has not activated.
	ErrNotFound = errors.New("package not installed")
	// ErrIncompatible answers a manifest whose Tilecast range excludes this release.
	ErrIncompatible = errors.New("package is not compatible with this Tilecast release")
	// ErrNamespace answers a contribution outside the package namespace.
	ErrNamespace = errors.New("contribution is outside the package namespace")
	// ErrCollision answers a contribution another source already supplies.
	ErrCollision = errors.New("contribution is already supplied by another source")
	// ErrUnsignedRejected answers an unsigned install the service forbids.
	ErrUnsignedRejected = errors.New("unsigned packages require development mode")
	// ErrNoRollback answers a rollback with no previous activation.
	ErrNoRollback = errors.New("package has no previous activation")
	// ErrInvalid answers a malformed activation: bad digest, unknown source
	// or trust value, or empty references.
	ErrInvalid = errors.New("invalid package activation")
)

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// SourceKind says how a package arrived: marketplace listing, custom
// repository, or local source such as an offline import.
type SourceKind string

const (
	SourceMarketplace SourceKind = "marketplace"
	SourceCustom      SourceKind = "custom"
	SourceLocal       SourceKind = "local"
)

// TrustState records how an activation was verified.
type TrustState string

const (
	// TrustVerified carries a signer identity the installer checked.
	TrustVerified TrustState = "verified"
	// TrustUnsignedDevelopment marks a development install with no
	// signature. Production activation refuses it.
	TrustUnsignedDevelopment TrustState = "unsigned_development"
)

// InstalledPackage is one activated package row.
type InstalledPackage struct {
	PackageID         string
	Version           string
	Digest            string
	SourceKind        SourceKind
	SourceReference   string
	RegistryReference string
	SignerIdentity    string
	Trust             TrustState
	InstalledAt       time.Time
	InstalledBy       *uuid.UUID
	ActivatedAt       time.Time
	// HasPrevious reports whether a rollback target survives.
	HasPrevious bool
}

// Contribution is one owned contribution: its contract, the nested manifest
// identity, and the path inside the package that carries it.
type Contribution struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Path string `json:"path"`
}

// CollisionError names the source already supplying a contribution.
type CollisionError struct {
	Kind  string
	ID    string
	Owner string
}

func (e *CollisionError) Error() string {
	return fmt.Sprintf("%s %q is already supplied by %s", e.Kind, e.ID, e.Owner)
}

// Unwrap reports ErrCollision so callers match every collision one way.
func (e *CollisionError) Unwrap() error {
	return ErrCollision
}

// Activation installs or updates one package.
type Activation struct {
	Manifest          packagemanifest.Manifest
	Digest            string
	SourceKind        SourceKind
	SourceReference   string
	RegistryReference string
	SignerIdentity    string
	Trust             TrustState
	InstalledBy       uuid.UUID
	Contributions     []Contribution
}

// Service activates external packages.
type Service struct {
	db              *pgxpool.Pool
	tilecastVersion string
	allowUnsigned   bool
	reserved        func(kind, id string) (owner string, ok bool)
}

// Option configures a Service.
type Option func(*Service)

// WithUnsignedDevelopmentAllowed permits unsigned installs. Tests and
// development builds opt in; production builds refuse.
func WithUnsignedDevelopmentAllowed() Option {
	return func(s *Service) { s.allowUnsigned = true }
}

// WithReserved reports identities the release already supplies, so a
// package cannot claim a bundled plugin, Widget, or Data Source identity.
// The owner names the conflicting source for diagnostics.
func WithReserved(reserved func(kind, id string) (owner string, ok bool)) Option {
	return func(s *Service) { s.reserved = reserved }
}

// NewService records package activations against db. tilecastVersion is the
// running release, checked against every manifest compatibility range.
func NewService(db *pgxpool.Pool, tilecastVersion string, options ...Option) *Service {
	s := &Service{db: db, tilecastVersion: tilecastVersion}
	for _, option := range options {
		option(s)
	}
	return s
}

// List reports every activated package in package ID order.
func (s *Service) List(ctx context.Context) ([]InstalledPackage, error) {
	rows, err := s.db.Query(ctx, `SELECT package_id,package_version,digest,source_kind,
		source_reference,registry_reference,signer_identity,trust_state,
		installed_at,installed_by,activated_at,previous_activation IS NOT NULL
		FROM installed_packages ORDER BY package_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []InstalledPackage{}
	for rows.Next() {
		var item InstalledPackage
		if err := rows.Scan(&item.PackageID, &item.Version, &item.Digest,
			&item.SourceKind, &item.SourceReference, &item.RegistryReference,
			&item.SignerIdentity, &item.Trust, &item.InstalledAt,
			&item.InstalledBy, &item.ActivatedAt, &item.HasPrevious); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// Get reports one activated package.
func (s *Service) Get(ctx context.Context, packageID string) (InstalledPackage, error) {
	var item InstalledPackage
	err := s.db.QueryRow(ctx, `SELECT package_id,package_version,digest,source_kind,
		source_reference,registry_reference,signer_identity,trust_state,
		installed_at,installed_by,activated_at,previous_activation IS NOT NULL
		FROM installed_packages WHERE package_id=$1`, packageID).Scan(
		&item.PackageID, &item.Version, &item.Digest, &item.SourceKind,
		&item.SourceReference, &item.RegistryReference, &item.SignerIdentity,
		&item.Trust, &item.InstalledAt, &item.InstalledBy, &item.ActivatedAt,
		&item.HasPrevious)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return InstalledPackage{}, ErrNotFound
		}
		return InstalledPackage{}, err
	}
	return item, nil
}

// Manifest reports the active manifest document of an installed package.
func (s *Service) Manifest(ctx context.Context, packageID string) (packagemanifest.Manifest, error) {
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT manifest FROM installed_packages WHERE package_id=$1`, packageID).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return packagemanifest.Manifest{}, ErrNotFound
		}
		return packagemanifest.Manifest{}, err
	}
	var manifest packagemanifest.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return packagemanifest.Manifest{}, fmt.Errorf("active manifest is corrupt: %w", err)
	}
	return manifest, nil
}

// Contributions reports what one activated package owns.
func (s *Service) Contributions(ctx context.Context, packageID string) ([]Contribution, error) {
	if _, err := s.Get(ctx, packageID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT kind,contribution_id,contribution_path
		FROM installed_package_contributions WHERE package_id=$1
		ORDER BY kind,contribution_id`, packageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Contribution{}
	for rows.Next() {
		var item Contribution
		if err := rows.Scan(&item.Kind, &item.ID, &item.Path); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// Activate installs a package or updates it to a new digest. The manifest
// revalidates, the Tilecast range must hold, every contribution must sit
// inside the package namespace, and nothing else may already supply the
// same identity. The previous activation survives as the rollback target.
// A failed activation leaves the prior state intact.
func (s *Service) Activate(ctx context.Context, activation Activation) (InstalledPackage, error) {
	manifest := activation.Manifest
	if err := packagemanifest.Validate(manifest); err != nil {
		return InstalledPackage{}, err
	}
	if !digestPattern.MatchString(activation.Digest) {
		return InstalledPackage{}, fmt.Errorf("%w: digest must be a sha256 digest", ErrInvalid)
	}
	if err := s.validateProvenance(
		activation.SourceKind,
		activation.SourceReference,
		activation.RegistryReference,
		activation.SignerIdentity,
		activation.Trust,
	); err != nil {
		return InstalledPackage{}, err
	}
	if !packagemanifest.SatisfiesTilecastRange(manifest.Tilecast.Version, s.tilecastVersion) {
		return InstalledPackage{}, fmt.Errorf("package requires Tilecast %s: %w", manifest.Tilecast.Version, ErrIncompatible)
	}
	if err := checkContributions(manifest, activation.Contributions); err != nil {
		return InstalledPackage{}, err
	}
	if err := s.checkReserved(activation.Contributions); err != nil {
		return InstalledPackage{}, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return InstalledPackage{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var current *installedRow
	row, err := lockRow(ctx, tx, manifest.PackageID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return InstalledPackage{}, err
	}
	if err == nil {
		current = row
	}
	var previous []byte
	if current != nil {
		previous, err = snapshotPrevious(ctx, tx, current)
		if err != nil {
			return InstalledPackage{}, err
		}
	}
	var installed InstalledPackage
	if current == nil {
		installed, err = insertRow(ctx, tx, activation, manifest)
	} else {
		installed, err = updateRow(ctx, tx, current, activation, manifest, previous)
	}
	if err != nil {
		return InstalledPackage{}, err
	}
	if err := replaceContributions(ctx, tx, manifest.PackageID, activation.Contributions); err != nil {
		return InstalledPackage{}, err
	}
	action := "package.installed"
	if current != nil {
		action = "package.updated"
	}
	if err := auditPackage(ctx, tx, action, installed, activation.InstalledBy); err != nil {
		return InstalledPackage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return InstalledPackage{}, err
	}
	return installed, nil
}

// Rollback restores the previous activation of an updated package. The
// snapshot revalidates like a fresh activation, so a server upgrade that
// moved past its compatibility range refuses rather than reviving an
// incompatible package. Rollback is single-level: it clears the snapshot.
func (s *Service) Rollback(ctx context.Context, packageID string, userID uuid.UUID) (InstalledPackage, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return InstalledPackage{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	current, err := lockRow(ctx, tx, packageID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return InstalledPackage{}, ErrNotFound
		}
		return InstalledPackage{}, err
	}
	if len(current.previous) == 0 {
		return InstalledPackage{}, ErrNoRollback
	}
	var snapshot activationSnapshot
	if err := json.Unmarshal(current.previous, &snapshot); err != nil {
		return InstalledPackage{}, fmt.Errorf("previous activation is corrupt: %w", err)
	}
	if err := packagemanifest.Validate(snapshot.Manifest); err != nil {
		return InstalledPackage{}, err
	}
	if !packagemanifest.SatisfiesTilecastRange(snapshot.Manifest.Tilecast.Version, s.tilecastVersion) {
		return InstalledPackage{}, fmt.Errorf("package requires Tilecast %s: %w", snapshot.Manifest.Tilecast.Version, ErrIncompatible)
	}
	if snapshot.Manifest.PackageID != packageID {
		return InstalledPackage{}, fmt.Errorf("%w: rollback package identity changed", ErrInvalid)
	}
	if snapshot.Version != snapshot.Manifest.PackageVersion {
		return InstalledPackage{}, fmt.Errorf("%w: rollback package version does not match its manifest", ErrInvalid)
	}
	if !digestPattern.MatchString(snapshot.Digest) {
		return InstalledPackage{}, fmt.Errorf("%w: rollback digest must be a sha256 digest", ErrInvalid)
	}
	if err := s.validateProvenance(
		snapshot.SourceKind,
		snapshot.SourceReference,
		snapshot.RegistryReference,
		snapshot.SignerIdentity,
		snapshot.Trust,
	); err != nil {
		return InstalledPackage{}, fmt.Errorf("previous activation provenance: %w", err)
	}
	if err := checkContributions(snapshot.Manifest, snapshot.Contributions); err != nil {
		return InstalledPackage{}, err
	}
	if err := s.checkReserved(snapshot.Contributions); err != nil {
		return InstalledPackage{}, err
	}
	installed, err := restoreRow(ctx, tx, current, snapshot)
	if err != nil {
		return InstalledPackage{}, err
	}
	if err := replaceContributions(ctx, tx, packageID, snapshot.Contributions); err != nil {
		return InstalledPackage{}, err
	}
	if err := auditPackage(ctx, tx, "package.rolled_back", installed, userID); err != nil {
		return InstalledPackage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return InstalledPackage{}, err
	}
	return installed, nil
}

// Remove deletes an installation record and its contribution rows. Content
// blockers arrive with effective-catalog composition; until then the caller
// reads Contributions to explain what a package owns.
func (s *Service) Remove(ctx context.Context, packageID string, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var installed InstalledPackage
	err = tx.QueryRow(ctx, `DELETE FROM installed_packages WHERE package_id=$1
		RETURNING package_id,package_version,digest,source_kind,source_reference,
		registry_reference,signer_identity,trust_state,installed_at,installed_by,
		activated_at,previous_activation IS NOT NULL`, packageID).Scan(
		&installed.PackageID, &installed.Version, &installed.Digest,
		&installed.SourceKind, &installed.SourceReference, &installed.RegistryReference,
		&installed.SignerIdentity, &installed.Trust, &installed.InstalledAt,
		&installed.InstalledBy, &installed.ActivatedAt, &installed.HasPrevious)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if err := auditPackage(ctx, tx, "package.removed", installed, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func checkContributions(manifest packagemanifest.Manifest, contributions []Contribution) error {
	if len(contributions) != len(manifest.Contributions) {
		return fmt.Errorf(
			"%w: package declares %d contributions but activation derived %d",
			ErrInvalid,
			len(manifest.Contributions),
			len(contributions),
		)
	}

	declared := make(map[string]struct{}, len(manifest.Contributions))
	for _, contribution := range manifest.Contributions {
		declared[contribution.Type+"\x00"+contribution.Path] = struct{}{}
	}

	seenIDs := make(map[string]bool, len(contributions))
	seenDeclarations := make(map[string]bool, len(contributions))
	for _, contribution := range contributions {
		switch contribution.Kind {
		case packagemanifest.ContributionPlugin, packagemanifest.ContributionWidget, packagemanifest.ContributionDataSource:
		default:
			return fmt.Errorf("%w: unknown contribution kind %q", ErrInvalid, contribution.Kind)
		}
		if contribution.ID == "" || len(contribution.ID) > 128 || contribution.Path == "" {
			return fmt.Errorf("%w: contributions need an identity and path", ErrInvalid)
		}
		if !packagemanifest.InNamespace(contribution.ID, manifest.PackageID) {
			return fmt.Errorf("contribution %q is outside package %s: %w", contribution.ID, manifest.PackageID, ErrNamespace)
		}

		declarationKey := contribution.Kind + "\x00" + contribution.Path
		if _, ok := declared[declarationKey]; !ok {
			return fmt.Errorf(
				"%w: contribution %s at %s is not declared by the package manifest",
				ErrInvalid,
				contribution.Kind,
				contribution.Path,
			)
		}
		if seenDeclarations[declarationKey] {
			return fmt.Errorf("%w: package declaration %s at %s was derived more than once", ErrInvalid, contribution.Kind, contribution.Path)
		}
		seenDeclarations[declarationKey] = true

		identityKey := contribution.Kind + ":" + contribution.ID
		if seenIDs[identityKey] {
			return fmt.Errorf("%w: duplicate contribution %q", ErrInvalid, identityKey)
		}
		seenIDs[identityKey] = true
	}

	if len(seenDeclarations) != len(declared) {
		return fmt.Errorf("%w: not every package contribution was derived", ErrInvalid)
	}
	return nil
}

func (s *Service) validateProvenance(
	sourceKind SourceKind,
	sourceReference string,
	registryReference string,
	signerIdentity string,
	trust TrustState,
) error {
	switch sourceKind {
	case SourceMarketplace, SourceCustom, SourceLocal:
	default:
		return fmt.Errorf("%w: unknown source kind", ErrInvalid)
	}
	if strings.TrimSpace(sourceReference) == "" || len(sourceReference) > 512 {
		return fmt.Errorf("%w: source reference must be 1 to 512 characters", ErrInvalid)
	}
	if strings.TrimSpace(registryReference) == "" || len(registryReference) > 255 {
		return fmt.Errorf("%w: registry reference must be 1 to 255 characters", ErrInvalid)
	}
	if len(signerIdentity) > 512 {
		return fmt.Errorf("%w: signer identity must not exceed 512 characters", ErrInvalid)
	}
	switch trust {
	case TrustVerified:
		if strings.TrimSpace(signerIdentity) == "" {
			return fmt.Errorf("%w: verified packages require a signer identity", ErrInvalid)
		}
	case TrustUnsignedDevelopment:
		if signerIdentity != "" {
			return fmt.Errorf("%w: unsigned development packages cannot carry a signer identity", ErrInvalid)
		}
		if !s.allowUnsigned {
			return ErrUnsignedRejected
		}
	default:
		return fmt.Errorf("%w: unknown trust state", ErrInvalid)
	}
	return nil
}

func (s *Service) checkReserved(contributions []Contribution) error {
	if s.reserved == nil {
		return nil
	}
	for _, contribution := range contributions {
		if owner, ok := s.reserved(contribution.Kind, contribution.ID); ok {
			return &CollisionError{Kind: contribution.Kind, ID: contribution.ID, Owner: owner}
		}
	}
	return nil
}

// installedRow is the locked database row an activation updates.
type installedRow struct {
	organizationID    uuid.UUID
	packageID         string
	version           string
	digest            string
	sourceKind        SourceKind
	sourceReference   string
	registryReference string
	signerIdentity    string
	trust             TrustState
	manifest          []byte
	previous          []byte
}

func lockRow(ctx context.Context, tx pgx.Tx, packageID string) (*installedRow, error) {
	var row installedRow
	err := tx.QueryRow(ctx, `SELECT organization_id,package_id,package_version,digest,
		source_kind,source_reference,registry_reference,signer_identity,trust_state,
		manifest,previous_activation FROM installed_packages WHERE package_id=$1 FOR UPDATE`, packageID).Scan(
		&row.organizationID, &row.packageID, &row.version, &row.digest,
		&row.sourceKind, &row.sourceReference, &row.registryReference,
		&row.signerIdentity, &row.trust, &row.manifest, &row.previous)
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// activationSnapshot is the rollback target: the full prior activation.
type activationSnapshot struct {
	Digest            string                   `json:"digest"`
	Version           string                   `json:"version"`
	SourceKind        SourceKind               `json:"sourceKind"`
	SourceReference   string                   `json:"sourceReference"`
	RegistryReference string                   `json:"registryReference"`
	SignerIdentity    string                   `json:"signerIdentity,omitempty"`
	Trust             TrustState               `json:"trustState"`
	Manifest          packagemanifest.Manifest `json:"manifest"`
	Contributions     []Contribution           `json:"contributions"`
}

func snapshotPrevious(ctx context.Context, tx pgx.Tx, current *installedRow) ([]byte, error) {
	rows, err := tx.Query(ctx, `SELECT kind,contribution_id,contribution_path
		FROM installed_package_contributions
		WHERE organization_id=$1 AND package_id=$2
		ORDER BY kind,contribution_id`, current.organizationID, current.packageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	contributions := []Contribution{}
	for rows.Next() {
		var item Contribution
		if err := rows.Scan(&item.Kind, &item.ID, &item.Path); err != nil {
			return nil, err
		}
		contributions = append(contributions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var manifest packagemanifest.Manifest
	if err := json.Unmarshal(current.manifest, &manifest); err != nil {
		return nil, fmt.Errorf("active manifest is corrupt: %w", err)
	}
	return json.Marshal(activationSnapshot{
		Digest:            current.digest,
		Version:           current.version,
		SourceKind:        current.sourceKind,
		SourceReference:   current.sourceReference,
		RegistryReference: current.registryReference,
		SignerIdentity:    current.signerIdentity,
		Trust:             current.trust,
		Manifest:          manifest,
		Contributions:     contributions,
	})
}

func insertRow(ctx context.Context, tx pgx.Tx, activation Activation, manifest packagemanifest.Manifest) (InstalledPackage, error) {
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		return InstalledPackage{}, err
	}
	var installed InstalledPackage
	err = tx.QueryRow(ctx, `INSERT INTO installed_packages(organization_id,package_id,
		package_version,digest,source_kind,source_reference,registry_reference,
		signer_identity,trust_state,manifest,installed_by)
		SELECT id,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM organization_settings WHERE singleton
		RETURNING package_id,package_version,digest,source_kind,source_reference,
		registry_reference,signer_identity,trust_state,installed_at,installed_by,
		activated_at,previous_activation IS NOT NULL`,
		manifest.PackageID, manifest.PackageVersion, activation.Digest,
		string(activation.SourceKind), activation.SourceReference,
		activation.RegistryReference, activation.SignerIdentity,
		string(activation.Trust), manifestJSON,
		nullableUser(activation.InstalledBy)).Scan(
		&installed.PackageID, &installed.Version, &installed.Digest,
		&installed.SourceKind, &installed.SourceReference, &installed.RegistryReference,
		&installed.SignerIdentity, &installed.Trust, &installed.InstalledAt,
		&installed.InstalledBy, &installed.ActivatedAt, &installed.HasPrevious)
	return installed, err
}

func updateRow(ctx context.Context, tx pgx.Tx, current *installedRow, activation Activation, manifest packagemanifest.Manifest, previous []byte) (InstalledPackage, error) {
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		return InstalledPackage{}, err
	}
	var installed InstalledPackage
	err = tx.QueryRow(ctx, `UPDATE installed_packages SET package_version=$1,
		digest=$2,source_kind=$3,source_reference=$4,registry_reference=$5,
		signer_identity=$6,trust_state=$7,manifest=$8,activated_at=now(),previous_activation=$9
		WHERE organization_id=$10 AND package_id=$11
		RETURNING package_id,package_version,digest,source_kind,source_reference,
		registry_reference,signer_identity,trust_state,installed_at,installed_by,
		activated_at,previous_activation IS NOT NULL`,
		manifest.PackageVersion, activation.Digest, string(activation.SourceKind),
		activation.SourceReference, activation.RegistryReference,
		activation.SignerIdentity, string(activation.Trust), manifestJSON, previous,
		current.organizationID, manifest.PackageID).Scan(
		&installed.PackageID, &installed.Version, &installed.Digest,
		&installed.SourceKind, &installed.SourceReference, &installed.RegistryReference,
		&installed.SignerIdentity, &installed.Trust, &installed.InstalledAt,
		&installed.InstalledBy, &installed.ActivatedAt, &installed.HasPrevious)
	return installed, err
}

func restoreRow(ctx context.Context, tx pgx.Tx, current *installedRow, snapshot activationSnapshot) (InstalledPackage, error) {
	manifestJSON, err := json.Marshal(snapshot.Manifest)
	if err != nil {
		return InstalledPackage{}, err
	}
	var installed InstalledPackage
	err = tx.QueryRow(ctx, `UPDATE installed_packages SET package_version=$1,
		digest=$2,source_kind=$3,source_reference=$4,registry_reference=$5,
		signer_identity=$6,trust_state=$7,manifest=$8,activated_at=now(),
		previous_activation=NULL
		WHERE organization_id=$9 AND package_id=$10
		RETURNING package_id,package_version,digest,source_kind,source_reference,
		registry_reference,signer_identity,trust_state,installed_at,installed_by,
		activated_at,previous_activation IS NOT NULL`,
		snapshot.Version, snapshot.Digest, string(snapshot.SourceKind),
		snapshot.SourceReference, snapshot.RegistryReference,
		snapshot.SignerIdentity, string(snapshot.Trust), manifestJSON,
		current.organizationID, current.packageID).Scan(
		&installed.PackageID, &installed.Version, &installed.Digest,
		&installed.SourceKind, &installed.SourceReference, &installed.RegistryReference,
		&installed.SignerIdentity, &installed.Trust, &installed.InstalledAt,
		&installed.InstalledBy, &installed.ActivatedAt, &installed.HasPrevious)
	return installed, err
}

func replaceContributions(ctx context.Context, tx pgx.Tx, packageID string, contributions []Contribution) error {
	if _, err := tx.Exec(ctx, `DELETE FROM installed_package_contributions
		WHERE package_id=$1`, packageID); err != nil {
		return err
	}
	for _, contribution := range contributions {
		if _, err := tx.Exec(ctx, `INSERT INTO installed_package_contributions(
			organization_id,package_id,kind,contribution_id,contribution_path)
			SELECT organization_id,$1,$2,$3,$4 FROM installed_packages WHERE package_id=$1`,
			packageID, contribution.Kind, contribution.ID, contribution.Path); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return &CollisionError{Kind: contribution.Kind, ID: contribution.ID, Owner: "another package"}
			}
			return err
		}
	}
	return nil
}

// auditPackage writes one package audit event through the shared audit
// path, so the request's attribution flows from context. Direct service
// calls carry no HTTP principal; like plugin worker callbacks, they name
// the server as the initiating client instead of inventing a caller.
func auditPackage(ctx context.Context, tx pgx.Tx, action string, installed InstalledPackage, userID uuid.UUID) error {
	record := audit.Event{
		Action:       action,
		ResourceType: "package",
		ResourceID:   installed.PackageID,
		ResourceName: installed.PackageID,
		Metadata: map[string]any{
			"packageVersion": installed.Version,
			"digest":         installed.Digest,
			"trustState":     string(installed.Trust),
		},
	}
	if userID != uuid.Nil {
		actor := userID
		record.Actor = &actor
	}
	if audit.SurfaceFrom(ctx) == "" {
		record.Surface = audit.SurfaceSystem
		record.ClientID = "tilecast-server"
	}
	return audit.RecordTx(ctx, tx, record)
}

func nullableUser(userID uuid.UUID) *uuid.UUID {
	if userID == uuid.Nil {
		return nil
	}
	return &userID
}
