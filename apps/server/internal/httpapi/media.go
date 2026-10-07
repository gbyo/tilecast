package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

func (s *server) providerCatalog(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"revision": 1, "providers": s.media.ProviderCatalog()}})
}

// contentDefinitions serves the effective catalog. The Provider is not a
// serializable value, so the handler encodes its immutable snapshot.
func (s *server) contentDefinitions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": s.media.ContentDefinitions().Snapshot()})
}

func (s *server) compileWidgetPreview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Provider      string          `json:"provider"`
		Configuration json.RawMessage `json:"configuration"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if s.playlists == nil {
		writeError(w, http.StatusServiceUnavailable, "runtime_unavailable", "The presentation compiler is unavailable.")
		return
	}
	presentation, err := s.playlists.CompileWidgetPresentation(body.Provider, body.Configuration, s.orgPrivateHTTP(r))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_presentation", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": presentation})
}

func (s *server) updateWidgetPreviewImage(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, media.MaxWidgetPreviewBytes+1)
	data, err := io.ReadAll(r.Body)
	if err != nil || len(data) > media.MaxWidgetPreviewBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "preview_too_large", "The Widget preview image exceeded 500 KB.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err = s.media.StoreWidgetPreview(r.Context(), id, user.ID, data); err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type createUploadRequest struct {
	Filename  string `json:"filename"`
	MIMEType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

func (s *server) createUpload(w http.ResponseWriter, r *http.Request) {
	var body createUploadRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if s.settings != nil {
		document, _ := s.settings.Organization(r.Context())
		if limit, ok := document.Values["media.upload.max_bytes"].(float64); ok && body.SizeBytes > int64(limit) {
			writeError(w, 422, "setting_exceeds_hard_limit", "Upload exceeds the Studio runtime limit.")
			return
		}
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	upload, err := s.media.CreateUpload(r.Context(), user.ID, body.Filename, body.MIMEType, body.SizeBytes)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": upload})
}

func (s *server) headUpload(w http.ResponseWriter, r *http.Request) {
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
	upload, err := s.media.GetUpload(r.Context(), id, user.ID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	setUploadHeaders(w, upload)
	w.WriteHeader(http.StatusNoContent)
}
func setUploadHeaders(w http.ResponseWriter, u media.Upload) {
	w.Header().Set("Upload-Offset", strconv.FormatInt(u.CurrentOffset, 10))
	w.Header().Set("Upload-Length", strconv.FormatInt(u.ExpectedSize, 10))
	w.Header().Set("Upload-Status", string(u.Status))
	w.Header().Set("Upload-Expires", u.ExpiresAt.Format(time.RFC3339))
}

func (s *server) patchUpload(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || offset < 0 {
		writeError(w, http.StatusBadRequest, "invalid_upload_offset", "Upload-Offset must be a non-negative integer.")
		return
	}
	if contentType := r.Header.Get("Content-Type"); contentType != "" && !strings.HasPrefix(contentType, "application/offset+octet-stream") {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_content_type", "Upload chunks must use application/offset+octet-stream.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	upload, err := s.media.AppendUpload(r.Context(), id, user.ID, offset, r.Body)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	setUploadHeaders(w, upload)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) completeUpload(w http.ResponseWriter, r *http.Request) {
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
	asset, err := s.media.FinalizeUpload(r.Context(), id, user.ID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": asset})
}
func (s *server) cancelUpload(w http.ResponseWriter, r *http.Request) {
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
	if err := s.media.CancelUpload(r.Context(), id, user.ID); err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) listAssets(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	page, _ := strconv.Atoi(query.Get("page"))
	pageSize, _ := strconv.Atoi(query.Get("pageSize"))
	var folderID, collectionID, tagID *uuid.UUID
	for value, target := range map[string]**uuid.UUID{"folderId": &folderID, "collectionId": &collectionID, "tagId": &tagID} {
		if raw := query.Get(value); raw != "" {
			id, err := uuid.Parse(raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_filter", value+" must be a UUID.")
				return
			}
			*target = &id
		}
	}
	result, err := s.media.ListAssets(r.Context(), media.ListOptions{Search: query.Get("search"), Type: query.Get("type"), WidgetProvider: query.Get("provider"), Status: query.Get("status"), Sort: query.Get("sort"), FolderID: folderID, CollectionID: collectionID, TagID: tagID, Page: page, PageSize: pageSize, Archived: query.Get("archived") == "true"})
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}
func (s *server) getAsset(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	asset, err := s.media.GetAsset(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": asset})
}
func (s *server) createWebsite(w http.ResponseWriter, r *http.Request) {
	var body media.WebsiteInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(body.URL)), "http://") && s.settings != nil {
		document, _ := s.settings.Organization(r.Context())
		if enabled, _ := document.Values["website.private_http_enabled"].(bool); !enabled {
			writeError(w, 422, "setting_exceeds_hard_limit", "Private HTTP websites are disabled by runtime settings.")
			return
		}
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	asset, err := s.media.CreateWebsite(r.Context(), user.ID, body)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": asset})
}
func (s *server) updateWebsite(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body media.WebsiteInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(body.URL)), "http://") && s.settings != nil {
		document, _ := s.settings.Organization(r.Context())
		if enabled, _ := document.Values["website.private_http_enabled"].(bool); !enabled {
			writeError(w, 422, "setting_exceeds_hard_limit", "Private HTTP websites are disabled by runtime settings.")
			return
		}
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	asset, err := s.media.UpdateWebsite(r.Context(), id, user.ID, body)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": asset})
}
func (s *server) websiteDiagnostics(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	result, err := s.media.WebsiteDiagnostics(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

// --- Widgets ---

func (s *server) createWidget(w http.ResponseWriter, r *http.Request) {
	var body media.WidgetInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.Provider == "website" && !s.widgetPrivateHTTPAllowed(r, body.Configuration) {
		writeError(w, 422, "setting_exceeds_hard_limit", "Private HTTP websites are disabled by runtime settings.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	asset, err := s.media.CreateWidget(r.Context(), user.ID, body)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": asset})
}

func (s *server) updateWidget(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body media.WidgetInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.Provider == "" {
		if existing, err := s.media.GetAsset(r.Context(), id); err == nil && existing.Widget != nil {
			body.Provider = existing.Widget.Provider
		}
	}
	if body.Provider == "website" && !s.widgetPrivateHTTPAllowed(r, body.Configuration) {
		writeError(w, 422, "setting_exceeds_hard_limit", "Private HTTP websites are disabled by runtime settings.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	asset, err := s.media.UpdateWidget(r.Context(), id, user.ID, body)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": asset})
}

// orgPrivateHTTP reports website.private_http_enabled for the organization,
// false when the settings service is unavailable. It carries the website
// asset policy into Widget presentation compile paths, which otherwise
// reject private HTTP the organization enabled.
func (s *server) orgPrivateHTTP(r *http.Request) bool {
	if s.settings == nil {
		return false
	}
	document, err := s.settings.Organization(r.Context())
	if err != nil {
		return false
	}
	enabled, _ := document.Values["website.private_http_enabled"].(bool)
	return enabled
}

func (s *server) widgetPrivateHTTPAllowed(r *http.Request, configuration json.RawMessage) bool {
	var value struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(configuration, &value) != nil || !strings.HasPrefix(strings.ToLower(strings.TrimSpace(value.URL)), "http://") || s.settings == nil {
		return true
	}
	document, _ := s.settings.Organization(r.Context())
	enabled, _ := document.Values["website.private_http_enabled"].(bool)
	return enabled
}

func (s *server) duplicateWidget(w http.ResponseWriter, r *http.Request) {
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
	asset, err := s.media.DuplicateWidget(r.Context(), id, user.ID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": asset})
}

// --- Data Sources ---

func (s *server) decodeDataSourceJSON(w http.ResponseWriter, r *http.Request, target any) error {
	// uploadedContent is JSON-escaped, so allow bounded encoding overhead before
	// the media service applies the configured decoded source-byte limit.
	return decodeJSONLimit(w, r, target, s.media.MaximumSourceBytes()*6+(64<<10))
}

func (s *server) listDataSources(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	page, _ := strconv.Atoi(query.Get("page"))
	pageSize, _ := strconv.Atoi(query.Get("pageSize"))
	result, err := s.media.ListDataSources(r.Context(), media.DataSourceListOptions{Search: query.Get("search"), Provider: query.Get("provider"), Sort: query.Get("sort"), Page: page, PageSize: pageSize})
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) createDataSource(w http.ResponseWriter, r *http.Request) {
	var body media.DataSourceInput
	if err := s.decodeDataSourceJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	dataSource, err := s.media.CreateDataSource(r.Context(), user.ID, body)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": dataSource})
}

func (s *server) getDataSource(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	detail, err := s.media.GetDataSourceDetail(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": detail})
}

// previewSavedDataSource resolves an already-saved Data Source by id using its full
// stored configuration (including uploaded CSV content the detail response strips),
// so consumers such as the Layout preview see the same records/events as the Player.
func (s *server) previewSavedDataSource(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	preview, err := s.media.PreviewDataSourceByID(r.Context(), id, r.URL.Query().Get("previewDate"))
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": preview})
}

func (s *server) updateDataSource(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body media.DataSourceInput
	if err := s.decodeDataSourceJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	dataSource, err := s.media.UpdateDataSource(r.Context(), id, user.ID, body)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": dataSource})
}

func (s *server) duplicateDataSource(w http.ResponseWriter, r *http.Request) {
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
	dataSource, err := s.media.DuplicateDataSource(r.Context(), id, user.ID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": dataSource})
}

func (s *server) deleteDataSource(w http.ResponseWriter, r *http.Request) {
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
	if err := s.media.DeleteDataSource(r.Context(), id, user.ID); err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) dataSourceDiagnostics(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	diagnostics, err := s.media.DataSourceRefreshDiagnostics(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": diagnostics})
}

// previewDataSource tests a candidate Data Source configuration before it is saved.
// For calendar the provider is fixed; for structured providers the {provider} path segment selects it.
func (s *server) previewDataSource(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	var body struct {
		Configuration json.RawMessage `json:"configuration"`
		PreviewDate   string          `json:"previewDate"`
	}
	if err := s.decodeDataSourceJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if provider == "calendar" {
		preview, err := s.media.CalendarPreview(r.Context(), body.Configuration, body.PreviewDate)
		if err != nil {
			s.writeMediaError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": preview})
		return
	}
	if provider == "manual" {
		preview, err := s.media.ManualPreview(r.Context(), body.Configuration, body.PreviewDate)
		if err != nil {
			s.writeMediaError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": preview})
		return
	}
	if provider == "weather" {
		preview, err := s.media.WeatherPreview(r.Context(), body.Configuration, body.PreviewDate)
		if err != nil {
			s.writeMediaError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": preview})
		return
	}
	if provider == "transit" || provider == "cap_alerts" || provider == "air_quality" {
		normalizer, err := s.media.DataSourceNormalizer(provider)
		if err != nil {
			s.writeMediaError(w, r, err)
			return
		}
		normalized, err := normalizer.Normalize(r.Context(), body.Configuration)
		if err != nil {
			s.writeMediaError(w, r, err)
			return
		}
		var preview any
		switch provider {
		case "transit":
			preview, _, err = s.media.RefreshTransitPreview(r.Context(), normalized.(media.TransitSourceConfig), body.PreviewDate)
		case "cap_alerts":
			preview, _, err = s.media.RefreshCAPPreview(r.Context(), normalized.(media.CAPAlertsSourceConfig), body.PreviewDate)
		case "air_quality":
			preview, _, err = s.media.RefreshAirQualityPreview(r.Context(), normalized.(media.AirQualitySourceConfig), body.PreviewDate)
		}
		if err != nil {
			s.writeMediaError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": preview})
		return
	}
	if definition, ok := s.media.ContentDefinitions().DataSource(provider); ok && (definition.AdapterID == "manual_object" || definition.AdapterID == "manual_records" || definition.AdapterID == "http_records") {
		var preview media.TypedDatasetPayload
		var err error
		switch definition.AdapterID {
		case "manual_object":
			preview, err = s.media.ManualObjectPreview(r.Context(), provider, body.Configuration)
		case "manual_records":
			preview, err = s.media.ManualRecordsPreview(r.Context(), provider, body.Configuration, body.PreviewDate)
		default:
			preview, err = s.media.HTTPRecordsPreview(r.Context(), provider, body.Configuration, body.PreviewDate)
		}
		if err != nil {
			s.writeMediaError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": preview})
		return
	}
	if provider != "rss" && provider != "atom" && provider != "feed" && provider != "json" && provider != "csv" {
		writeError(w, http.StatusNotFound, "data_source_provider_not_found", "The requested Data Source provider was not found.")
		return
	}
	preview, err := s.media.StructuredPreview(r.Context(), provider, body.Configuration, body.PreviewDate)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": preview})
}

// inspectDataSource reports the fields a candidate RSS, Atom, Feed, JSON, or CSV connection
// contains, so Studio can offer detected fields instead of asking an author to type column
// names or JSON Pointer paths from memory. It runs before a mapping exists and therefore
// does not require one.
func (s *server) inspectDataSource(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if provider != "rss" && provider != "atom" && provider != "feed" && provider != "json" && provider != "csv" {
		writeError(w, http.StatusNotFound, "data_source_provider_not_found", "This Data Source provider does not support field detection.")
		return
	}
	var body struct {
		Configuration json.RawMessage `json:"configuration"`
	}
	if err := s.decodeDataSourceJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	inspection, err := s.media.InspectStructured(r.Context(), provider, body.Configuration)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": inspection})
}

// inspectSavedDataSource detects fields for an already-saved Source. A saved CSV upload's
// bytes never leave the Server, so the editor cannot send them back for detection.
func (s *server) inspectSavedDataSource(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	inspection, err := s.media.InspectStructuredByID(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": inspection})
}

type updateAssetRequest struct {
	Name            *string    `json:"name"`
	Description     *string    `json:"description"`
	AvailableFrom   *time.Time `json:"availableFrom"`
	ExpiresAt       *time.Time `json:"expiresAt"`
	AvailabilitySet *bool      `json:"availabilitySet"`
}

func (s *server) updateAsset(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body updateAssetRequest
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
	availabilitySet := body.AvailabilitySet != nil && *body.AvailabilitySet
	var asset media.Asset
	var err error
	if availabilitySet {
		asset, err = s.media.UpdateAssetAvailability(r.Context(), id, user.ID, body.Name, body.Description, body.AvailableFrom, body.ExpiresAt)
	} else {
		asset, err = s.media.UpdateAsset(r.Context(), id, user.ID, body.Name, body.Description)
	}
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": asset})
}
func (s *server) retryAsset(w http.ResponseWriter, r *http.Request) {
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
	if err := s.media.RetryAsset(r.Context(), id, user.ID); err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	asset, err := s.media.GetAsset(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": asset})
}
func (s *server) deleteAsset(w http.ResponseWriter, r *http.Request) {
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
	if err := s.media.DeleteAsset(r.Context(), id, user.ID); err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type assetSelectionRequest struct {
	AssetIDs []uuid.UUID `json:"assetIds"`
}

func (s *server) archiveAssets(w http.ResponseWriter, r *http.Request) {
	var body assetSelectionRequest
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
	if err := s.media.ArchiveAssets(r.Context(), body.AssetIDs, user.ID); err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"updated": len(body.AssetIDs)}})
}

func (s *server) restoreAssets(w http.ResponseWriter, r *http.Request) {
	var body assetSelectionRequest
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
	if err := s.media.RestoreAssets(r.Context(), body.AssetIDs, user.ID); err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"updated": len(body.AssetIDs)}})
}

func (s *server) assetThumbnail(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	widgetPreview, widgetErr := s.media.WidgetPreview(r.Context(), id)
	if widgetErr == nil {
		hash := sha256.Sum256(widgetPreview.Data)
		w.Header().Set("Content-Type", widgetPreview.ContentType)
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
		w.Header().Set("ETag", fmt.Sprintf(`"sha256-%x"`, hash))
		http.ServeContent(w, r, "", widgetPreview.UpdatedAt, bytes.NewReader(widgetPreview.Data))
		return
	}
	if !errors.Is(widgetErr, media.ErrNotFound) {
		s.writeMediaError(w, r, widgetErr)
		return
	}
	delivery, err := s.media.Preview(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	serveDelivery(w, r, delivery)
}
func (s *server) assetPlaybackPreview(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	delivery, err := s.media.PlaybackPreview(r.Context(), id)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	serveDelivery(w, r, delivery)
}
func (s *server) mediaDiagnostics(w http.ResponseWriter, r *http.Request) {
	diagnostics, err := s.media.Diagnostics()
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": diagnostics})
}

func (s *server) writeMediaError(w http.ResponseWriter, r *http.Request, err error) {
	var dependency *media.DependencyError
	var unavailable *media.PluginUnavailableError
	var configuration *media.ConfigurationError
	switch {
	case errors.As(err, &configuration):
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", configuration.Error())
	case errors.As(err, &dependency):
		writeError(w, http.StatusConflict, "resource_in_use", dependency.Error())
	case errors.As(err, &unavailable):
		// The request is valid; the owning plugin is not installed. Checked
		// before the text-matching cases below, which would otherwise decide
		// the status from words in the message.
		writeError(w, http.StatusConflict, "plugin_not_installed", unavailable.Error())
	case errors.Is(err, media.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "The requested media resource was not found.")
	case errors.Is(err, media.ErrUploadTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "The upload exceeds this installation's size limit.")
	case errors.Is(err, media.ErrOffsetMismatch):
		writeError(w, http.StatusConflict, "upload_offset_mismatch", "The upload offset does not match the accepted offset.")
	case errors.Is(err, media.ErrUploadIncomplete):
		writeError(w, http.StatusConflict, "upload_incomplete", "The upload has not received all expected bytes.")
	case errors.Is(err, media.ErrUploadExpired):
		writeError(w, http.StatusGone, "upload_expired", "The upload session has expired.")
	case errors.Is(err, media.ErrUploadUnavailable):
		writeError(w, http.StatusConflict, "upload_state_conflict", "The upload cannot be changed in its current state.")
	case errors.Is(err, media.ErrInsufficientSpace):
		writeError(w, http.StatusInsufficientStorage, "insufficient_storage", "There is not enough reserved media storage for this upload.")
	case errors.Is(err, media.ErrUnsupportedType):
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "The uploaded file is not a supported image or video.")
	case errors.Is(err, media.ErrInspectionFailed):
		writeError(w, http.StatusUnprocessableEntity, "media_inspection_failed", "Tilecast could not inspect this media file.")
	case errors.Is(err, media.ErrVariantUnavailable):
		writeError(w, http.StatusNotFound, "media_variant_unavailable", "The requested media variant is unavailable.")
	case errors.Is(err, media.ErrNotReady):
		writeError(w, http.StatusConflict, "media_not_ready", "This media asset is not ready.")
	case strings.Contains(err.Error(), "in use by a playlist"):
		writeError(w, http.StatusConflict, "asset_in_use", "This Content item is used by a playlist, Layout, or shared configuration and cannot be deleted.")
	case strings.Contains(err.Error(), "must be") || strings.Contains(err.Error(), "only failed") || strings.Contains(err.Error(), "invalid") || strings.Contains(err.Error(), "outside the configured") || strings.Contains(err.Error(), "exceeds the configured") || strings.Contains(err.Error(), "requires a fallback") || strings.Contains(strings.ToLower(err.Error()), "source") || strings.Contains(err.Error(), "CSV") || strings.Contains(err.Error(), "JSON") || strings.Contains(err.Error(), "YouTube") || strings.Contains(err.Error(), "youtube.com") || strings.Contains(err.Error(), "calendar") || strings.Contains(err.Error(), "volume") || strings.Contains(err.Error(), "start time") || strings.Contains(err.Error(), "end time") || strings.Contains(err.Error(), "caption language") || strings.Contains(err.Error(), "failure behavior") || strings.Contains(err.Error(), "fixed duration"):
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		s.internalError(w, r, err)
	}
}
