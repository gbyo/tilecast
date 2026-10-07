package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/catalog"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/pipeline"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Package lifecycle routes: resolving a custom repository for review,
// installing from the review, and managing installed packages. Reads
// answer any signed-in role; every mutation needs Owner or Administrator
// with a CSRF token. The installer audits activations, rollbacks, and
// removals; resolution and update checks are reads and audit nothing.

type packageManifestSummary struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	PublisherID   string `json:"publisherId"`
	PublisherName string `json:"publisherName"`
	License       string `json:"license"`
	TilecastRange string `json:"tilecastRange"`
}

type packageContribution struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Path string `json:"path"`
}

type customSourceResponse struct {
	Owner          string    `json:"owner"`
	Name           string    `json:"name"`
	RepositoryURL  string    `json:"repositoryUrl"`
	ResolvedDigest string    `json:"resolvedDigest"`
	ResolvedAt     time.Time `json:"resolvedAt"`
	AddedAt        time.Time `json:"addedAt"`
}

type installedPackageResponse struct {
	PackageID         string                 `json:"packageId"`
	Version           string                 `json:"version"`
	Manifest          packageManifestSummary `json:"manifest"`
	Digest            string                 `json:"digest"`
	SourceKind        string                 `json:"sourceKind"`
	SourceReference   string                 `json:"sourceReference"`
	RegistryReference string                 `json:"registryReference"`
	SignerIdentity    string                 `json:"signerIdentity,omitempty"`
	Trust             string                 `json:"trust"`
	InstalledAt       time.Time              `json:"installedAt"`
	InstalledBy       *uuid.UUID             `json:"installedBy"`
	ActivatedAt       time.Time              `json:"activatedAt"`
	HasRollback       bool                   `json:"hasRollback"`
	Contributions     []packageContribution  `json:"contributions"`
	Source            *customSourceResponse  `json:"source,omitempty"`
}

func summarizeManifest(manifest packagemanifest.Manifest) packageManifestSummary {
	return packageManifestSummary{
		Name:          manifest.Name,
		Description:   manifest.Description,
		PublisherID:   manifest.Publisher.ID,
		PublisherName: manifest.Publisher.Name,
		License:       manifest.License,
		TilecastRange: manifest.Tilecast.Version,
	}
}

func (s *server) renderInstalledPackage(r *http.Request, item installer.InstalledPackage) (installedPackageResponse, error) {
	manifest, err := s.installer.Manifest(r.Context(), item.PackageID)
	if err != nil {
		return installedPackageResponse{}, err
	}
	contributions, err := s.installer.Contributions(r.Context(), item.PackageID)
	if err != nil {
		return installedPackageResponse{}, err
	}
	rendered := installedPackageResponse{
		PackageID:         item.PackageID,
		Version:           item.Version,
		Manifest:          summarizeManifest(manifest),
		Digest:            item.Digest,
		SourceKind:        string(item.SourceKind),
		SourceReference:   item.SourceReference,
		RegistryReference: item.RegistryReference,
		SignerIdentity:    item.SignerIdentity,
		Trust:             string(item.Trust),
		InstalledAt:       item.InstalledAt,
		InstalledBy:       item.InstalledBy,
		ActivatedAt:       item.ActivatedAt,
		HasRollback:       item.HasPrevious,
		Contributions:     []packageContribution{},
	}
	for _, contribution := range contributions {
		rendered.Contributions = append(rendered.Contributions, packageContribution{
			Kind: contribution.Kind, ID: contribution.ID, Path: contribution.Path,
		})
	}
	if item.SourceKind == installer.SourceCustom {
		source, err := s.packages.CustomSource(r.Context(), item.PackageID)
		if err != nil {
			return installedPackageResponse{}, err
		}
		rendered.Source = &customSourceResponse{
			Owner: source.Owner, Name: source.Name,
			RepositoryURL: source.RepositoryURL, ResolvedDigest: source.ResolvedDigest,
			ResolvedAt: source.ResolvedAt, AddedAt: source.AddedAt,
		}
	}
	return rendered, nil
}

