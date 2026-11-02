package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

type groupBody struct {
	Name                        string     `json:"name"`
	Description                 string     `json:"description"`
	PresentationGatewayScreenID *uuid.UUID `json:"presentationGatewayScreenId"`
	ClearPresentationGateway    bool       `json:"clearPresentationGateway"`
}

// createGroupBody is groupBody plus the first members. A restricted
// operator must name at least one reachable screen: an empty group has no
// anchor and would be unreachable the moment it existed.
type createGroupBody struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	ScreenIDs   []uuid.UUID `json:"screenIds"`
	// The gateway fields were always accepted and ignored on creation;
	// they stay accepted so older clients keep working.
	PresentationGatewayScreenID *uuid.UUID `json:"presentationGatewayScreenId"`
	ClearPresentationGateway    bool       `json:"clearPresentationGateway"`
}

func (s *server) listScreenGroups(w http.ResponseWriter, r *http.Request) {
	p, _ := strconv.Atoi(r.URL.Query().Get("page"))
	z, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	search := r.URL.Query().Get("search")
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := authz.ActorFor(principal)
	access, err := s.authorizer().Access(r.Context(), actor)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if access.All {
		x, e := s.scheduling.ListGroups(r.Context(), search, p, z)
		s.scheduleResponse(w, r, x, e, http.StatusOK)
		return
	}
	if p < 1 {
		p = 1
	}
	if z < 1 || z > 100 {
		z = 50
	}
	// The list keeps the groups the single-group decision would allow.
	visible := []scheduling.Group{}
	for scanPage := 1; ; scanPage++ {
		batch, e := s.scheduling.ListGroups(r.Context(), search, scanPage, 100)
		if e != nil {
			s.scheduleResponse(w, r, batch, e, http.StatusOK)
			return
		}
		ids := make([]uuid.UUID, 0, len(batch.Items))
		for _, group := range batch.Items {
			ids = append(ids, group.ID)
		}
		reached, scopeErr := s.authorizer().Reachable(r.Context(), actor, auth.CapScreenRead, authz.KindGroup, ids)
		if scopeErr != nil {
			s.writeAuthzError(w, r, scopeErr, notFoundFor(objectGroup))
			return
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
	start := (p - 1) * z
	if start > len(visible) {
		start = len(visible)
	}
	end := start + z
	if end > len(visible) {
		end = len(visible)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": scheduling.GroupList{
		Items: visible[start:end], Total: len(visible), Page: p, PageSize: z,
	}})
}
func (s *server) getScreenGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	x, e := s.scheduling.GetGroup(r.Context(), id)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}
func (s *server) createScreenGroup(w http.ResponseWriter, r *http.Request) {
	var b createGroupBody
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", e.Error())
		return
	}
	actor, ok := s.actor(w, r)
	if !ok {
		return
	}
	x, e := s.scheduling.CreateGroupWithScreens(r.Context(), actor.UserID, b.Name, b.Description, b.ScreenIDs, func(ctx context.Context, tx pgx.Tx) error {
		access, err := s.authorizer().Tx(tx).Access(ctx, actor)
		if err != nil || access.All {
			return err
		}
		// Every first member must be reachable, and so must its current
		// group peers, because joining moves it out of its old group.
		return s.authorizer().Tx(tx).Selection(ctx, actor, auth.CapScreenManage, authz.Selection{ScreenIDs: b.ScreenIDs, Peers: true})
	})
	if isAuthzError(e) {
		s.writeAuthzError(w, r, e, notFoundFor(objectScreen))
		return
	}
	s.scheduleResponse(w, r, x, e, http.StatusCreated)
}
func (s *server) updateScreenGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var b groupBody
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", e.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	if b.PresentationGatewayScreenID != nil && !s.decide(w, r, notFoundFor(objectScreen), func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Screen(r.Context(), actor, auth.CapScreenManage, *b.PresentationGatewayScreenID)
	}) {
		return
	}
	x, e := s.scheduling.UpdateGroup(r.Context(), id, u.ID, b.Name, b.Description, b.PresentationGatewayScreenID, b.ClearPresentationGateway)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}
