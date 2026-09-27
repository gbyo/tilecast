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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
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

func WithTakeovers(service plugin.Takeovers) Option {
	return func(s *Service) { s.takeovers = service }
}
func WithManagedPresentations(service plugin.ManagedPresentations) Option {
	return func(s *Service) { s.managedPresentations = service }
}
func WithBackgroundJobs(gate plugin.BackgroundJobs) Option {
	return func(s *Service) { s.backgroundJobs = gate }
}

type backgroundGate func() bool

func (gate backgroundGate) Allowed() bool { return gate() }
func WithBackgroundJobsAllowed(allowed func() bool) Option {
	return WithBackgroundJobs(backgroundGate(allowed))
}
func WithPublicURL(url string) Option { return func(s *Service) { s.publicURL = url } }

type publicInstance string

func (p publicInstance) PublicURL() string { return string(p) }

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
	// The Data Sources service is bound to the provider ID the plugin
	// contributes. A plugin that contributes none receives a service that
	// refuses every provider-scoped call, so it cannot accidentally operate
	// on another plugin's rows.
	provider := ""
	if hosted, ok := s.hostedPlugin(id); ok {
		if contributor, ok := hosted.plugin.(plugin.DataSourceProvider); ok {
			provider = contributor.ProviderID()
		}
	}
	return plugin.Host{
		DB:                   s.db,
		Logger:               s.logger.With("plugin", id),
		Installation:         installationService{service: s, id: id},
		Audit:                auditService{},
		Manifests:            manifestService{service: s, id: id},
		Targets:              targetService{db: s.db},
		Takeovers:            s.takeovers,
		ManagedPresentations: s.managedPresentations,
		BackgroundJobs:       s.backgroundJobs,
		Instance:             publicInstance(s.publicURL),
		Screens:              screenService{service: s},
		Organization:         organizationService{service: s},
		Clock:                s.clock,
		DataSources:          dataSourceService{db: s.db, invalidator: s.dsInvalidator, pluginID: id, provider: provider},
		Users:                userService{db: s.db},
		PluginAssets:         pluginAssetService{db: s.db, backend: s.attachments, pluginID: id},
	}
}

