package wasm

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Call timeouts by entry point. Jobs do real work on a schedule; UI
// calls answer an operator waiting on a frame.
const (
	JobTimeout    = 30 * time.Second
	UICallTimeout = 5 * time.Second
)

// ErrNoRuntime marks a package whose manifest declares no runtime
// module; ErrNoStudioUI marks one with no Studio UI capability. Both
// fail closed at the bridge: the caller answers 404.
var (
	ErrNoRuntime  = errors.New("wasm: package declares no runtime module")
	ErrNoStudioUI = errors.New("wasm: package declares no Studio UI")
)

// Service resolves installed packages to invocations: the activation's
// manifest for grants, the retained artifact for module bytes, and the
// shared execution host. Pipeline and the job scheduler call InvokeJob;
// the Studio UI bridge calls InvokeUI. All three fail closed when the
// package, the module, or the grant is gone.
type Service struct {
	host      *Host
	installer *installer.Service
	content   func(ctx context.Context, ref, digest string) (string, error)
}

// NewService builds the runtime service. content resolves retained
// artifacts to directories; the pipeline supplies ContentDir.
func NewService(ctx context.Context, install *installer.Service, content func(ctx context.Context, ref, digest string) (string, error), store KVStore, logger *slog.Logger) (*Service, error) {
	host, err := NewHost(ctx, store, logger)
	if err != nil {
		return nil, err
	}
	return &Service{host: host, installer: install, content: content}, nil
}

// Close releases the execution host.
func (s *Service) Close(ctx context.Context) error {
	return s.host.Close(ctx)
}

// Remove evicts one digest from the compile cache and deletes the
// package's stored keys. Package removal calls it after the activation
// row is gone; updates call Evict instead, keeping storage.
func (s *Service) Remove(ctx context.Context, digest, packageID string, store KVStore) error {
	s.host.Remove(ctx, digest)
	return store.RemovePackage(ctx, packageID)
}

// Evict drops one digest from the compile cache, keeping storage.
// Package updates call it after activation so the next call compiles
// the new artifact.
func (s *Service) Evict(ctx context.Context, digest string) {
	s.host.Remove(ctx, digest)
}

// InvokeJob runs one declared background job.
func (s *Service) InvokeJob(ctx context.Context, packageID, jobID string) (int32, error) {
	prepared, err := s.prepare(ctx, packageID)
	if err != nil {
		return 0, err
	}
	declared := false
	if prepared.manifest.Capabilities != nil && prepared.manifest.Capabilities.Background != nil {
		for _, job := range prepared.manifest.Capabilities.Background.Jobs {
			if job.ID == jobID {
				declared = true
				break
			}
		}
	}
	if !declared {
		return 0, fmt.Errorf("wasm: job %q is not declared", jobID)
	}
	result, err := s.host.Invoke(ctx, Call{
		PackageID: packageID,
		Digest:    prepared.digest,
		Module:    prepared.module,
		Grants:    prepared.grants,
		Entry:     "run_job",
		Input:     []byte(jobID),
		Timeout:   JobTimeout,
	})
	if err != nil {
		return 0, err
	}
	return result.Status, nil
}

// InvokeUI answers one Studio UI bridge call with a framed reply.
func (s *Service) InvokeUI(ctx context.Context, packageID string, request []byte) (Result, error) {
	prepared, err := s.prepare(ctx, packageID)
	if err != nil {
		return Result{}, err
	}
	if prepared.manifest.Capabilities == nil || prepared.manifest.Capabilities.StudioUI == nil {
		return Result{}, ErrNoStudioUI
	}
	return s.host.Invoke(ctx, Call{
		PackageID: packageID,
		Digest:    prepared.digest,
		Module:    prepared.module,
		Grants:    prepared.grants,
		Entry:     "handle_ui_request",
		Input:     request,
		Timeout:   UICallTimeout,
	})
}

type prepared struct {
	manifest packagemanifest.Manifest
	digest   string
	module   []byte
	grants   Grants
}

// prepare resolves the activation, the retained module bytes, and the
// evaluated grants for one call. Every lookup fails closed: unknown
// packages, missing artifacts, and unreadable modules all refuse.
func (s *Service) prepare(ctx context.Context, packageID string) (prepared, error) {
	installed, err := s.installer.Get(ctx, packageID)
	if err != nil {
		return prepared{}, err
	}
	manifest, err := s.installer.Manifest(ctx, packageID)
	if err != nil {
		return prepared{}, err
	}
	if manifest.Runtime == nil {
		return prepared{}, ErrNoRuntime
	}
	contentDir, err := s.content(ctx, installed.RegistryReference, installed.Digest)
	if err != nil {
		return prepared{}, err
	}
	joined := filepath.Join(contentDir, manifest.Runtime.Module)
	rel, err := filepath.Rel(contentDir, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return prepared{}, fmt.Errorf("wasm: runtime module escapes the package")
	}
	module, err := readCapped(joined, MaxModuleBytes)
	if err != nil {
		return prepared{}, err
	}
	grants := Grants{}
	if manifest.Capabilities != nil {
		if manifest.Capabilities.Network != nil {
			grants.NetworkHosts = append([]string{}, manifest.Capabilities.Network.Hosts...)
		}
		grants.Storage = manifest.Capabilities.Storage != nil && *manifest.Capabilities.Storage
	}
	return prepared{manifest: manifest, digest: installed.Digest, module: module, grants: grants}, nil
}
