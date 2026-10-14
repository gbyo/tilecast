package externalplugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/execution"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
	"github.com/tilecast/tilecast/apps/server/internal/targeting"
	externalplugin "github.com/tilecast/tilecast/packages/package-sdk/go/plugin"
)

type Payloads interface {
	CurrentPluginPayload(context.Context, string, string, uuid.UUID) (Payload, bool, error)
}
type Notifier interface{ ManifestChanged(uuid.UUID, int64) }
type Authorizer interface {
	AuthorizeTargetDefinitionInTx(context.Context, pgx.Tx, uuid.UUID, string, targeting.Definition) error
}
type Service struct {
	db         *pgxpool.Pool
	payloads   Payloads
	notifier   Notifier
	now        func() time.Time
	authorizer Authorizer
}

func NewService(db *pgxpool.Pool, payloads Payloads, notifier Notifier, authorizer Authorizer) *Service {
	return &Service{db: db, payloads: payloads, notifier: notifier, now: time.Now, authorizer: authorizer}
}

func (s *Service) begin(ctx context.Context, call Invocation, id string) (context.Context, pgx.Tx, Payload, error) {
	if call.Epoch == uuid.Nil {
		return ctx, nil, Payload{}, execution.ErrChanged
	}
	nested, owned := strings.CutPrefix(id, call.PackageID+".")
	if !owned || len(nested) == 0 {
		return ctx, nil, Payload{}, ErrNotFound
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return ctx, nil, Payload{}, err
	}
	refuse := func(err error) (context.Context, pgx.Tx, Payload, error) {
		_ = tx.Rollback(ctx)
		return ctx, nil, Payload{}, err
	}
	ctx, err = execution.Lock(ctx, tx, call.PackageID)
	if err != nil {
		return refuse(err)
	}
	if _, err := execution.Check(ctx, tx, call.PackageID, call.Digest, call.Epoch); err != nil {
		return refuse(err)
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM installed_package_contributions WHERE package_id=$1 AND kind='plugin' AND contribution_id=$2)`, call.PackageID, id).Scan(&exists); err != nil {
		return refuse(err)
	}
	if !exists || s.payloads == nil {
		return refuse(ErrNotFound)
	}
	payload, ok, err := s.payloads.CurrentPluginPayload(ctx, call.PackageID, nested, call.Epoch)
	if err != nil {
		return refuse(err)
	}
	if !ok || payload.PackageDigest != call.Digest || payload.ContributionID != id || !payload.Descriptor.Capabilities.PlayerManifest {
		return refuse(ErrNotFound)
	}
	return ctx, tx, payload, nil
}

func readView(ctx context.Context, q targeting.Query, pkg, id string, lock bool) (View, error) {
	view := View{ContributionID: id, Configuration: json.RawMessage(`{}`)}
	var targets []byte
	query := `SELECT enabled,configuration,targets,configuration_revision,state,valid_until,published_at
 FROM external_plugin_runtime_state WHERE package_id=$1 AND contribution_id=$2`
	if lock {
		query += ` FOR UPDATE`
	}
	err := q.QueryRow(ctx, query, pkg, id).Scan(&view.Enabled, &view.Configuration, &targets, &view.ConfigurationRevision, &view.State, &view.ValidUntil, &view.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return view, nil
	}
	if err != nil {
		return View{}, err
	}
	var definition targeting.Definition
	if err := json.Unmarshal(targets, &definition); err != nil {
		return View{}, err
	}
	view.Targets = &definition
	return view, nil
}

func (s *Service) Get(ctx context.Context, call Invocation, id string) (View, error) {
	ctx, tx, _, err := s.begin(ctx, call, id)
	if err != nil {
		return View{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	return readView(ctx, tx, call.PackageID, id, false)
}

func (s *Service) Configure(ctx context.Context, call Invocation, input ConfigureInput) (View, error) {
	input.Targets = input.Targets.Canonical()
	if call.Actor == nil || *call.Actor == uuid.Nil {
		return View{}, fmt.Errorf("%w: configuration requires an operator", ErrInvalid)
	}
	configuration, err := normalizeState(input.Configuration)
	if err != nil {
		return View{}, err
	}
	ctx, tx, _, err := s.begin(ctx, call, input.ContributionID)
	if err != nil {
		return View{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := targeting.Validate(ctx, tx, input.Targets); err != nil {
		return View{}, err
	}
	previous, err := readView(ctx, tx, call.PackageID, input.ContributionID, true)
	if err != nil {
		return View{}, err
	}
	if err := s.authorize(ctx, tx, call, input.Targets); err != nil {
		return View{}, err
	}
	if previous.Targets != nil {
		if err := s.authorize(ctx, tx, call, *previous.Targets); err != nil {
			return View{}, err
		}
	}
	if previous.ConfigurationRevision != input.ExpectedConfigurationRevision {
		return View{}, ErrConflict
	}
	if input.Enabled && !previous.Enabled {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('external_plugin_enabled',0))`); err != nil {
			return View{}, err
		}
		var enabled int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM external_plugin_runtime_state WHERE enabled`).Scan(&enabled); err != nil {
			return View{}, err
		}
		if enabled >= MaxEnabledInstances {
			return View{}, fmt.Errorf("%w: too many enabled external plugins", ErrInvalid)
		}
	}
	oldScreens := []uuid.UUID{}
	if previous.Targets != nil {
		oldScreens, err = targeting.Resolve(ctx, tx, *previous.Targets)
		if err != nil {
			return View{}, err
		}
	}
	newScreens, err := targeting.Resolve(ctx, tx, input.Targets)
	if err != nil {
		return View{}, err
	}
	targets, err := json.Marshal(input.Targets)
	if err != nil {
		return View{}, err
	}
	if previous.ConfigurationRevision > 0 {
		var same bool
		if err := tx.QueryRow(ctx, `SELECT enabled=$3 AND configuration=$4::jsonb AND targets=$5::jsonb FROM external_plugin_runtime_state WHERE package_id=$1 AND contribution_id=$2`, call.PackageID, input.ContributionID, input.Enabled, configuration, targets).Scan(&same); err != nil {
			return View{}, err
		}
		if same {
			return previous, nil
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO external_plugin_runtime_state
 (organization_id,package_id,contribution_id,enabled,configuration,targets,configuration_revision)
 SELECT organization_id,$1,$2,$3,$4,$5,1 FROM installed_packages WHERE package_id=$1
 ON CONFLICT(organization_id,package_id,contribution_id) DO UPDATE SET enabled=EXCLUDED.enabled,
 configuration=EXCLUDED.configuration,targets=EXCLUDED.targets,configuration_revision=external_plugin_runtime_state.configuration_revision+1,
 state=NULL,valid_until=NULL,published_at=NULL,definition_version=NULL,configured_at=now()`, call.PackageID, input.ContributionID, input.Enabled, configuration, targets)
	if err != nil {
		return View{}, err
	}
	changes, err := s.invalidate(ctx, tx, append(oldScreens, newScreens...), "external_plugin.configured")
	if err != nil {
		return View{}, err
	}
	if err := audit.RecordTx(ctx, tx, audit.Event{Action: "package.plugin.configured", ResourceType: "external_plugin", ResourceID: input.ContributionID, Actor: call.Actor, Surface: audit.SurfaceStudio, Summary: "External plugin configuration changed", Metadata: map[string]any{"packageId": call.PackageID, "enabled": input.Enabled}}); err != nil {
		return View{}, err
	}
	view, err := readView(ctx, tx, call.PackageID, input.ContributionID, false)
	if err != nil {
		return View{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return View{}, err
	}
	s.notify(changes)
	return view, nil
}

