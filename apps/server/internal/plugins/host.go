package plugins

// The plugin host: the core side of the Tilecast Plugin API.
//
// Core owns installation, authorization, audit, manifest revisions, and
// migrations. A plugin owns its tables, status rules, removal rules, routes,
// and projections, and reaches core only through the plugin.Host services
// built here. The host never switches on a plugin's identity: it asks each
// plugin through the contribution interfaces the plugin chose to implement.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// hostedPlugin is one plugin instance owned by a Service.
type hostedPlugin struct {
	plugin     plugin.Plugin
	manifest   plugin.Manifest
	definition Definition
}

// Option configures a Service.
type Option func(*Service)

// WithLogger sets the logger plugins receive, tagged with their identifier.
func WithLogger(logger *slog.Logger) Option {
	return func(s *Service) { s.logger = logger }
}

// WithPlugins replaces the bundled plugins. Tests use it to host a plugin
// that is not part of the release.
func WithPlugins(bundle ...plugin.Plugin) Option {
	return func(s *Service) { s.bundle = bundle }
}

// WithClock replaces the server clock plugins receive.
func WithClock(clock plugin.Clock) Option {
	return func(s *Service) { s.clock = clock }
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// host builds the plugin set and initializes every plugin. A plugin whose
// declarations do not match what it implements is a release defect and
// panics here, exactly like an invalid manifest; the conformance tests
// report it first.
func (s *Service) host() {
	definitions := mustDefinitions(s.bundle)
	byID := map[string]Definition{}
	for _, definition := range definitions {
		byID[definition.ID] = definition
	}
	s.definitions = definitions
	s.hosted = make([]hostedPlugin, 0, len(s.bundle))
	for _, p := range s.bundle {
		manifest := p.Manifest()
		if err := plugin.CheckDeclarations(p); err != nil {
			panic(err)
		}
		s.hosted = append(s.hosted, hostedPlugin{plugin: p, manifest: manifest, definition: byID[manifest.ID]})
	}
	// Catalog order, so every generic loop is deterministic.
	sort.SliceStable(s.hosted, func(i, j int) bool {
		return strings.ToLower(s.hosted[i].definition.Name) < strings.ToLower(s.hosted[j].definition.Name)
	})
	for _, hosted := range s.hosted {
		if initializer, ok := hosted.plugin.(plugin.Initializer); ok {
			if err := initializer.Init(context.Background(), s.hostFor(hosted.manifest.ID)); err != nil {
				panic(fmt.Errorf("plugin %s: init: %w", hosted.manifest.ID, err))
			}
		}
	}
}

func (s *Service) hostFor(id string) plugin.Host {
	return plugin.Host{
		DB:           s.db,
		Logger:       s.logger.With("plugin", id),
		Installation: installationService{service: s, id: id},
		Audit:        auditService{},
		Manifests:    manifestService{service: s, id: id},
		Targets:      targetService{},
		Screens:      screenService{service: s},
		Organization: organizationService{service: s},
		Clock:        s.clock,
	}
}

// lookup returns a definition this Service hosts.
func (s *Service) lookup(id string) (Definition, bool) {
	for _, definition := range s.definitions {
		if definition.ID == id {
			return definition, true
		}
	}
	return Definition{}, false
}

func (s *Service) hostedPlugin(id string) (hostedPlugin, bool) {
	for _, hosted := range s.hosted {
		if hosted.manifest.ID == id {
			return hosted, true
		}
	}
	return hostedPlugin{}, false
}

// ----------------------------------------------------------- host services

type installationService struct {
	service *Service
	id      string
}

func (i installationService) Installed(ctx context.Context) (bool, error) {
	return i.service.IsInstalled(ctx, i.id)
}

func (i installationService) Require(ctx context.Context) error {
	return i.service.RequireInstalled(ctx, i.id)
}

func (i installationService) LockInTx(ctx context.Context, tx pgx.Tx) error {
	return i.service.lockInstallation(ctx, tx, i.id)
}

type auditService struct{}

func (auditService) RecordInTx(ctx context.Context, tx pgx.Tx, event plugin.AuditEvent) error {
	if strings.TrimSpace(event.Action) == "" || strings.TrimSpace(event.ResourceType) == "" {
		return errors.New("plugin audit event needs an action and a resource type")
	}
	metadata := event.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	var name *string
	if event.ResourceName != "" {
		name = &event.ResourceName
	}
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,metadata)
		VALUES($1,$2,$3,$4,$5,$6,$7)`,
		uuid.New(), nullableUser(event.UserID), event.Action, event.ResourceType, event.ResourceID, name, metadata)
	return err
}

type manifestService struct {
	service *Service
	id      string
}

func (m manifestService) InvalidateResourceInTx(ctx context.Context, tx pgx.Tx, resourceID uuid.UUID, reason string) (plugin.AfterCommit, error) {
	notes, err := m.service.bumpPlugin(ctx, tx, m.id, resourceID, reason)
	if err != nil {
		return nil, err
	}
	return func() { m.service.notify(notes) }, nil
}

func (m manifestService) InvalidateAllInTx(ctx context.Context, tx pgx.Tx, reason string) (plugin.AfterCommit, error) {
	notes, err := bumpAllScreens(ctx, tx, reason)
	if err != nil {
		return nil, err
	}
	return func() { m.service.notify(notes) }, nil
}

type targetService struct{}

func (targetService) ValidateInTx(ctx context.Context, tx pgx.Tx, target plugin.Target) error {
	if err := target.Validate(); err != nil {
		return err
	}
	return validateTargets(ctx, tx, target.Scope, target.IDs)
}

type screenService struct{ service *Service }

func (s screenService) PairedPlatforms(ctx context.Context) (map[string]int, error) {
	rows, err := s.service.db.Query(ctx, `SELECT platform,count(*) FROM screens WHERE archived_at IS NULL GROUP BY platform`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var platform string
		var count int
		if err = rows.Scan(&platform, &count); err != nil {
			return nil, err
		}
		counts[platform] = count
	}
	return counts, rows.Err()
}

type organizationService struct{ service *Service }

func (o organizationService) ID(ctx context.Context) (uuid.UUID, error) {
	var id uuid.UUID
	err := o.service.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&id)
	return id, err
}

// ----------------------------------------------------------- routes

// Route is one plugin HTTP route for the API layer to mount below /api/v1.
type Route struct {
	PluginID string
	Method   string
	Pattern  string
	Access   plugin.Access
	Handler  plugin.Handler
}

// Routes collects every plugin's routes. Routes are mounted whether or not
// the plugin is installed: reads and deletes keep working so leftover data
// can be inspected and cleaned up, and every configuration write refuses an
// uninstalled plugin itself through Installation.
func (s *Service) Routes() ([]Route, error) {
	out := []Route{}
	seen := map[string]string{}
	for _, hosted := range s.hosted {
		provider, ok := hosted.plugin.(plugin.RouteProvider)
		if !ok {
			continue
		}
		routes, err := plugin.CollectRoutes(hosted.manifest, provider)
		if err != nil {
			return nil, err
		}
		for _, route := range routes {
			key := route.Method + " " + route.Pattern
			if owner, dup := seen[key]; dup {
				return nil, fmt.Errorf("plugin %s: route %s is also registered by %s", hosted.manifest.ID, key, owner)
			}
			seen[key] = hosted.manifest.ID
			out = append(out, Route{PluginID: hosted.manifest.ID, Method: route.Method, Pattern: route.Pattern, Access: route.Access, Handler: route.Handler})
		}
	}
	return out, nil
}

// ----------------------------------------------------------- workers and maintenance

// Worker is a plugin background worker with its owner's identity.
type Worker struct {
	PluginID string
	plugin.Worker
}

// Workers lists every plugin background worker. Each worker gates its own
// work on installation, so an uninstalled plugin makes no upstream request.
func (s *Service) Workers() []Worker {
	out := []Worker{}
	for _, hosted := range s.hosted {
		if provider, ok := hosted.plugin.(plugin.WorkerProvider); ok {
			for _, worker := range provider.Workers() {
				out = append(out, Worker{PluginID: hosted.manifest.ID, Worker: worker})
			}
		}
	}
	return out
}

// RunWorkers starts every plugin worker and returns when all of them have
// stopped. A worker that fails is logged; the others keep running.
func (s *Service) RunWorkers(ctx context.Context) {
	workers := s.Workers()
	done := make(chan struct{}, len(workers))
	for _, worker := range workers {
		go func(worker Worker) {
			defer func() { done <- struct{}{} }()
			if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Error("plugin worker stopped", "plugin", worker.PluginID, "worker", worker.Name, "error", err)
			}
		}(worker)
	}
	for range workers {
		<-done
	}
}

// RunMaintenance runs every plugin maintenance task once. It is called from
// the host's bounded periodic maintenance pass.
func (s *Service) RunMaintenance(ctx context.Context) {
	for _, hosted := range s.hosted {
		provider, ok := hosted.plugin.(plugin.MaintenanceProvider)
		if !ok {
			continue
		}
		for _, task := range provider.Maintenance() {
			changed, err := task.Run(ctx)
			if err != nil {
				s.logger.Warn("plugin maintenance failed", "plugin", hosted.manifest.ID, "task", task.Name, "error", err)
				continue
			}
			if changed > 0 {
				s.logger.Info("plugin maintenance completed", "plugin", hosted.manifest.ID, "task", task.Name, "rows_changed", changed)
			}
		}
	}
}

// ----------------------------------------------------------- heartbeat

// HeartbeatSections lists the optional heartbeat sections plugins consume, by
// name. The heartbeat decoder accepts exactly these names in addition to its
// own fields.
func (s *Service) HeartbeatSections() map[string]plugin.HeartbeatSection {
	out := map[string]plugin.HeartbeatSection{}
	for _, hosted := range s.hosted {
		if consumer, ok := hosted.plugin.(plugin.HeartbeatConsumer); ok {
			for _, section := range consumer.HeartbeatSections() {
				out[section.Name] = section
			}
		}
	}
	return out
}

// ----------------------------------------------------------- assets

// ScreensUsingAsset asks every installed plugin which screens draw an asset,
// so a media change reaches a screen through a plugin as well as through its
// content.
func (s *Service) ScreensUsingAsset(ctx context.Context, tx pgx.Tx, assetID uuid.UUID) ([]uuid.UUID, error) {
	var out []uuid.UUID
	for _, hosted := range s.hosted {
		dependent, ok := hosted.plugin.(plugin.AssetDependent)
		if !ok {
			continue
		}
		installed, err := isInstalled(ctx, tx, hosted.manifest.ID)
		if err != nil {
			return nil, err
		}
		if !installed {
			continue
		}
		screens, err := dependent.ScreensUsingAsset(ctx, tx, assetID)
		if err != nil {
			return nil, fmt.Errorf("plugin %s: %w", hosted.manifest.ID, err)
		}
		out = append(out, screens...)
	}
	return out, nil
}