// Host returns the services a hosted plugin receives. Tests use it; the
// server gives each plugin its Host through Init.
func (s *Service) Host(id string) (plugin.Host, bool) {
	if _, ok := s.hostedPlugin(id); !ok {
		return plugin.Host{}, false
	}
	return s.hostFor(id), true
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

// RecordInTx writes a plugin audit event through the shared audit path, so
// plugin events gain the request's attribution automatically: the human
// user, the calling surface, and the request ID all flow from context. The
// plugin's explicit UserID wins when the plugin names an actor; otherwise
// the context principal applies.
func (auditService) RecordInTx(ctx context.Context, tx pgx.Tx, event plugin.AuditEvent) error {
	if strings.TrimSpace(event.Action) == "" || strings.TrimSpace(event.ResourceType) == "" {
		return errors.New("plugin audit event needs an action and a resource type")
	}
	record := audit.Event{
		Action:       event.Action,
		ResourceType: event.ResourceType,
		ResourceID:   event.ResourceID,
		ResourceName: event.ResourceName,
		Metadata:     event.Metadata,
	}
	if event.UserID != uuid.Nil {
		actor := event.UserID
		record.Actor = &actor
	}
	return audit.RecordTx(ctx, tx, record)
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

func (m manifestService) InvalidateScreensInTx(ctx context.Context, tx pgx.Tx, screenIDs []uuid.UUID, reason string) (plugin.AfterCommit, error) {
	notes, err := bumpScreens(ctx, tx, screenIDs, reason)
	if err != nil {
		return nil, err
	}
	return func() { m.service.notify(notes) }, nil
}

type targetService struct{ db *pgxpool.Pool }

func (targetService) ValidateInTx(ctx context.Context, tx pgx.Tx, target plugin.Target) error {
	if err := target.Validate(); err != nil {
		return err
	}
	return validateTargets(ctx, tx, target.Scope, target.IDs)
}

func (targetService) ValidateScreenTargetsInTx(ctx context.Context, tx pgx.Tx, targets plugin.ScreenTargets) error {
	if len(targets.ScreenIDs)+len(targets.GroupIDs) > 1000 {
		return fmt.Errorf("%w: too many screen targets", plugin.ErrInvalid)
	}
	for _, item := range []struct {
		ids              []uuid.UUID
		table, condition string
	}{
		{targets.ScreenIDs, "screens", "deleted_at IS NULL AND archived_at IS NULL"},
		{targets.GroupIDs, "screen_groups", "deleted_at IS NULL"},
	} {
		seen := map[uuid.UUID]bool{}
		for _, id := range item.ids {
			if id == uuid.Nil || seen[id] {
				return fmt.Errorf("%w: duplicate or empty target", plugin.ErrInvalid)
			}
			seen[id] = true
		}
		var count int
		err := tx.QueryRow(ctx, `SELECT count(*) FROM `+item.table+` WHERE id=ANY($1) AND organization_id=(SELECT id FROM organization_settings WHERE singleton) AND `+item.condition, item.ids).Scan(&count)
		if err != nil {
			return err
		}
		if count != len(item.ids) {
			return fmt.Errorf("%w: one or more targets do not exist", plugin.ErrInvalid)
		}
	}
	return nil
}

func (targetService) ResolveScreensInTx(ctx context.Context, tx pgx.Tx, targets plugin.ScreenTargets) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT s.id FROM screens s WHERE s.organization_id=(SELECT id FROM organization_settings WHERE singleton) AND s.deleted_at IS NULL AND s.archived_at IS NULL AND (s.id=ANY($1) OR EXISTS(SELECT 1 FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id WHERE m.screen_id=s.id AND m.screen_group_id=ANY($2) AND g.deleted_at IS NULL)) ORDER BY s.id`, targets.ScreenIDs, targets.GroupIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (t targetService) AppliesToScreen(ctx context.Context, screenID uuid.UUID, targets plugin.ScreenTargets) (bool, error) {
	var applies bool
	err := t.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens s WHERE s.id=$1 AND s.organization_id=(SELECT id FROM organization_settings WHERE singleton) AND s.deleted_at IS NULL AND s.archived_at IS NULL AND (s.id=ANY($2) OR EXISTS(SELECT 1 FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id WHERE m.screen_id=s.id AND m.screen_group_id=ANY($3) AND g.deleted_at IS NULL)))`, screenID, targets.ScreenIDs, targets.GroupIDs).Scan(&applies)
	return applies, err
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
	PluginID  string
	Method    string
	Pattern   string
	Access    plugin.Access
	RateLimit plugin.RateLimit
	Handler   plugin.Handler
}

// Routes collects every plugin's routes. Routes are mounted whether or not
// the plugin is installed: reads and deletes keep working so leftover data
// can be inspected and cleaned up, and every configuration write refuses an
// uninstalled plugin itself through Installation.
func (s *Service) Routes() ([]Route, error) {
	out := []Route{}
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
			// Two plugins must never answer one path: compare route shapes,
			// not spellings, so /a/{id} also collides with /a/install.
			for _, other := range out {
				if other.Method == route.Method && plugin.RoutePatternsOverlap(other.Pattern, route.Pattern) {
					return nil, fmt.Errorf("plugin %s: route %s %s overlaps %s %s of plugin %s",
						hosted.manifest.ID, route.Method, route.Pattern, other.Method, other.Pattern, other.PluginID)
				}
			}
			out = append(out, Route{PluginID: hosted.manifest.ID, Method: route.Method, Pattern: route.Pattern, Access: route.Access, RateLimit: route.RateLimit, Handler: route.Handler})
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

// ----------------------------------------------------------- demo

// SeedDemo installs every plugin that contributes Demo Mode data and asks it
// to seed. It is called only while a demo scenario is being built.
func (s *Service) SeedDemo(ctx context.Context, demo plugin.Demo) error {
	for _, hosted := range s.hosted {
		seeder, ok := hosted.plugin.(plugin.DemoSeeder)
		if !ok {
			continue
		}
		if _, _, err := s.Install(ctx, hosted.manifest.ID, demo.OwnerID); err != nil {
			return fmt.Errorf("install plugin %s: %w", hosted.manifest.ID, err)
		}
		if err := seeder.SeedDemo(ctx, demo); err != nil {
			return fmt.Errorf("plugin %s: seed demo: %w", hosted.manifest.ID, err)
		}
	}
	return nil
}
