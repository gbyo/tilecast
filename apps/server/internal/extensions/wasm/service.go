package wasm

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/execution"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Call timeouts by entry point. Jobs do real work on a schedule; UI
// calls answer an operator waiting on a frame.
const (
	JobTimeout         = 30 * time.Second
	RealtimeJobTimeout = 4 * time.Second
	UICallTimeout      = 5 * time.Second
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
	host           *Host
	installer      *installer.Service
	content        func(ctx context.Context, ref, digest string) (string, error)
	caller         ServiceCaller
	slots          chan struct{}
	mu             sync.Mutex
	modules        map[uuid.UUID]cachedModule
	verifiedModule func(context.Context, string, string, string) ([]byte, error)
}

type cachedModule struct {
	digest string
	bytes  []byte
}

// NewService builds the runtime service. content resolves retained
// artifacts to directories; the pipeline supplies ContentDir. Options
// wire collaborators such as the service dispatcher.
func NewService(ctx context.Context, install *installer.Service, content func(ctx context.Context, ref, digest string) (string, error), store KVStore, logger *slog.Logger, options ...func(*Service)) (*Service, error) {
	host, err := NewHost(ctx, store, logger)
	if err != nil {
		return nil, err
	}
	service := &Service{host: host, installer: install, content: content, slots: make(chan struct{}, 8), modules: make(map[uuid.UUID]cachedModule)}
	for _, option := range options {
		option(service)
	}
	return service, nil
}

// WithServiceCaller wires the service dispatcher behind call_v1. Without
// one, every service call is denied.
func WithServiceCaller(caller ServiceCaller) func(*Service) {
	return func(s *Service) { s.caller = caller }
}

func WithVerifiedModuleReader(read func(context.Context, string, string, string) ([]byte, error)) func(*Service) {
	return func(s *Service) { s.verifiedModule = read }
}

// SetServiceCaller wires the dispatcher after construction, for callers
// whose domain services do not exist yet when the runtime is built.
func (s *Service) SetServiceCaller(caller ServiceCaller) {
	s.caller = caller
}

// Close releases the execution host.
func (s *Service) Close(ctx context.Context) error {
	return s.host.Close(ctx)
}

// Remove evicts one digest from the compile cache and deletes the
// package's stored keys. Package removal calls it after the activation
// row is gone; updates call Evict instead, keeping storage.
func (s *Service) Remove(ctx context.Context, digest, packageID string, store KVStore) error {
	s.Evict(ctx, digest)
	return store.RemovePackage(ctx, packageID)
}

// Evict drops one digest from the compile cache, keeping storage.
// Package updates call it after activation so the next call compiles
// the new artifact.
func (s *Service) Evict(ctx context.Context, digest string) {
	s.mu.Lock()
	for epoch, module := range s.modules {
		if module.digest == digest {
			delete(s.modules, epoch)
		}
	}
	s.mu.Unlock()
	s.host.Remove(ctx, digest)
}

func (s *Service) acquire(ctx context.Context) (func(), error) {
	select {
	case s.slots <- struct{}{}:
		return func() { <-s.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// watchActivation bounds guest execution after lifecycle changes, including
// changes committed by another Server replica. Mutation calls also check the
// epoch while holding the lifecycle fence, so cancellation latency cannot
// permit an old guest to publish or store data.
func (s *Service) watchActivation(ctx context.Context, packageID string, epoch uuid.UUID) (context.Context, context.CancelFunc, error) {
	current, err := s.installer.ExecutionCurrent(ctx, packageID, epoch)
	if err != nil {
		return nil, nil, err
	}
	if !current {
		return nil, nil, execution.ErrChanged
	}
	callCtx, cancel := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-callCtx.Done():
				return
			case <-ticker.C:
				current, err := s.installer.ExecutionCurrent(callCtx, packageID, epoch)
				if err != nil || !current {
					cancel()
					return
				}
			}
		}
	}()
	return callCtx, cancel, nil
}

// InvokeJob runs one declared background job.
func (s *Service) InvokeJob(ctx context.Context, packageID, jobID string) (int32, error) {
	started := time.Now()
	ctx, deadlineCancel := context.WithTimeout(ctx, JobTimeout)
	defer deadlineCancel()
	release, err := s.acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer release()
	prepared, err := s.prepare(ctx, packageID)
	if err != nil {
		return 0, err
	}
	declared := false
	timeout := JobTimeout
	if expected, ok := ctx.Value(claimedEpochKey{}).(*uuid.UUID); ok && expected != nil && *expected != prepared.executionEpoch {
		return 0, execution.ErrChanged
	}
	if prepared.manifest.Capabilities != nil && prepared.manifest.Capabilities.Background != nil {
		for _, job := range prepared.manifest.Capabilities.Background.Jobs {
			if job.ID == jobID {
				declared = true
				break
			}
		}
	}
	if prepared.manifest.Capabilities != nil && prepared.manifest.Capabilities.Realtime != nil {
		for _, job := range prepared.manifest.Capabilities.Realtime.Jobs {
			if job.ID == jobID {
				declared = true
				timeout = RealtimeJobTimeout
				break
			}
		}
	}
	if !declared {
		return 0, fmt.Errorf("wasm: job %q is not declared", jobID)
	}
	if timeout == RealtimeJobTimeout {
		var realtimeCancel context.CancelFunc
		ctx, realtimeCancel = context.WithDeadline(ctx, started.Add(RealtimeJobTimeout))
		defer realtimeCancel()
	}
	ctx, cancel, err := s.watchActivation(ctx, packageID, prepared.executionEpoch)
	if err != nil {
		return 0, err
	}
	defer cancel()
	fetchLimit := time.Duration(0)
	if timeout == RealtimeJobTimeout {
		fetchLimit = 3 * time.Second
	}
	result, err := s.host.Invoke(ctx, Call{
		PackageAPIVersion: prepared.manifest.APIVersion,
		ExecutionEpoch:    prepared.executionEpoch,
		StorageEpoch:      prepared.storageEpoch,
		PackageID:         packageID,
		Digest:            prepared.digest,
		Module:            prepared.module,
		Grants:            prepared.grants,
		Entry:             "run_job",
		Input:             []byte(jobID),
		Timeout:           timeout,
		FetchTimeout:      fetchLimit,
		Context:           services.ContextBackground,
		Caller:            s.caller,
	})
	if err != nil {
		return 0, err
	}
	return result.Status, nil
}