func (s *Service) Publish(ctx context.Context, call Invocation, input PublishInput) (View, error) {
	state, err := normalizeState(input.State)
	if err != nil {
		return View{}, err
	}
	now := s.now().UTC()
	if input.ValidUntil.IsZero() || !input.ValidUntil.After(now) || input.ValidUntil.After(now.Add(MaxValidity)) {
		return View{}, fmt.Errorf("%w: validity must end within five minutes", ErrInvalid)
	}
	ctx, tx, payload, err := s.begin(ctx, call, input.ContributionID)
	if err != nil {
		return View{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	view, err := readView(ctx, tx, call.PackageID, input.ContributionID, true)
	if err != nil {
		return View{}, err
	}
	if view.ConfigurationRevision == 0 || view.ConfigurationRevision != input.ConfigurationRevision {
		return View{}, ErrConflict
	}
	if !view.Enabled || view.Targets == nil {
		return View{}, fmt.Errorf("%w: plugin is disabled", ErrConflict)
	}
	if err := s.authorize(ctx, tx, call, *view.Targets); err != nil {
		return View{}, err
	}
	var same bool
	if err := tx.QueryRow(ctx, `SELECT COALESCE(state=$3::jsonb AND valid_until=$4 AND definition_version=$5,false) FROM external_plugin_runtime_state WHERE package_id=$1 AND contribution_id=$2`, call.PackageID, input.ContributionID, state, input.ValidUntil, int(payload.Descriptor.DefinitionVersion)).Scan(&same); err != nil {
		return View{}, err
	}
	if same {
		return view, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE external_plugin_runtime_state SET state=$3,valid_until=$4,published_at=$5,definition_version=$6 WHERE package_id=$1 AND contribution_id=$2`, call.PackageID, input.ContributionID, state, input.ValidUntil, now, int(payload.Descriptor.DefinitionVersion)); err != nil {
		return View{}, err
	}
	screens, err := targeting.Resolve(ctx, tx, *view.Targets)
	if err != nil {
		return View{}, err
	}
	changes, err := s.invalidate(ctx, tx, screens, "external_plugin.state")
	if err != nil {
		return View{}, err
	}
	view, err = readView(ctx, tx, call.PackageID, input.ContributionID, false)
	if err != nil {
		return View{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return View{}, err
	}
	s.notify(changes)
	return view, nil
}

func (s *Service) Clear(ctx context.Context, call Invocation, id string, revision int64) (View, error) {
	ctx, tx, _, err := s.begin(ctx, call, id)
	if err != nil {
		return View{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	view, err := readView(ctx, tx, call.PackageID, id, true)
	if err != nil {
		return View{}, err
	}
	if view.ConfigurationRevision == 0 || view.ConfigurationRevision != revision {
		return View{}, ErrConflict
	}
	if view.State == nil {
		return view, nil
	}
	if view.Targets == nil {
		return View{}, ErrInvalid
	}
	if err := s.authorize(ctx, tx, call, *view.Targets); err != nil {
		return View{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE external_plugin_runtime_state SET state=NULL,valid_until=NULL,published_at=NULL,definition_version=NULL WHERE package_id=$1 AND contribution_id=$2`, call.PackageID, id); err != nil {
		return View{}, err
	}
	screens, err := targeting.Resolve(ctx, tx, *view.Targets)
	if err != nil {
		return View{}, err
	}
	changes, err := s.invalidate(ctx, tx, screens, "external_plugin.cleared")
	if err != nil {
		return View{}, err
	}
	view.State = nil
	view.ValidUntil = nil
	view.PublishedAt = nil
	if err := tx.Commit(ctx); err != nil {
		return View{}, err
	}
	s.notify(changes)
	return view, nil
}

func (s *Service) notify(changes []manifestchanges.Change) {
	if s.notifier != nil {
		for _, change := range changes {
			s.notifier.ManifestChanged(change.ScreenID, change.Version)
		}
	}
}

// Unsupported Players receive no external entry, so a state publication must
// not advance their manifest or restart playback as a side effect.
func (s *Service) invalidate(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, reason string) ([]manifestchanges.Change, error) {
	rows, err := tx.Query(ctx, `SELECT screen_id FROM screen_player_status WHERE screen_id=ANY($1)
 AND cardinality(presentation_schema_versions)>0
 AND jsonb_typeof(native_presentation_capabilities->$2)='number'
 AND native_presentation_capabilities->$2>='1'::jsonb ORDER BY screen_id`, ids, externalplugin.RuntimeCapability)
	if err != nil {
		return nil, err
	}
	eligible := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			break
		}
		eligible = append(eligible, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	return manifestchanges.BumpScreens(ctx, tx, eligible, reason)
}

func (s *Service) authorize(ctx context.Context, tx pgx.Tx, call Invocation, targets targeting.Definition) error {
	if call.Actor == nil {
		return nil
	}
	if call.ActorRole != "owner" && call.ActorRole != "administrator" {
		return fmt.Errorf("%w: configuration requires an Owner or Administrator", ErrInvalid)
	}
	if s.authorizer == nil {
		return fmt.Errorf("external plugin authorization is unavailable")
	}
	return s.authorizer.AuthorizeTargetDefinitionInTx(ctx, tx, *call.Actor, call.ActorRole, targets)
}
