package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *server) requireGroupScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		principal, ok := principalOf(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
			return
		}
		allowed, err := s.screenTargetsWithinScope(r.Context(), principal.User.ID, principal.User.Role, nil, []uuid.UUID{id})
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !allowed {
			writeError(w, http.StatusNotFound, "schedule_not_found", "The requested scheduling resource was not found.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) scheduleScopeTargets(ctx context.Context, id uuid.UUID) ([]uuid.UUID, []uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `SELECT target_type,COALESCE(screen_id,screen_group_id) FROM schedule_targets WHERE schedule_id=$1`, id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	screens, groups := []uuid.UUID{}, []uuid.UUID{}
	for rows.Next() {
		var targetType string
		var targetID uuid.UUID
		if err := rows.Scan(&targetType, &targetID); err != nil {
			return nil, nil, err
		}
		if targetType == "screen" {
			screens = append(screens, targetID)
		} else if targetType == "group" {
			groups = append(groups, targetID)
		}
	}
	return screens, groups, rows.Err()
}

func (s *server) requireScheduleScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		principal, ok := principalOf(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
			return
		}
		screens, groups, err := s.scheduleScopeTargets(r.Context(), id)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		allowed, err := s.screenTargetsWithinScope(r.Context(), principal.User.ID, principal.User.Role, screens, groups)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !allowed {
			writeError(w, http.StatusNotFound, "schedule_not_found", "The requested scheduling resource was not found.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) takeoverScopeScreens(ctx context.Context, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `SELECT screen_id FROM takeover_screen_states WHERE takeover_id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	screens := []uuid.UUID{}
	for rows.Next() {
		var screen uuid.UUID
		if err := rows.Scan(&screen); err != nil {
			return nil, err
		}
		screens = append(screens, screen)
	}
	return screens, rows.Err()
}

func (s *server) requireTakeoverScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		principal, ok := principalOf(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
			return
		}
		screens, err := s.takeoverScopeScreens(r.Context(), id)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		allowed, err := s.screenTargetsWithinScope(r.Context(), principal.User.ID, principal.User.Role, screens, nil)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !allowed {
			writeError(w, http.StatusNotFound, "takeover_not_found", "Takeover was not found.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) presentationOverrideScopeTarget(ctx context.Context, id uuid.UUID) (string, uuid.UUID, error) {
	var targetType string
	var targetID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT target_type,target_id FROM presentation_overrides WHERE id=$1 AND stopped_at IS NULL`, id).Scan(&targetType, &targetID)
	return targetType, targetID, err
}

func (s *server) requirePresentationOverrideScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		principal, ok := principalOf(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
			return
		}
		targetType, targetID, err := s.presentationOverrideScopeTarget(r.Context(), id)
		if errors.Is(err, pgx.ErrNoRows) {
			// Let the handler preserve its existing not-found response.
			next.ServeHTTP(w, r)
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		var screens, groups []uuid.UUID
		if targetType == "screen" {
			screens = []uuid.UUID{targetID}
		} else if targetType == "group" {
			groups = []uuid.UUID{targetID}
		}
		allowed, err := s.screenTargetsWithinScope(r.Context(), principal.User.ID, principal.User.Role, screens, groups)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !allowed {
			writeError(w, http.StatusNotFound, "presentation_not_found", "Quick Present is no longer active.")
			return
		}
		next.ServeHTTP(w, r)
	})
}
