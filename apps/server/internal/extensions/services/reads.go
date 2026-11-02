package services

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	plugin "github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// This file implements the read operations. Every handler reuses a domain
// or shared-host read; none runs its own domain SQL. Studio-context reads
// take the same capability and authz decision the dashboard handlers take,
// and background reads run installation-wide under the install-time grant.

func (d *Dispatcher) organizationGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct{}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	facts, err := d.deps.Shared.Organization.Get(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"id": facts.ID, "name": facts.Name}, nil, nil
}

func (d *Dispatcher) instanceGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct{}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	return map[string]any{
		"publicUrl":       d.deps.Shared.Instance.PublicURL(),
		"tilecastVersion": d.deps.Shared.Instance.Version(),
	}, nil, nil
}

type pageInput struct {
	Search   string `json:"search"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

func (d *Dispatcher) screensList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input pageInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	access, failure := d.screenAccess(ctx, call, auth.CapScreenRead)
	if failure != nil {
		return nil, nil, failure
	}
	result, err := d.deps.Devices.PluginScreens(ctx, access, plugin.ScreenListQuery{Search: input.Search, Page: input.Page, PageSize: input.PageSize})
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return result, nil, nil
}

func (d *Dispatcher) screensGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct {
		ID uuid.UUID `json:"id"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	if failure := d.authorize(ctx, call, "screen was not found", func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Screen(ctx, actor, auth.CapScreenRead, input.ID)
	}); failure != nil {
		return nil, nil, failure
	}
	facts, err := d.deps.Devices.PluginScreen(ctx, input.ID)
	if errors.Is(err, devices.ErrNotFound) {
		return nil, nil, notFound("screen was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return facts, nil, nil
}

func (d *Dispatcher) targetsResolve(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct {
		ScreenIDs []uuid.UUID `json:"screenIds"`
		GroupIDs  []uuid.UUID `json:"groupIds"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ScreenIDs == nil {
		input.ScreenIDs = []uuid.UUID{}
	}
	if input.GroupIDs == nil {
		input.GroupIDs = []uuid.UUID{}
	}
	// Naming a screen or group outside the operator's access is refused
	// whole, not silently narrowed, and a group is judged as a container.
	if failure := d.authorize(ctx, call, "", func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Selection(ctx, actor, auth.CapScreenRead, authz.Selection{ScreenIDs: input.ScreenIDs, GroupIDs: input.GroupIDs})
	}); failure != nil {
		return nil, nil, failure
	}
	tx, err := d.deps.DB.Begin(ctx)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	targets := plugin.ScreenTargets{ScreenIDs: input.ScreenIDs, GroupIDs: input.GroupIDs}
	if err := d.deps.Shared.Targets.ValidateScreenTargetsInTx(ctx, tx, targets); err != nil {
		if errors.Is(err, plugin.ErrInvalid) {
			return nil, nil, invalidInput("one or more targets are invalid")
		}
		return nil, nil, unavailable(err)
	}
	resolved, err := d.deps.Shared.Targets.ResolveScreensInTx(ctx, tx, targets)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"screenIds": resolved}, nil, nil
}

func (d *Dispatcher) playlistsList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapPlaylistRead); failure != nil {
		return nil, nil, failure
	}
	var input pageInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	result, err := d.deps.Playlists.List(ctx, input.Search, input.Page, input.PageSize)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return result, nil, nil
}

func (d *Dispatcher) playlistsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapPlaylistRead); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		ID uuid.UUID `json:"id"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	playlist, err := d.deps.Playlists.GetDraft(ctx, input.ID)
	if errors.Is(err, playlists.ErrNotFound) {
		return nil, nil, notFound("playlist was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return playlist, nil, nil
}

func (d *Dispatcher) layoutsList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapLayoutRead); failure != nil {
		return nil, nil, failure
	}
	var input pageInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	result, err := d.deps.Layouts.List(ctx, input.Search, input.Page, input.PageSize)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return result, nil, nil
}

func (d *Dispatcher) layoutsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapLayoutRead); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		ID uuid.UUID `json:"id"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	layout, err := d.deps.Layouts.Get(ctx, input.ID)
	if errors.Is(err, layouts.ErrNotFound) {
		return nil, nil, notFound("layout was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return layout, nil, nil
}

func (d *Dispatcher) datasourcesList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapDataSourceRead); failure != nil {
		return nil, nil, failure
	}
	var flat struct {
		Search   string `json:"search"`
		Page     int    `json:"page"`
		PageSize int    `json:"pageSize"`
		Provider string `json:"provider"`
		Sort     string `json:"sort"`
	}
	if failure := decode(call.Input, &flat); failure != nil {
		return nil, nil, failure
	}
	result, err := d.deps.Media.ListDataSources(ctx, media.DataSourceListOptions{Search: flat.Search, Provider: flat.Provider, Sort: flat.Sort, Page: flat.Page, PageSize: flat.PageSize})
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return result, nil, nil
}

func (d *Dispatcher) datasourcesGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapDataSourceRead); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		ID uuid.UUID `json:"id"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	source, err := d.deps.Media.GetDataSource(ctx, input.ID)
	if errors.Is(err, media.ErrNotFound) {
		return nil, nil, notFound("data source was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return source, nil, nil
}

func (d *Dispatcher) schedulesList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct {
		Search           string `json:"search"`
		Enabled          *bool  `json:"enabled"`
		Type             string `json:"type"`
		PresentationType string `json:"presentationType"`
		Sort             string `json:"sort"`
		Page             int    `json:"page"`
		PageSize         int    `json:"pageSize"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	filter := scheduling.ListFilter{Search: input.Search, Enabled: input.Enabled, Type: scheduling.Kind(input.Type), PresentationType: input.PresentationType, Sort: input.Sort}
	if err := filter.Validate(); err != nil {
		if errors.Is(err, scheduling.ErrInvalidFilter) {
			return nil, nil, invalidInput("schedule filter is invalid")
		}
		return nil, nil, unavailable(err)
	}
	access, failure := d.screenAccess(ctx, call, auth.CapScheduleRead)
	if failure != nil {
		return nil, nil, failure
	}
	if access == nil || access.All {
		result, err := d.deps.Scheduling.List(ctx, filter, input.Page, input.PageSize)
		if err != nil {
			return nil, nil, unavailable(err)
		}
		return result, nil, nil
	}
	// Mirror the dashboard's narrowed schedule list: scan, keep the records
	// the schedule decision would allow, then page.
	page, pageSize := input.Page, input.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 50
	}
	visible := []scheduling.Record{}
	defaultTimezone := ""
	for scanPage := 1; ; scanPage++ {
		batch, err := d.deps.Scheduling.List(ctx, filter, scanPage, 100)
		if err != nil {
			return nil, nil, unavailable(err)
		}
		defaultTimezone = batch.DefaultTimezone
		ids := make([]uuid.UUID, 0, len(batch.Items))
		for _, record := range batch.Items {
			ids = append(ids, record.ID)
		}
		reached, failure := d.reachable(ctx, call, auth.CapScheduleRead, authz.KindSchedule, ids)
		if failure != nil {
			return nil, nil, failure
		}
		for _, record := range batch.Items {
			if reached[record.ID] {
				visible = append(visible, record)
			}
		}
		if scanPage*batch.PageSize >= batch.Total {
			break
		}
	}
	start := (page - 1) * pageSize
	if start > len(visible) {
		start = len(visible)
	}
	end := start + pageSize
	if end > len(visible) {
		end = len(visible)
	}
	return scheduling.List{Items: visible[start:end], Total: len(visible), Page: page, PageSize: pageSize, DefaultTimezone: defaultTimezone}, nil, nil
}

func (d *Dispatcher) schedulesGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct {
		ID uuid.UUID `json:"id"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	if failure := d.authorize(ctx, call, "schedule was not found", func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Schedule(ctx, actor, auth.CapScheduleRead, input.ID)
	}); failure != nil {
		return nil, nil, failure
	}
	record, err := d.deps.Scheduling.Get(ctx, input.ID)
	if errors.Is(err, scheduling.ErrNotFound) {
		return nil, nil, notFound("schedule was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return record, nil, nil
}

func (d *Dispatcher) groupsList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input pageInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	access, failure := d.screenAccess(ctx, call, auth.CapScreenRead)
	if failure != nil {
		return nil, nil, failure
	}
	if access == nil || access.All {
		result, err := d.deps.Scheduling.ListGroups(ctx, input.Search, input.Page, input.PageSize)
		if err != nil {
			return nil, nil, unavailable(err)
		}
		return result, nil, nil
	}
	// Mirror the dashboard's narrowed group list.
	page, pageSize := input.Page, input.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 50
	}
	visible := []scheduling.Group{}
	for scanPage := 1; ; scanPage++ {
		batch, err := d.deps.Scheduling.ListGroups(ctx, input.Search, scanPage, 100)
		if err != nil {
			return nil, nil, unavailable(err)
		}
		ids := make([]uuid.UUID, 0, len(batch.Items))
		for _, group := range batch.Items {
			ids = append(ids, group.ID)
		}
		reached, failure := d.reachable(ctx, call, auth.CapScreenRead, authz.KindGroup, ids)
		if failure != nil {
			return nil, nil, failure
		}
		for _, group := range batch.Items {
			if reached[group.ID] {
				visible = append(visible, group)
			}
		}
		if scanPage*batch.PageSize >= batch.Total {
			break
		}
	}
	start := (page - 1) * pageSize
	if start > len(visible) {
		start = len(visible)
	}
	end := start + pageSize
	if end > len(visible) {
		end = len(visible)
	}
	return scheduling.GroupList{Items: visible[start:end], Total: len(visible), Page: page, PageSize: pageSize}, nil, nil
}

func (d *Dispatcher) groupsGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct {
		ID uuid.UUID `json:"id"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	if failure := d.authorize(ctx, call, "screen group was not found", func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Group(ctx, actor, auth.CapScreenRead, input.ID)
	}); failure != nil {
		return nil, nil, failure
	}
	group, err := d.deps.Scheduling.GetGroup(ctx, input.ID)
	if errors.Is(err, scheduling.ErrNotFound) {
		return nil, nil, notFound("screen group was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return group, nil, nil
}

func (d *Dispatcher) usersGet(ctx context.Context, call Call) (any, *Denial, *CallError) {
	// Mirror the dashboard's user management boundary: only Owners and
	// Administrators browse the directory from Studio. Background
	// attribution runs under the install-time grant instead.
	if failure := requireCapability(call, auth.CapUsersManage); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		ID uuid.UUID `json:"id"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.ID == uuid.Nil {
		return nil, nil, invalidInput("id is required")
	}
	user, err := d.deps.Shared.Users.Get(ctx, input.ID)
	if errors.Is(err, plugin.ErrNotFound) {
		return nil, nil, notFound("user was not found")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return directoryUser(user), nil, nil
}

// directoryUser projects the shared directory shape onto the service
// contract: camelCase keys, identity and role only.
func directoryUser(user plugin.DirectoryUser) map[string]any {
	return map[string]any{
		"id": user.ID, "name": user.Name, "username": user.Username,
		"role": user.Role, "active": user.Active,
	}
}

func directoryUsers(users []plugin.DirectoryUser) []map[string]any {
	out := make([]map[string]any, 0, len(users))
	for _, user := range users {
		out = append(out, directoryUser(user))
	}
	return out
}

func (d *Dispatcher) usersSearch(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapUsersManage); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	users, err := d.deps.Shared.Users.SearchActive(ctx, input.Query, input.Limit)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"items": directoryUsers(users)}, nil, nil
}

func (d *Dispatcher) usersListByRole(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapUsersManage); failure != nil {
		return nil, nil, failure
	}
	var input struct {
		Role string `json:"role"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if !auth.IsBuiltinRole(input.Role) && !auth.IsCustomRoleKey(input.Role) {
		return nil, nil, invalidInput("role must be a Tilecast role")
	}
	users, err := d.deps.Shared.Users.ListByRole(ctx, input.Role)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	return map[string]any{"items": directoryUsers(users)}, nil, nil
}
