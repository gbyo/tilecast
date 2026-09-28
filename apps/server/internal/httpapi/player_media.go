package httpapi

import (
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

func (s *server) playerAssetVariant(w http.ResponseWriter, r *http.Request) {
	assetID, err := uuid.Parse(chi.URLParam(r, "assetId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "media_variant_unavailable", "The requested media variant is unavailable.")
		return
	}
	variantID, err := uuid.Parse(chi.URLParam(r, "variantId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "media_variant_unavailable", "The requested media variant is unavailable.")
		return
	}
	delivery, err := s.media.Delivery(r.Context(), assetID, variantID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	serveDelivery(w, r, delivery)
}

func serveDelivery(w http.ResponseWriter, r *http.Request, d media.Delivery) {
	file, err := os.Open(d.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, "media_variant_unavailable", "The requested media variant is unavailable.")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", d.MIMEType)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", media.ETag(d.HashHex))
	http.ServeContent(w, r, "", time.Time{}, file)
}
