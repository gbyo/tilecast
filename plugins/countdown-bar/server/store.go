package server

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

const columns = `id,name,message,schedule_type,target_time::text,days_of_week,one_time_at,timezone,
	lead_time_seconds,completion_text,show_confetti,display_mode,height_px,progress_fill,content_padding,text_scale,font_id,
	urgency_enabled,starting_soon_seconds,urgent_seconds,pulse_seconds,enabled,priority,target_scope,created_at,updated_at`

type scanner interface{ Scan(...any) error }

func scan(row scanner) (CountdownBar, error) {
	var item CountdownBar
	var targetTime *string
	var contentPadding int
	err := row.Scan(&item.ID, &item.Name, &item.Message, &item.ScheduleType, &targetTime, &item.DaysOfWeek,
		&item.OneTimeAt, &item.Timezone, &item.LeadTimeSeconds, &item.CompletionText, &item.ShowConfetti,
		&item.DisplayMode, &item.HeightPX, &item.ProgressFill, &contentPadding, &item.TextScale, &item.FontID,
		&item.UrgencyEnabled, &item.StartingSoonSeconds, &item.UrgentSeconds, &item.PulseSeconds,
		&item.Enabled, &item.Priority, &item.TargetScope, &item.CreatedAt, &item.UpdatedAt)
	item.ContentPadding = &contentPadding
	item.TargetTime = trimTargetTime(targetTime)
	return item, err
}

// List returns every instance, highest priority first.
func (p *Plugin) List(ctx context.Context) ([]CountdownBar, error) {
	rows, err := p.host.DB.Query(ctx, `SELECT `+columns+` FROM countdown_bar_instances ORDER BY priority DESC,lower(name),id`)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (CountdownBar, error) { return scan(row) })
	if err != nil {
		return nil, err
	}
	// Targets are read after the instance cursor is drained so a listing needs
	// one pooled connection at a time.
	for index := range items {
		if items[index].TargetIDs, err = p.targets(ctx, items[index].ID); err != nil {
			return nil, err
		}
	}
	return items, nil
}