func (s *server) deleteScreenGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	e := s.scheduling.DeleteGroup(r.Context(), id, u.ID)
	if e != nil {
		s.writeScheduleError(w, r, e)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *server) addScreenGroupMember(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var b struct {
		ScreenID uuid.UUID `json:"screenId"`
	}
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", e.Error())
		return
	}
	// Membership must never make a screen reachable to the group's
	// grantees unless the operator reaches it, and joining moves the screen
	// out of its old group, whose peers must be reachable too.
	if !s.decide(w, r, notFoundFor(objectScreen), func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Selection(r.Context(), actor, auth.CapScreenManage, authz.Selection{ScreenIDs: []uuid.UUID{b.ScreenID}, Peers: true})
	}) {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	e := s.scheduling.AddScreen(r.Context(), id, b.ScreenID, u.ID)
	if e != nil {
		s.writeScheduleError(w, r, e)
		return
	}
	if s.span != nil {
		if e = s.span.SyncMembershipGeometry(r.Context(), id, u.ID); e != nil {
			s.writeSpanError(w, r, e)
			return
		}
	}
	x, e := s.scheduling.GetGroup(r.Context(), id)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}
func (s *server) removeScreenGroupMember(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	screen, e := uuid.Parse(chi.URLParam(r, "screenId"))
	if e != nil {
		writeError(w, 404, "screen_not_found", "Screen was not found.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	e = s.scheduling.RemoveScreen(r.Context(), id, screen, u.ID)
	if e != nil {
		s.writeScheduleError(w, r, e)
		return
	}
	if s.span != nil {
		if e = s.span.SyncMembershipGeometry(r.Context(), id, u.ID); e != nil {
			s.writeSpanError(w, r, e)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *server) assignSyncGroupPlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		PlaylistID *uuid.UUID `json:"playlistId"`
		LayoutID   *uuid.UUID `json:"layoutId"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err := s.playlists.AssignGroupPresentation(r.Context(), id, body.PlaylistID, body.LayoutID, user.ID); err != nil {
		s.writePlaylistError(w, r, err)
		return
	}
	group, err := s.scheduling.GetGroup(r.Context(), id)
	s.scheduleResponse(w, r, group, err, http.StatusOK)
}
func (s *server) unassignSyncGroupPlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err := s.playlists.UnassignGroup(r.Context(), id, user.ID); err != nil {
		s.writePlaylistError(w, r, err)
		return
	}
	group, err := s.scheduling.GetGroup(r.Context(), id)
	s.scheduleResponse(w, r, group, err, http.StatusOK)
}
func (s *server) listSchedules(w http.ResponseWriter, r *http.Request) {
	p, _ := strconv.Atoi(r.URL.Query().Get("page"))
	z, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	filter, err := scheduleListFilter(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := authz.ActorFor(principal)
	access, err := s.authorizer().Access(r.Context(), actor)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if access.All {
		x, e := s.scheduling.List(r.Context(), filter, p, z)
		s.scheduleResponse(w, r, x, e, http.StatusOK)
		return
	}
	if p < 1 {
		p = 1
	}
	if z < 1 || z > 100 {
		z = 50
	}
	// The list keeps the schedules the single-schedule decision would allow.
	visible := []scheduling.Record{}
	defaultTimezone := ""
	for scanPage := 1; ; scanPage++ {
		batch, e := s.scheduling.List(r.Context(), filter, scanPage, 100)
		if e != nil {
			s.scheduleResponse(w, r, batch, e, http.StatusOK)
			return
		}
		defaultTimezone = batch.DefaultTimezone
		ids := make([]uuid.UUID, 0, len(batch.Items))
		for _, record := range batch.Items {
			ids = append(ids, record.ID)
		}
		reached, scopeErr := s.authorizer().Reachable(r.Context(), actor, auth.CapScheduleRead, authz.KindSchedule, ids)
		if scopeErr != nil {
			s.writeAuthzError(w, r, scopeErr, notFoundFor(objectSchedule))
			return
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
	start := (p - 1) * z
	if start > len(visible) {
		start = len(visible)
	}
	end := start + z
	if end > len(visible) {
		end = len(visible)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": scheduling.List{
		Items: visible[start:end], Total: len(visible), Page: p, PageSize: z, DefaultTimezone: defaultTimezone,
	}})
}

// scheduleListFilter reads the optional library filters. Every parameter is
// optional; a value outside its closed set is rejected rather than ignored.
func scheduleListFilter(query url.Values) (scheduling.ListFilter, error) {
	filter := scheduling.ListFilter{
		Search:           query.Get("search"),
		Type:             scheduling.Kind(query.Get("type")),
		PresentationType: query.Get("presentationType"),
		Sort:             query.Get("sort"),
	}
	switch query.Get("enabled") {
	case "":
	case "true":
		enabled := true
		filter.Enabled = &enabled
	case "false":
		enabled := false
		filter.Enabled = &enabled
	default:
		return filter, errors.New("enabled must be true or false")
	}
	return filter, filter.Validate()
}

func scheduleTargetIDs(targets []scheduling.Target) ([]uuid.UUID, []uuid.UUID) {
	screens, groups := []uuid.UUID{}, []uuid.UUID{}
	for _, target := range targets {
		if target.Type == "screen" {
			screens = append(screens, target.ID)
		} else if target.Type == "group" {
			groups = append(groups, target.ID)
		}
	}
	return screens, groups
}
func (s *server) getSchedule(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	x, e := s.scheduling.Get(r.Context(), id)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}
func (s *server) createSchedule(w http.ResponseWriter, r *http.Request) {
	var b scheduling.Input
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", e.Error())
		return
	}
	if !s.authorizeScheduleTargets(w, r, auth.CapScheduleEdit, b.Targets) {
		return
	}
	if err := s.validateSchedulePresentation(r, b); err != nil {
		s.writePlaylistError(w, r, err)
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	x, e := s.scheduling.Create(r.Context(), u.ID, b)
	s.scheduleResponse(w, r, x, e, http.StatusCreated)
}
func (s *server) updateSchedule(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var b scheduling.Input
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", e.Error())
		return
	}
	if !s.authorizeScheduleTargets(w, r, auth.CapScheduleEdit, b.Targets) {
		return
	}
	if err := s.validateSchedulePresentation(r, b); err != nil {
		s.writePlaylistError(w, r, err)
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	x, e := s.scheduling.Update(r.Context(), id, u.ID, b)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}

func (s *server) validateSchedulePresentation(r *http.Request, input scheduling.Input) error {
	if input.DisplayAction != nil {
		return nil
	}
	var playlistID *uuid.UUID
	if input.LayoutID == nil {
		playlistID = &input.PlaylistID
	}
	screenIDs := []uuid.UUID{}
	groupIDs := []uuid.UUID{}
	for _, target := range input.Targets {
		if target.Type == "screen" {
			screenIDs = append(screenIDs, target.ID)
		} else if target.Type == "group" {
			groupIDs = append(groupIDs, target.ID)
		}
	}
	return s.playlists.ValidatePresentationTargets(r.Context(), playlistID, input.LayoutID, screenIDs, groupIDs)
}
func (s *server) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	e := s.scheduling.Delete(r.Context(), id, u.ID)
	if e != nil {
		s.writeScheduleError(w, r, e)
		return
	}
	w.WriteHeader(204)
}
func (s *server) enableSchedule(w http.ResponseWriter, r *http.Request) {
	s.setScheduleEnabled(w, r, true)
}
func (s *server) disableSchedule(w http.ResponseWriter, r *http.Request) {
	s.setScheduleEnabled(w, r, false)
}
func (s *server) setScheduleEnabled(w http.ResponseWriter, r *http.Request, v bool) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	x, e := s.scheduling.SetEnabled(r.Context(), id, u.ID, v)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}
func (s *server) previewSchedule(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ScreenID  uuid.UUID         `json:"screenId"`
		Timestamp *time.Time        `json:"timestamp"`
		Proposed  *scheduling.Input `json:"proposedSchedule"`
	}
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", e.Error())
		return
	}
	if !s.decide(w, r, notFoundFor(objectScreen), func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Screen(r.Context(), actor, auth.CapScheduleEdit, b.ScreenID)
	}) {
		return
	}
	if b.Proposed != nil && !s.authorizeScheduleTargets(w, r, auth.CapScheduleEdit, b.Proposed.Targets) {
		return
	}
	at := time.Now()
	if b.Timestamp != nil {
		at = *b.Timestamp
	}
	x, e := s.scheduling.Preview(r.Context(), b.ScreenID, at, b.Proposed)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}

// preflightSchedule inspects a draft schedule across every screen it targets.
// It is read-only, so a viewer can read it too; target scope and presentation
// checks are the ones a save applies.
func (s *server) preflightSchedule(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ScheduleID *uuid.UUID       `json:"scheduleId"`
		Proposed   scheduling.Input `json:"proposedSchedule"`
	}
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", e.Error())
		return
	}
	if !s.authorizeScheduleTargets(w, r, auth.CapScheduleRead, b.Proposed.Targets) {
		return
	}
	if err := s.validateSchedulePresentation(r, b.Proposed); err != nil {
		s.writePlaylistError(w, r, err)
		return
	}
	x, e := s.scheduling.Preflight(r.Context(), b.ScheduleID, b.Proposed)
	if e == nil {
		principal, ok := principalOf(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
			return
		}
		if e = s.redactHiddenSchedules(r.Context(), authz.ActorFor(principal), &x); e != nil {
			s.internalError(w, r, e)
			return
		}
	}
	s.scheduleResponse(w, r, x, e, http.StatusOK)
}

// redactHiddenSchedules applies the visibility rule of the schedule list to
// the schedules a preflight names. A scoped account sees a schedule only when
// every one of its targets is inside that scope. A schedule it may not see
// keeps its counts and reasons but loses its name and ID, so the check cannot
// reveal what runs on screens the account cannot reach.
func (s *server) redactHiddenSchedules(ctx context.Context, actor authz.Actor, result *scheduling.PreflightResult) error {
	ids := []uuid.UUID{}
	for _, competitor := range result.Competitors {
		ids = append(ids, competitor.ScheduleID)
	}
	for _, screen := range result.Screens {
		if screen.WinnerScheduleID != nil {
			ids = append(ids, *screen.WinnerScheduleID)
		}
	}
	reached, err := s.authorizer().Reachable(ctx, actor, auth.CapScheduleRead, authz.KindSchedule, ids)
	if err != nil {
		return err
	}
	aliases := map[uuid.UUID]uuid.UUID{}
	alias := func(id uuid.UUID) uuid.UUID {
		if existing, ok := aliases[id]; ok {
			return existing
		}
		aliases[id] = uuid.New()
		return aliases[id]
	}
	for i := range result.Competitors {
		if id := result.Competitors[i].ScheduleID; !reached[id] {
			result.Competitors[i].ScheduleID, result.Competitors[i].Name = alias(id), ""
		}
	}
	for i := range result.Screens {
		winner := result.Screens[i].WinnerScheduleID
		if winner == nil || reached[*winner] {
			continue
		}
		hidden := alias(*winner)
		result.Screens[i].WinnerScheduleID, result.Screens[i].WinnerName = &hidden, ""
	}
	return nil
}

// authorizeScheduleTargets decides a schedule's targets as one selection.
// A schedule plays on every member of a targeted screen's Display Group,
// so a screen's group peers must be reachable too, and a restricted
// operator must name at least one target.
func (s *server) authorizeScheduleTargets(w http.ResponseWriter, r *http.Request, capability auth.Capability, targets []scheduling.Target) bool {
	screens, groups := scheduleTargetIDs(targets)
	return s.decide(w, r, notFoundFor(objectScreen), func(z *authz.Authorizer, actor authz.Actor) error {
		return z.Selection(r.Context(), actor, capability, authz.Selection{ScreenIDs: screens, GroupIDs: groups, Peers: true})
	})
}

func (s *server) scheduleResponse(w http.ResponseWriter, r *http.Request, x any, e error, status int) {
	if e != nil {
		s.writeScheduleError(w, r, e)
		return
	}
	writeJSON(w, status, map[string]any{"data": x})
}
func (s *server) writeScheduleError(w http.ResponseWriter, r *http.Request, e error) {
	switch {
	case errors.Is(e, scheduling.ErrNotFound):
		writeError(w, 404, "schedule_not_found", "The requested scheduling resource was not found.")
	case errors.Is(e, scheduling.ErrDisplayControlUnsupported):
		writeError(w, http.StatusUnprocessableEntity, "display_control_unsupported", "Display-control schedules can only target Linux Players; Android screens must use a content schedule.")
	case errors.Is(e, scheduling.ErrConflict):
		writeError(w, 409, "schedule_conflict", e.Error())
	case errors.Is(e, scheduling.ErrLimit):
		writeError(w, 422, "schedule_limit_exceeded", e.Error())
	default:
		if len(e.Error()) < 240 {
			writeError(w, 422, "schedule_validation_failed", e.Error())
		} else {
			s.internalError(w, r, e)
		}
	}
}
