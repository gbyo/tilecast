package httpapi

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/fonts"
)

// fontUploadOverhead covers the multipart envelope around one font file.
const fontUploadOverhead = 64 << 10

func (s *server) listFonts(w http.ResponseWriter, r *http.Request) {
	families, err := s.fonts.List(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": families, "total": len(families)}})
}

func (s *server) fontFaceFile(w http.ResponseWriter, r *http.Request) {
	familyID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	faceID, ok := urlUUID(w, r, "faceId")
	if !ok {
		return
	}
	delivery, err := s.fonts.FaceDelivery(r.Context(), familyID, faceID)
	if err != nil {
		s.writeFontError(w, r, err)
		return
	}
	// A stored face never changes; removing a family removes its address.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	serveDelivery(w, r, delivery)
}

func (s *server) importGoogleFont(w http.ResponseWriter, r *http.Request) {
	var body fonts.GoogleImport
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	family, err := s.fonts.ImportGoogle(r.Context(), principal.User.ID, body)
	if err != nil {
		s.writeFontError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": family})
}

func (s *server) uploadFont(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, fonts.MaxUploadBytes+fontUploadOverhead)
	if err := r.ParseMultipartForm(fonts.MaxUploadBytes + fontUploadOverhead); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "font_too_large", "A font file can be at most 15 MB.")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "Send one font file as multipart form data.")
		return
	}
	defer r.MultipartForm.RemoveAll() //nolint:errcheck
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Send one font file in the file field.")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, fonts.MaxUploadBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The font file could not be read.")
		return
	}
	confirmed, _ := strconv.ParseBool(strings.TrimSpace(r.FormValue("rightsConfirmed")))
	result, err := s.fonts.Upload(r.Context(), principal.User.ID, header.Filename, data, confirmed)
	if err != nil {
		s.writeFontError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": result})
}

func (s *server) deleteFont(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	if err := s.fonts.Delete(r.Context(), principal.User.ID, id); err != nil {
		s.writeFontError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) searchFontCatalog(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	category := query.Get("category")
	switch category {
	case "", "sans-serif", "serif", "display", "handwriting", "monospace", "icons":
	default:
		writeError(w, http.StatusUnprocessableEntity, "invalid_request", "Choose a known font category.")
		return
	}
	page, err := s.fonts.Catalog().Search(r.Context(), query.Get("q"), category, limit, offset)
	if err != nil {
		s.writeFontError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": page})
}

func (s *server) getFontCatalogFamily(w http.ResponseWriter, r *http.Request) {
	detail, err := s.fonts.Catalog().Detail(r.Context(), chi.URLParam(r, "sourceId"))
	if err != nil {
		s.writeFontError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": detail})
}

func (s *server) fontCatalogPreview(w http.ResponseWriter, r *http.Request) {
	data, err := s.fonts.Catalog().Preview(r.Context(), chi.URLParam(r, "sourceId"))
	if err != nil {
		s.writeFontError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "font/woff2")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

func (s *server) writeFontError(w http.ResponseWriter, r *http.Request, err error) {
	var inUse *fonts.InUse
	switch {
	case errors.As(err, &inUse):
		message := "Choose another font where this one is used first:"
		if len(inUse.Layouts) > 0 {
			names := make([]string, 0, len(inUse.Layouts))
			for _, layout := range inUse.Layouts {
				names = append(names, layout.Name)
			}
			message += " Layouts " + strings.Join(names, ", ") + "."
		}
		if len(inUse.Plugins) > 0 {
			message += " Plugins " + strings.Join(inUse.Plugins, ", ") + "."
		}
		writeError(w, http.StatusConflict, "font_in_use", message)
	case errors.Is(err, fonts.ErrNotFound):
		writeError(w, http.StatusNotFound, "font_not_found", "The font was not found.")
	case errors.Is(err, fonts.ErrExists):
		writeError(w, http.StatusConflict, "font_exists", "A font family with this name is already in the library.")
	case errors.Is(err, fonts.ErrRightsRequired):
		writeError(w, http.StatusUnprocessableEntity, "font_rights_required", "Confirm that your organization may use this font on its displays.")
	case errors.Is(err, fonts.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "font_too_large", err.Error())
	case errors.Is(err, fonts.ErrUnsupportedFile):
		writeError(w, http.StatusUnprocessableEntity, "font_unsupported", err.Error())
	case errors.Is(err, fonts.ErrInvalid):
		writeError(w, http.StatusUnprocessableEntity, "font_invalid", err.Error())
	case errors.Is(err, fonts.ErrCatalogDisabled):
		writeError(w, http.StatusServiceUnavailable, "font_catalog_disabled", "The Google Fonts catalog is turned off on this server. Upload font files instead.")
	case errors.Is(err, fonts.ErrCatalogUnavailable):
		s.logger.Warn("font catalog unavailable", "error", err)
		writeError(w, http.StatusBadGateway, "font_catalog_unavailable", "Tilecast could not reach the Google Fonts catalog. Check the server's internet access, or upload font files instead.")
	default:
		s.internalError(w, r, err)
	}
}
