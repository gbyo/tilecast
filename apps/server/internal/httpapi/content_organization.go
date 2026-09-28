package httpapi

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

type folderRequest struct {
	ParentID    *uuid.UUID `json:"parentId"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
}
type collectionRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}
type tagRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}
type bulkOrganizeRequest struct {
	AssetIDs            []uuid.UUID `json:"assetIds"`
	FolderID            *uuid.UUID  `json:"folderId"`
	SetFolder           bool        `json:"setFolder"`
	AddTagIDs           []uuid.UUID `json:"addTagIds"`
	RemoveTagIDs        []uuid.UUID `json:"removeTagIds"`
	AddCollectionIDs    []uuid.UUID `json:"addCollectionIds"`
	RemoveCollectionIDs []uuid.UUID `json:"removeCollectionIds"`
}

func (s *server) listContentFolders(w http.ResponseWriter, r *http.Request) {
	v, e := s.media.ListFolders(r.Context())
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}
func (s *server) createContentFolder(w http.ResponseWriter, r *http.Request) {
	var b folderRequest
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, 400, "invalid_request", e.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	v, e := s.media.CreateFolder(r.Context(), u.ID, b.ParentID, b.Name, b.Description)
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 201, map[string]any{"data": v})
}
func (s *server) updateContentFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var b folderRequest
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, 400, "invalid_request", e.Error())
		return
	}
	v, e := s.media.UpdateFolder(r.Context(), id, b.ParentID, b.Name, b.Description)
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 200, map[string]any{"data": v})
}
func (s *server) deleteContentFolder(w http.ResponseWriter, r *http.Request) {
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
	if e := s.media.DeleteFolder(r.Context(), id, u.ID); e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	w.WriteHeader(204)
}
func (s *server) listContentCollections(w http.ResponseWriter, r *http.Request) {
	v, e := s.media.ListCollections(r.Context())
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 200, map[string]any{"data": v})
}
func (s *server) createContentCollection(w http.ResponseWriter, r *http.Request) {
	var b collectionRequest
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, 400, "invalid_request", e.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	v, e := s.media.CreateCollection(r.Context(), u.ID, b.Name, b.Description)
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 201, map[string]any{"data": v})
}
func (s *server) updateContentCollection(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var b collectionRequest
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, 400, "invalid_request", e.Error())
		return
	}
	v, e := s.media.UpdateCollection(r.Context(), id, b.Name, b.Description)
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 200, map[string]any{"data": v})
}
func (s *server) deleteContentCollection(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	if e := s.media.DeleteCollection(r.Context(), id); e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	w.WriteHeader(204)
}
func (s *server) listContentTags(w http.ResponseWriter, r *http.Request) {
	v, e := s.media.ListTags(r.Context())
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 200, map[string]any{"data": v})
}
func (s *server) createContentTag(w http.ResponseWriter, r *http.Request) {
	var b tagRequest
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, 400, "invalid_request", e.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	v, e := s.media.CreateTag(r.Context(), u.ID, b.Name, b.Color)
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 201, map[string]any{"data": v})
}
func (s *server) updateContentTag(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var b tagRequest
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, 400, "invalid_request", e.Error())
		return
	}
	v, e := s.media.UpdateTag(r.Context(), id, b.Name, b.Color)
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 200, map[string]any{"data": v})
}
func (s *server) deleteContentTag(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	if e := s.media.DeleteTag(r.Context(), id); e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	w.WriteHeader(204)
}
func (s *server) bulkOrganizeContent(w http.ResponseWriter, r *http.Request) {
	var b bulkOrganizeRequest
	if e := decodeJSON(w, r, &b); e != nil {
		writeError(w, 400, "invalid_request", e.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	u := principal.User
	e := s.media.BulkOrganize(r.Context(), u.ID, media.BulkOrganizeInput{AssetIDs: b.AssetIDs, SetFolder: b.SetFolder, FolderID: b.FolderID, AddTagIDs: b.AddTagIDs, RemoveTagIDs: b.RemoveTagIDs, AddCollectionIDs: b.AddCollectionIDs, RemoveCollectionIDs: b.RemoveCollectionIDs})
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"updated": len(b.AssetIDs)}})
}