// InvokeUI answers one Studio UI bridge call with a framed reply. The
// actor is the authenticated operator behind the call.
func (s *Service) InvokeUI(ctx context.Context, packageID string, actor services.Actor, request []byte) (Result, error) {
	ctx, deadlineCancel := context.WithTimeout(ctx, UICallTimeout)
	defer deadlineCancel()
	release, err := s.acquire(ctx)
	if err != nil {
		return Result{}, err
	}
	defer release()
	prepared, err := s.prepare(ctx, packageID)
	if err != nil {
		return Result{}, err
	}
	if prepared.manifest.Capabilities == nil || prepared.manifest.Capabilities.StudioUI == nil {
		return Result{}, ErrNoStudioUI
	}
	ctx, cancel, err := s.watchActivation(ctx, packageID, prepared.executionEpoch)
	if err != nil {
		return Result{}, err
	}
	defer cancel()
	return s.host.Invoke(ctx, Call{
		PackageAPIVersion: prepared.manifest.APIVersion,
		ExecutionEpoch:    prepared.executionEpoch,
		StorageEpoch:      prepared.storageEpoch,
		PackageID:         packageID,
		Digest:            prepared.digest,
		Module:            prepared.module,
		Grants:            prepared.grants,
		Entry:             "handle_ui_request",
		Input:             request,
		Timeout:           UICallTimeout,
		Context:           services.ContextStudio,
		Actor:             &actor,
		Caller:            s.caller,
	})
}

type prepared struct {
	executionEpoch uuid.UUID
	storageEpoch   uuid.UUID
	manifest       packagemanifest.Manifest
	digest         string
	module         []byte
	grants         Grants
}

// prepare resolves the activation, the retained module bytes, and the
// evaluated grants for one call. Every lookup fails closed: unknown
// packages, missing artifacts, and unreadable modules all refuse.
func (s *Service) prepare(ctx context.Context, packageID string) (prepared, error) {
	installed, manifest, err := s.installer.ExecutionSnapshot(ctx, packageID)
	if err != nil {
		return prepared{}, err
	}
	if manifest.Runtime == nil {
		return prepared{}, ErrNoRuntime
	}
	s.mu.Lock()
	cached, hit := s.modules[installed.ExecutionEpoch]
	s.mu.Unlock()
	var module []byte
	if hit && cached.digest == installed.Digest {
		module = cached.bytes
	} else {
		if s.verifiedModule != nil {
			module, err = s.verifiedModule(ctx, installed.RegistryReference, installed.Digest, manifest.Runtime.Module)
			if err != nil {
				return prepared{}, err
			}
			if len(module) == 0 || len(module) > MaxModuleBytes {
				return prepared{}, fmt.Errorf("wasm: runtime module exceeds its byte bound")
			}
		} else {
			contentDir, err := s.content(ctx, installed.RegistryReference, installed.Digest)
			if err != nil {
				return prepared{}, err
			}
			joined := filepath.Join(contentDir, manifest.Runtime.Module)
			rel, err := filepath.Rel(contentDir, joined)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return prepared{}, fmt.Errorf("wasm: runtime module escapes the package")
			}
			module, err = readCapped(joined, MaxModuleBytes)
			if err != nil {
				return prepared{}, err
			}
		}
		s.mu.Lock()
		// The cache contains only bytes read from a verified retained artifact.
		// Epoch keys prevent rollback/reinstall from inheriting stale grants.
		if len(s.modules) >= 8 {
			clear(s.modules)
		}
		s.modules[installed.ExecutionEpoch] = cachedModule{digest: installed.Digest, bytes: module}
		s.mu.Unlock()
	}
	grants := Grants{}
	if manifest.Capabilities != nil {
		if manifest.Capabilities.Network != nil {
			grants.NetworkHosts = append([]string{}, manifest.Capabilities.Network.Hosts...)
		}
		grants.Storage = manifest.Capabilities.Storage != nil && *manifest.Capabilities.Storage
		grants.Services = append([]packagemanifest.ServiceGrant{}, manifest.Capabilities.Services...)
	}
	return prepared{manifest: manifest, digest: installed.Digest, module: module, grants: grants,
		executionEpoch: installed.ExecutionEpoch, storageEpoch: installed.StorageEpoch}, nil
}