// Get returns one instance or plugin.ErrNotFound.
func (p *Plugin) Get(ctx context.Context, id uuid.UUID) (CountdownBar, error) {
	item, err := scan(p.host.DB.QueryRow(ctx, `SELECT `+columns+` FROM countdown_bar_instances WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return CountdownBar{}, plugin.ErrNotFound
	}
	if err != nil {
		return CountdownBar{}, err
	}
	item.TargetIDs, err = p.targets(ctx, id)
	return item, err
}

func (p *Plugin) targets(ctx context.Context, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := p.host.DB.Query(ctx, `SELECT target_id FROM countdown_bar_targets WHERE instance_id=$1 ORDER BY target_id`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// Create stores a new instance. The plugin must be installed.
func (p *Plugin) Create(ctx context.Context, userID uuid.UUID, input Input) (CountdownBar, error) {
	id := uuid.New()
	if err := p.write(ctx, id, userID, input, true); err != nil {
		return CountdownBar{}, err
	}
	return p.Get(ctx, id)
}

// Update replaces an instance. The plugin must be installed.
func (p *Plugin) Update(ctx context.Context, id, userID uuid.UUID, input Input) (CountdownBar, error) {
	if err := p.write(ctx, id, userID, input, false); err != nil {
		return CountdownBar{}, err
	}
	return p.Get(ctx, id)
}

func (p *Plugin) write(ctx context.Context, id, userID uuid.UUID, input Input, create bool) error {
	input = Normalize(input)
	if err := Validate(input); err != nil {
		return err
	}
	if input.DaysOfWeek == nil {
		input.DaysOfWeek = []int{}
	}
	// Read host facts before the transaction: a pool read while tx holds a
	// connection needs a second one, and a one-connection or saturated pool
	// would wait on the connection this transaction itself holds.
	var organizationID uuid.UUID
	if create {
		var err error
		if organizationID, err = p.host.Organization.ID(ctx); err != nil {
			return err
		}
	}
	tx, err := p.host.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err = p.host.Installation.LockInTx(ctx, tx); err != nil {
		return err
	}
	if err = p.host.Targets.ValidateInTx(ctx, tx, plugin.Target{Scope: input.TargetScope, IDs: input.TargetIDs}); err != nil {
		return err
	}
	// A Studio operator may change an instance only when it can target both
	// the screens the instance reaches now and the ones it will reach.
	if !create {
		if err = p.authorizeStored(ctx, tx, id); err != nil {
			return err
		}
	}
	if err = p.authorize(ctx, tx, plugin.Target{Scope: input.TargetScope, IDs: input.TargetIDs}); err != nil {
		return err
	}
	var targetTime any
	if input.TargetTime != nil {
		targetTime = *input.TargetTime
	}
	if create {
		_, err = tx.Exec(ctx, `INSERT INTO countdown_bar_instances
			(id,organization_id,name,message,schedule_type,target_time,days_of_week,one_time_at,timezone,lead_time_seconds,
			 completion_text,show_confetti,display_mode,height_px,progress_fill,content_padding,text_scale,font_id,
			 urgency_enabled,starting_soon_seconds,urgent_seconds,pulse_seconds,enabled,priority,target_scope,created_by)
			VALUES($1,$2,$3,$4,$5,$6::time,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
			id, organizationID, strings.TrimSpace(input.Name), strings.TrimSpace(input.Message), input.ScheduleType,
			targetTime, input.DaysOfWeek, input.OneTimeAt, input.Timezone, input.LeadTimeSeconds,
			strings.TrimSpace(input.CompletionText), input.ShowConfetti, input.DisplayMode, input.HeightPX, input.ProgressFill, *input.ContentPadding, input.TextScale, input.FontID,
			input.UrgencyEnabled, input.StartingSoonSeconds, input.UrgentSeconds, input.PulseSeconds, input.Enabled, input.Priority, input.TargetScope, userID)
	} else {
		tag, updateErr := tx.Exec(ctx, `UPDATE countdown_bar_instances SET name=$2,message=$3,schedule_type=$4,target_time=$5::time,
			days_of_week=$6,one_time_at=$7,timezone=$8,lead_time_seconds=$9,completion_text=$10,show_confetti=$11,display_mode=$12,height_px=$13,
			progress_fill=$14,content_padding=$15,text_scale=$16,font_id=$17,urgency_enabled=$18,starting_soon_seconds=$19,
			urgent_seconds=$20,pulse_seconds=$21,enabled=$22,priority=$23,target_scope=$24,updated_at=now() WHERE id=$1`,
			id, strings.TrimSpace(input.Name), strings.TrimSpace(input.Message), input.ScheduleType, targetTime,
			input.DaysOfWeek, input.OneTimeAt, input.Timezone, input.LeadTimeSeconds, strings.TrimSpace(input.CompletionText),
			input.ShowConfetti, input.DisplayMode, input.HeightPX, input.ProgressFill, *input.ContentPadding, input.TextScale, input.FontID,
			input.UrgencyEnabled, input.StartingSoonSeconds, input.UrgentSeconds, input.PulseSeconds, input.Enabled, input.Priority, input.TargetScope)
		err = updateErr
		if err == nil && tag.RowsAffected() == 0 {
			return plugin.ErrNotFound
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM countdown_bar_targets WHERE instance_id=$1`, id); err != nil {
		return err
	}
	for _, targetID := range input.TargetIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO countdown_bar_targets(instance_id,target_type,target_id) VALUES($1,$2,$3)`, id, input.TargetScope, targetID); err != nil {
			return err
		}
	}
	// The library refuses to remove a family while an instance uses it.
	// Disabled instances count: enabling one must not find the font gone.
	var fontIDs []uuid.UUID
	if input.FontID != nil {
		fontIDs = append(fontIDs, *input.FontID)
	}
	if err = p.host.Fonts.UseInTx(ctx, tx, id, strings.TrimSpace(input.Name), fontIDs...); err != nil {
		return err
	}
	action := "plugin.countdown_bar.updated"
	if create {
		action = "plugin.countdown_bar.created"
	}
	if err = p.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{UserID: userID, Action: action, ResourceType: "plugin", ResourceID: id.String()}); err != nil {
		return err
	}
	notify, err := p.host.Manifests.InvalidateResourceInTx(ctx, tx, id, "plugin.countdown_bar.changed")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	notify()
	return nil
}

// Delete removes an instance. It works whether or not the plugin is
// installed, so leftover data can always be cleaned up.
func (p *Plugin) Delete(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := p.host.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err = p.authorizeStored(ctx, tx, id); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM countdown_bar_instances WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return plugin.ErrNotFound
	}
	if err = p.host.Fonts.ReleaseInTx(ctx, tx, id); err != nil {
		return err
	}
	if err = p.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{UserID: userID, Action: "plugin.countdown_bar.deleted", ResourceType: "plugin", ResourceID: id.String()}); err != nil {
		return err
	}
	notify, err := p.host.Manifests.InvalidateResourceInTx(ctx, tx, id, "plugin.countdown_bar.deleted")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	notify()
	return nil
}

// authorize decides target for the Studio operator of ctx. Work without an
// operator (demo seeding, background jobs) acts for the installation.
func (p *Plugin) authorize(ctx context.Context, tx pgx.Tx, target plugin.Target) error {
	principal, ok := plugin.PrincipalFrom(ctx)
	if !ok {
		return nil
	}
	if p.host.ScreenAccess == nil {
		return fmt.Errorf("%w: screen access decisions are unavailable", plugin.ErrOutOfScope)
	}
	return p.host.ScreenAccess.AuthorizeTargetInTx(ctx, tx, principal, target)
}

// authorizeStored decides the target an instance has now. A missing
// instance passes, so the write reports its own not-found.
func (p *Plugin) authorizeStored(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	if _, ok := plugin.PrincipalFrom(ctx); !ok {
		return nil
	}
	var scope string
	err := tx.QueryRow(ctx, `SELECT target_scope FROM countdown_bar_instances WHERE id=$1 FOR UPDATE`, id).Scan(&scope)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT target_id FROM countdown_bar_targets WHERE instance_id=$1`, id)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	return p.authorize(ctx, tx, plugin.Target{Scope: scope, IDs: ids})
}
