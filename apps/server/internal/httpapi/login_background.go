package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const defaultLoginBackgroundURL = "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&fm=jpg&q=82&w=2400"

func (s *server) loginBackgroundRoutes(next http.Handler) http.Handler {
	router := chi.NewRouter()
	router.Get("/api/v1/auth/background", s.loginBackgroundImage)
	router.Head("/api/v1/auth/background", s.loginBackgroundImage)
	router.With(s.requireSession).Get("/api/v1/settings/login-background", s.getLoginBackground)
	router.With(s.requireSession, s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/api/v1/settings/login-background", s.putLoginBackground)
	router.With(s.requireSession, s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/api/v1/settings/login-background", s.deleteLoginBackground)
	router.NotFound(next.ServeHTTP)
	router.MethodNotAllowed(next.ServeHTTP)
	return router
}

func (s *server) loginBackgroundImage(w http.ResponseWriter, r *http.Request) {
	var assetID uuid.UUID
	err := s.db.QueryRow(r.Context(), `SELECT background_asset_id FROM organization_login_branding WHERE background_asset_id IS NOT NULL LIMIT 1`).Scan(&assetID)
	if errors.Is(err, pgx.ErrNoRows) {
		http.Redirect(w, r, defaultLoginBackgroundURL, http.StatusTemporaryRedirect)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	delivery, err := s.media.Preview(r.Context(), assetID)
	if err != nil {
		http.Redirect(w, r, defaultLoginBackgroundURL, http.StatusTemporaryRedirect)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	serveDelivery(w, r, delivery)
}

func (s *server) getLoginBackground(w http.ResponseWriter, r *http.Request) {
	var assetID string
	err := s.db.QueryRow(r.Context(), `SELECT COALESCE(background_asset_id::text, '') FROM organization_login_branding LIMIT 1`).Scan(&assetID)
	if errors.Is(err, pgx.ErrNoRows) {
		assetID = ""
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	var value any
	if assetID != "" {
		value = assetID
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"assetId": value, "imageUrl": "/api/v1/auth/background"}})
}

type loginBackgroundRequest struct {
	AssetID string `json:"assetId"`
}

func (s *server) putLoginBackground(w http.ResponseWriter, r *http.Request) {
	var body loginBackgroundRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	assetID, err := uuid.Parse(body.AssetID)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "login_background_invalid", "Choose a valid image asset.")
		return
	}
	asset, err := s.media.GetAsset(r.Context(), assetID)
	if err != nil || asset.Type != "image" {
		writeError(w, http.StatusUnprocessableEntity, "login_background_invalid", "The login background must be an image asset.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	tag, err := s.db.Exec(r.Context(), `
		INSERT INTO organization_login_branding (organization_id, background_asset_id, updated_by, updated_at)
		SELECT id, $1, $2, now() FROM organization_settings LIMIT 1
		ON CONFLICT (organization_id) DO UPDATE
		SET background_asset_id=EXCLUDED.background_asset_id, updated_by=EXCLUDED.updated_by, updated_at=now()
	`, assetID, principal.User.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "setup_required", "Complete Tilecast setup before changing the login background.")
		return
	}
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'branding.login_background_changed','organization',$3,jsonb_build_object('assetId',$4::text))`, uuid.New(), principal.User.ID, "login-background", assetID)
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"assetId": assetID.String(), "imageUrl": "/api/v1/auth/background"}})
}

func (s *server) deleteLoginBackground(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	_, err := s.db.Exec(r.Context(), `UPDATE organization_login_branding SET background_asset_id=NULL, updated_by=$1, updated_at=now()`, principal.User.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'branding.login_background_reset','organization',$3,'{}'::jsonb)`, uuid.New(), principal.User.ID, "login-background")
	w.WriteHeader(http.StatusNoContent)
}
