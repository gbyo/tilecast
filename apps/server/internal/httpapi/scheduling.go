package httpapi

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"net/http"
	"strconv"
	"time"
)

type groupBody struct {
	Name                        string     `json:"name"`
	Description                 string     `json:"description"`
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
	scoped, err := s.devices.Scoped(r.Context(), principal.User.ID, principal.User.Role)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !scoped {
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
	visible := []scheduling.Group{}
	for scanPage := 1; ; scanPage++ {
		batch, e := s.scheduling.ListGroups(r.Context(), search, scanPage, 100)
		if e != nil {
			s.scheduleResponse(w, r, batch, e, http.StatusOK)
			return
		}
		for _, group := range batch.Items {
			screens := make([]uuid.UUID, 0, len(group.Screens))
			for _, screen := range group.Screens {
				screens = append(screens, screen.ID)
			}
			allowed, scopeErr := s.screenTargetsWithinScope(r.Context(), principal.User.ID, principal.User.Role, screens, nil)
			if scopeErr != nil {
				s.internalError(w, r, scopeErr)
				return
			}
			if allowed {
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
	x, e := s.scheduling.CreateGroup(r.Context(), u.ID, b.Name, b.Description)
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
	if !s.authorizeScreenList(w, r, []uuid.UUID{b.ScreenID}, nil) {
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
	search := r.URL.Query().Get("search")
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	scoped, err := s.devices.Scoped(r.Context(), principal.User.ID, principal.User.Role)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !scoped {
		x, e := s.scheduling.List(r.Context(), search, p, z)
		s.scheduleResponse(w, r, x, e, http.StatusOK)
		return
	}
	if p < 1 {
		p = 1
	}
	if z < 1 || z > 100 {
		z = 50
	}
	visible := []scheduling.Record{}
	defaultTimezone := ""
	for scanPage := 1; ; scanPage++ {
		batch, e := s.scheduling.List(r.Context(), search, scanPage, 100)
		if e != nil {
			s.scheduleResponse(w, r, batch, e, http.StatusOK)
			return
		}
		defaultTimezone = batch.DefaultTimezone
		for _, record := range batch.Items {
			screens, groups := scheduleTargetIDs(record.Targets)
			allowed, scopeErr := s.screenTargetsWithinScope(r.Context(), principal.User.ID, principal.User.Role, screens, groups)
			if scopeErr != nil {
				s.internalError(w, r, scopeErr)
				return
			}
			if allowed {
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
	screens, groups := scheduleTargetIDs(b.Targets)
	if !s.authorizeScreenList(w, r, screens, groups) {
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
	screens, groups := scheduleTargetIDs(b.Targets)
	if !s.authorizeScreenList(w, r, screens, groups) {
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
	if !s.authorizeScreen(w, r, b.ScreenID) {
		return
	}
	if b.Proposed != nil {
		screens, groups := scheduleTargetIDs(b.Proposed.Targets)
		if !s.authorizeScreenList(w, r, screens, groups) {
			return
		}
	}
	at := time.Now()
	if b.Timestamp != nil {
		at = *b.Timestamp
	}
	x, e := s.scheduling.Preview(r.Context(), b.ScreenID, at, b.Proposed)
	s.scheduleResponse(w, r, x, e, http.StatusOK)
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