// listPackages reports every installed package.
func (s *server) listPackages(w http.ResponseWriter, r *http.Request) {
	items, err := s.installer.List(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	rendered := []installedPackageResponse{}
	for _, item := range items {
		one, err := s.renderInstalledPackage(r, item)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		rendered = append(rendered, one)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rendered})
}

// getPackage reports one installed package with its contributions and,
// for custom packages, its repository binding.
func (s *server) getPackage(w http.ResponseWriter, r *http.Request) {
	item, err := s.installer.Get(r.Context(), chi.URLParam(r, "packageId"))
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	rendered, err := s.renderInstalledPackage(r, item)
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rendered})
}

type resolveReview struct {
	PackageID     string                 `json:"packageId"`
	Version       string                 `json:"version"`
	Manifest      packageManifestSummary `json:"manifest"`
	Compatible    bool                   `json:"compatible"`
	Contributions []struct {
		Type string `json:"type"`
		Path string `json:"path"`
	} `json:"contributions"`
	Digest           string     `json:"digest"`
	Registry         string     `json:"registry"`
	ReleaseTag       string     `json:"releaseTag"`
	ReleaseName      string     `json:"releaseName,omitempty"`
	PublishedAt      *time.Time `json:"publishedAt,omitempty"`
	Owner            string     `json:"owner"`
	Repo             string     `json:"repo"`
	RepositoryURL    string     `json:"repositoryUrl"`
	Signer           string     `json:"signer,omitempty"`
	Trust            string     `json:"trust"`
	Installed        bool       `json:"installed"`
	InstalledVersion string     `json:"installedVersion,omitempty"`
}

func renderReview(resolution pipeline.Resolution, installed installer.InstalledPackage, isInstalled bool) resolveReview {
	review := resolveReview{
		PackageID:  resolution.Manifest.PackageID,
		Version:    resolution.Manifest.PackageVersion,
		Manifest:   summarizeManifest(resolution.Manifest),
		Compatible: resolution.Compatible,
		Contributions: []struct {
			Type string `json:"type"`
			Path string `json:"path"`
		}{},
		Digest:        resolution.Digest,
		Registry:      resolution.RegistryRef,
		ReleaseTag:    resolution.ReleaseTag,
		ReleaseName:   resolution.ReleaseName,
		Owner:         resolution.Owner,
		Repo:          resolution.Repo,
		RepositoryURL: resolution.RepositoryURL,
		Signer:        resolution.Signer,
		Trust:         string(resolution.Trust),
		Installed:     isInstalled,
	}
	if !resolution.PublishedAt.IsZero() {
		publishedAt := resolution.PublishedAt
		review.PublishedAt = &publishedAt
	}
	for _, contribution := range resolution.Manifest.Contributions {
		review.Contributions = append(review.Contributions, struct {
			Type string `json:"type"`
			Path string `json:"path"`
		}{Type: contribution.Type, Path: contribution.Path})
	}
	if isInstalled {
		review.InstalledVersion = installed.Version
	}
	return review
}

