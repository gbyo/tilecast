package httpapi

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// errOrganizeCapability is returned from inside a bulk organize transaction
// when the role may not organize one of the selected asset types.
var errOrganizeCapability = errors.New("role cannot organize one of the selected items")

// requireWholeLibrary refuses library restructuring (folders, collections) to
// an account whose content access is restricted. Restructuring moves
// content between folders other accounts are scoped to, so it stays with
// accounts that reach the whole library. It returns false when it has
// already written the response.
func (s *server) requireWholeLibrary(w http.ResponseWriter, r *http.Request) bool {
	access, err := s.contentAccess(r)
	if err != nil {
		s.internalError(w, r, err)
		return false
	}
	if !access.LibraryAll {
		writeError(w, http.StatusForbidden, "content_scope_restricted", "This action requires access to the whole library.")
		return false
	}
	return true
}

// requireAllTags refuses tag management to an account whose tags are
// restricted. Renaming or deleting a tag changes it everywhere it is used.
func (s *server) requireAllTags(w http.ResponseWriter, r *http.Request) bool {
	access, err := s.contentAccess(r)
	if err != nil {
		s.internalError(w, r, err)
		return false
	}
	if !access.TagsAll {
		writeError(w, http.StatusForbidden, "content_scope_restricted", "Managing tags requires access to every tag.")
		return false
	}
	return true
}

// requireDeleteToo is the second half of removing library structure:
// deleting a folder, tag, or collection takes its manage capability (on the
// route) and media.delete. It returns false when it has already written the
// response.
func (s *server) requireDeleteToo(w http.ResponseWriter, r *http.Request) bool {
	if !s.can(r, auth.CapMediaDelete) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Your role does not allow deleting library items.")
		return false
	}
	return true
}

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
	view, err := s.libraryView(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	v, e := s.media.ListFolders(r.Context(), view)
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
	if !s.requireWholeLibrary(w, r) {
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
	if !s.requireWholeLibrary(w, r) {
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
	if !s.requireDeleteToo(w, r) || !s.requireWholeLibrary(w, r) {
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
	view, err := s.libraryView(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	v, e := s.media.ListCollections(r.Context(), view)
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
	if !s.requireWholeLibrary(w, r) {
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
	if !s.requireWholeLibrary(w, r) {
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
	if !s.requireDeleteToo(w, r) || !s.requireWholeLibrary(w, r) {
		return
	}
	if e := s.media.DeleteCollection(r.Context(), id); e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	w.WriteHeader(204)
}
func (s *server) listContentTags(w http.ResponseWriter, r *http.Request) {
	view, err := s.libraryView(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	v, e := s.media.ListTags(r.Context(), view)
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
	if !s.requireAllTags(w, r) {
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
	if !s.requireAllTags(w, r) {
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
	if !s.requireDeleteToo(w, r) || !s.requireAllTags(w, r) {
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
	changesTags := len(b.AddTagIDs) > 0 || len(b.RemoveTagIDs) > 0
	changesPlacement := b.SetFolder || len(b.AddCollectionIDs) > 0 || len(b.RemoveCollectionIDs) > 0
	if changesTags && !principal.Can(auth.CapMediaTagsAssign) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Your role does not allow applying tags.")
		return
	}
	access, err := s.contentAccess(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The whole request is authorized inside the transaction that applies
	// it: one inaccessible asset, unwritable folder, or unassignable tag
	// leaves every asset untouched.
	authorize := func(refs []media.AssetRef) error {
		for _, ref := range refs {
			if !principal.Can(assetCapability(ref.Type, assetRead)) {
				return media.ErrNotFound
			}
		}
		for _, ref := range refs {
			if changesPlacement && !principal.Can(assetCapability(ref.Type, assetOrganize)) {
				return errOrganizeCapability
			}
			if changesTags && ref.Type == "widget" && !principal.Can(auth.CapWidgetEdit) {
				return errOrganizeCapability
			}
		}
		return nil
	}
	u := principal.User
	e := s.media.BulkOrganize(r.Context(), u.ID, media.BulkOrganizeInput{AssetIDs: b.AssetIDs, SetFolder: b.SetFolder, FolderID: b.FolderID, AddTagIDs: b.AddTagIDs, RemoveTagIDs: b.RemoveTagIDs, AddCollectionIDs: b.AddCollectionIDs, RemoveCollectionIDs: b.RemoveCollectionIDs, Access: access, Authorize: authorize})
	if errors.Is(e, errOrganizeCapability) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Your role does not allow organizing one of the selected items.")
		return
	}
	if errors.Is(e, media.ErrOutOfScope) {
		writeError(w, http.StatusNotFound, "content_folder_not_found", "The destination folder was not found.")
		return
	}
	if e != nil {
		s.writeMediaError(w, r, e)
		return
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"updated": len(b.AssetIDs)}})
}