// resolveGitHubRepository resolves a repository URL to the install
// review: identity, version, provenance, and installed state. It
// persists nothing; installing re-resolves fresh.
func (s *server) resolveGitHubRepository(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Repository string `json:"repository"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Repository == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "A repository URL is required.")
		return
	}
	resolution, err := s.packages.ResolveCustom(r.Context(), input.Repository)
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	installed, err := s.installer.Get(r.Context(), resolution.Manifest.PackageID)
	isInstalled := err == nil
	if err != nil && !errors.Is(err, installer.ErrNotFound) {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": renderReview(resolution, installed, isInstalled)})
}

// resolveMarketplacePackage resolves a cached marketplace listing to
// the install review: the pinned artifact verifies provenance, pulls
// by digest, and reads the published manifest, which is authoritative
// for capabilities. It installs nothing; installing re-resolves fresh.
func (s *server) resolveMarketplacePackage(w http.ResponseWriter, r *http.Request) {
	packageID := chi.URLParam(r, "packageId")
	resolution, err := s.packages.ResolveMarketplace(r.Context(), packageID)
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	installed, err := s.installer.Get(r.Context(), resolution.Manifest.PackageID)
	isInstalled := err == nil
	if err != nil && !errors.Is(err, installer.ErrNotFound) {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": renderReview(resolution, installed, isInstalled)})
}

// installStorePackage installs the store entry: a marketplace listing by
// package ID, or a custom repository when the body names one. The
// package ID must match the resolved manifest; the server re-resolves
// and never trusts a Studio-supplied digest.
func (s *server) installStorePackage(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Repository string `json:"repository,omitempty"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	packageID := chi.URLParam(r, "packageId")
	var installed installer.InstalledPackage
	var err error
	if input.Repository != "" {
		// Resolve once to bind the route's package ID before the
		// install re-resolves fresh; a mismatch must fail without
		// installing anything.
		resolution, err := s.packages.ResolveCustom(r.Context(), input.Repository)
		if err != nil {
			s.writePackageError(w, r, err)
			return
		}
		if resolution.Manifest.PackageID != packageID {
			writeError(w, http.StatusConflict, "package_mismatch", "The repository supplies "+resolution.Manifest.PackageID+", not "+packageID+".")
			return
		}
		installed, err = s.packages.InstallCustom(r.Context(), input.Repository, principal.User.ID)
	} else {
		installed, err = s.packages.InstallMarketplace(r.Context(), packageID, principal.User.ID)
	}
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	rendered, err := s.renderInstalledPackage(r, installed)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": rendered})
}

type updateCheckResponse struct {
	Installed   installedPackageResponse `json:"installed"`
	Available   bool                     `json:"available"`
	UpToDate    bool                     `json:"upToDate"`
	LastChecked time.Time                `json:"lastChecked"`
	Latest      *resolveReview           `json:"latest,omitempty"`
}

// checkPackageUpdate resolves the latest artifact for an installed
// package without activating anything. A custom package re-resolves its
// repository; a marketplace package refreshes the catalog first. The
// route guards this as a mutation: it performs network writes on behalf
// of the operator.
func (s *server) checkPackageUpdate(w http.ResponseWriter, r *http.Request) {
	check, err := s.packages.UpdateCheck(r.Context(), chi.URLParam(r, "packageId"))
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	installed, err := s.renderInstalledPackage(r, check.Installed)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	response := updateCheckResponse{
		Installed: installed, Available: check.Available,
		UpToDate: check.UpToDate, LastChecked: check.LastChecked,
	}
	if check.Available {
		latest := renderReview(check.Resolution, check.Installed, true)
		response.Latest = &latest
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": response})
}

// applyPackageUpdate activates the digest an update check approved. The
// check re-resolves fresh, so a stale digest answers update_check_expired
// instead of installing old bytes.
func (s *server) applyPackageUpdate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Digest string `json:"digest"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Digest == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "A digest is required.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	result, err := s.packages.ApplyUpdate(r.Context(), chi.URLParam(r, "packageId"), input.Digest, principal.User.ID)
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	rendered, err := s.renderInstalledPackage(r, result.Installed)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"package": rendered, "updated": result.Updated,
	}})
}

// rollbackPackage restores the previous activation.
func (s *server) rollbackPackage(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	installed, err := s.packages.Rollback(r.Context(), chi.URLParam(r, "packageId"), principal.User.ID)
	if err != nil {
		s.writePackageError(w, r, err)
		return
	}
	rendered, err := s.renderInstalledPackage(r, installed)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rendered})
}

// removePackage deletes the installation and its contribution rows. The
// custom source, when any, survives for reinstall.
func (s *server) removePackage(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	if err := s.packages.Remove(r.Context(), chi.URLParam(r, "packageId"), principal.User.ID); err != nil {
		s.writePackageError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writePackageError maps pipeline, installer, and catalog failures to
// API errors. Anything unmapped is a server bug and answers 500.
func (s *server) writePackageError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, pipeline.ErrInvalidRepository):
		writeError(w, http.StatusBadRequest, "invalid_repository", "That is not a GitHub repository URL.")
	case errors.Is(err, pipeline.ErrRepositoryPrivate):
		writeError(w, http.StatusBadRequest, "repository_private", "The repository must be public.")
	case errors.Is(err, pipeline.ErrRepositoryNotFound):
		writeError(w, http.StatusNotFound, "repository_not_found", "GitHub has no such repository.")
	case errors.Is(err, pipeline.ErrNoRelease):
		writeError(w, http.StatusUnprocessableEntity, "no_published_release", "The repository has no published release.")
	case errors.Is(err, pipeline.ErrNoManifest):
		writeError(w, http.StatusUnprocessableEntity, "manifest_not_found", "The release has no tilecast.package.json.")
	case errors.Is(err, pipeline.ErrManifestInvalid):
		writeError(w, http.StatusUnprocessableEntity, "manifest_invalid", "The package manifest is invalid.")
	case errors.Is(err, pipeline.ErrTagUnusable):
		writeError(w, http.StatusUnprocessableEntity, "release_tag_unusable", "The release tag cannot name a package artifact.")
	case errors.Is(err, pipeline.ErrNoPublishedPackage):
		writeError(w, http.StatusUnprocessableEntity, "no_published_package", "The release has no published package.")
	case errors.Is(err, pipeline.ErrPackageUnsigned):
		writeError(w, http.StatusUnprocessableEntity, "package_unsigned", "The package has no verifying provenance.")
	case errors.Is(err, pipeline.ErrArtifactInvalid):
		writeError(w, http.StatusUnprocessableEntity, "artifact_invalid", "The package artifact is invalid.")
	case errors.Is(err, pipeline.ErrCrossCheck):
		writeError(w, http.StatusUnprocessableEntity, "package_mismatch", "The published package does not match its manifest.")
	case errors.Is(err, pipeline.ErrNotGitHub):
		writeError(w, http.StatusUnprocessableEntity, "repository_not_supported", "Only GitHub repositories install in this release.")
	case errors.Is(err, pipeline.ErrAlreadyInstalled):
		writeError(w, http.StatusConflict, "package_installed", "The package is already installed.")
	case errors.Is(err, pipeline.ErrNotInstalled):
		writeError(w, http.StatusNotFound, "package_not_installed", "The package is not installed.")
	case errors.Is(err, pipeline.ErrDigestMismatch):
		writeError(w, http.StatusConflict, "update_check_expired", "The update check expired. Check again and confirm the new digest.")
	case errors.Is(err, pipeline.ErrSourceConflict):
		writeError(w, http.StatusConflict, "source_conflict", "The repository is already bound to another package.")
	case errors.Is(err, pipeline.ErrTrustUnavailable):
		writeError(w, http.StatusBadGateway, "trust_unavailable", "Tilecast could not reach Sigstore to verify provenance.")
	case errors.Is(err, pipeline.ErrUpstream):
		writeError(w, http.StatusBadGateway, "upstream_unavailable", "Tilecast could not reach the package source.")
	case errors.Is(err, installer.ErrNotFound):
		writeError(w, http.StatusNotFound, "package_not_installed", "The package is not installed.")
	case errors.Is(err, installer.ErrIncompatible):
		writeError(w, http.StatusUnprocessableEntity, "package_incompatible", "The package does not support this Tilecast release.")
	case errors.Is(err, installer.ErrNamespace):
		writeError(w, http.StatusUnprocessableEntity, "namespace_violation", "A contribution falls outside the package namespace.")
	case errors.Is(err, installer.ErrCollision):
		writeError(w, http.StatusConflict, "contribution_collision", err.Error())
	case errors.Is(err, installer.ErrUnsignedRejected):
		writeError(w, http.StatusUnprocessableEntity, "package_unsigned", "The package has no verifying provenance.")
	case errors.Is(err, installer.ErrNoRollback):
		writeError(w, http.StatusConflict, "no_rollback", "The package has no previous activation.")
	case errors.Is(err, catalog.ErrUnknownPackage):
		writeError(w, http.StatusNotFound, "plugin_not_found", "No store entry carries this package ID.")
	default:
		s.internalError(w, r, err)
	}
}
