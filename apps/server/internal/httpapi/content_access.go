package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// assetAction is the kind of work a request does to library assets. The
// capability it needs depends on the asset's type: media files and Widgets
// share the asset table but are authorized by their own capabilities.
type assetAction int

const (
	assetRead assetAction = iota
	assetEdit
	assetOrganize
	assetArchive
	assetDelete
)

// assetCapability maps an action on an asset type to the capability it needs.
func assetCapability(assetType string, action assetAction) auth.Capability {
	if assetType == "widget" {
		switch action {
		case assetRead:
			return auth.CapWidgetRead
		case assetEdit, assetOrganize:
			return auth.CapWidgetEdit
		default:
			return auth.CapWidgetDelete
		}
	}
	switch action {
	case assetRead:
		return auth.CapMediaRead
	case assetEdit:
		return auth.CapMediaEdit
	case assetOrganize:
		return auth.CapMediaOrganize
	case assetArchive:
		return auth.CapMediaArchive
	default:
		return auth.CapMediaDelete
	}
}

// contentAccess resolves the caller's content policy. The Owner is never
// restricted; every other account reads its explicit policy, and an account
// without one reaches nothing.
func (s *server) contentAccess(r *http.Request) (media.Access, error) {
	principal, ok := principalOf(r)
	if !ok {
		return media.Access{}, errors.New("content access requested without a principal")
	}
	return s.media.AccessFor(r.Context(), principal.User.ID, principal.IsOwner())
}

// libraryView is the caller's content access plus the asset types their role
// may read, which together decide what the Media surfaces show.
func (s *server) libraryView(r *http.Request) (media.View, error) {
	access, err := s.contentAccess(r)
	if err != nil {
		return media.View{}, err
	}
	principal, _ := principalOf(r)
	types := []string{}
	if principal.Can(auth.CapMediaRead) {
		types = append(types, "image", "video")
	}
	if principal.Can(auth.CapWidgetRead) {
		types = append(types, "widget")
	}
	return media.View{Access: access, Types: types}, nil
}

// authorizeAssets checks that the caller may perform action on every asset in
// ids. It is all or nothing: an asset that is missing, outside the caller's
// content access, or of a type the role may not read is reported as not
// found, so a restricted account cannot probe for content outside its
// folders. An asset the caller can see but whose type the role may not
// change is refused with 403. It returns false when it has already written
// the response.
func (s *server) authorizeAssets(w http.ResponseWriter, r *http.Request, ids []uuid.UUID, action assetAction, includeArchived bool) ([]media.AssetRef, bool) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return nil, false
	}
	access, err := s.contentAccess(r)
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	refs, err := s.media.AuthorizeAssets(r.Context(), access, ids, includeArchived)
	if errors.Is(err, media.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "The requested media resource was not found.")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	for _, ref := range refs {
		if !principal.Can(assetCapability(ref.Type, assetRead)) {
			writeError(w, http.StatusNotFound, "not_found", "The requested media resource was not found.")
			return nil, false
		}
	}
	for _, ref := range refs {
		if !principal.Can(assetCapability(ref.Type, action)) {
			writeError(w, http.StatusForbidden, "insufficient_role", "Your role does not allow this action.")
			return nil, false
		}
	}
	return refs, true
}

// authorizeAsset is authorizeAssets for the {id} path parameter.
func (s *server) authorizeAsset(w http.ResponseWriter, r *http.Request, id uuid.UUID, action assetAction, includeArchived bool) (media.AssetRef, bool) {
	refs, ok := s.authorizeAssets(w, r, []uuid.UUID{id}, action, includeArchived)
	if !ok {
		return media.AssetRef{}, false
	}
	return refs[0], true
}

// authorizeUploadDestination is the live upload destination check installed
// on the media service. It reads the creator's current account, role, and
// content policy inside the registering transaction, and locks the policy
// row so a concurrent revocation waits for this registration to finish
// rather than racing it.
func (s *server) authorizeUploadDestination(ctx context.Context, tx pgx.Tx, user uuid.UUID, folder *uuid.UUID) error {
	var role string
	var active bool
	err := tx.QueryRow(ctx, `SELECT role,active FROM users WHERE id=$1`, user).Scan(&role, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return media.ErrOutOfScope
	}
	if err != nil {
		return err
	}
	if !active {
		return media.ErrOutOfScope
	}
	capabilities, err := s.auth.ResolveCapabilities(ctx, role)
	if err != nil {
		return err
	}
	if !capabilities.Has(auth.CapMediaUpload) {
		return media.ErrOutOfScope
	}
	access := media.FullAccess(user)
	if role != auth.RoleOwner {
		access, err = media.LockAccessForUpdate(ctx, tx, user)
		if err != nil {
			return err
		}
	}
	return media.FolderWritableTx(ctx, tx, access, folder)
}

// assetUsageVisibility removes the names of playlists and Layouts that use an
// asset when the caller's role cannot read them. The usage itself stays, so a
// delete warning still says the asset is in use.
func assetUsageVisibility(principal auth.Principal, asset *media.Asset) {
	if !principal.Can(auth.CapPlaylistRead) {
		asset.PlaylistsUsing = nil
	}
	if !principal.Can(auth.CapLayoutRead) {
		for i := range asset.LayoutUsage {
			asset.LayoutUsage[i].Name = ""
		}
	}
}

// --- Account content access administration ---

func (s *server) getUserContentAccess(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	target, err := s.readManagedUser(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "user_not_found", "The user account was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	policy, err := s.media.ContentAccessPolicyFor(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"policy": policy,
		// The Owner always reaches the whole library and every tag; the
		// stored row, if any, is not consulted for that account.
		"ownerUnrestricted": target.Role == auth.RoleOwner,
	}})
}

func (s *server) putUserContentAccess(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body media.ContentAccessInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	if principal.User.ID == id {
		writeError(w, http.StatusForbidden, "cannot_scope_self", "You cannot change your own content access.")
		return
	}
	target, err := s.readManagedUser(r, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "user_not_found", "The user account was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if allowed, err := s.canManageAccount(r.Context(), principal, target.Role); err != nil {
		s.internalError(w, r, err)
		return
	} else if !allowed {
		writeError(w, http.StatusForbidden, "insufficient_role", "You may not change that account.")
		return
	}
	if target.Role == auth.RoleOwner {
		writeError(w, http.StatusUnprocessableEntity, "owner_not_scopable", "An Owner always reaches the whole library.")
		return
	}
	actorAccess, err := s.contentAccess(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.media.ReplaceContentAccess(r.Context(), principal.User.ID, actorAccess, id, body); err != nil {
		s.writeContentAccessError(w, r, err)
		return
	}
	s.getUserContentAccess(w, r)
}

func (s *server) writeContentAccessError(w http.ResponseWriter, r *http.Request, err error) {
	var delegation *media.AccessDelegationError
	var configuration *media.ConfigurationError
	switch {
	case errors.As(err, &delegation):
		writeError(w, http.StatusForbidden, "content_access_delegation", delegation.Error())
	case errors.As(err, &configuration):
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", configuration.Error())
	default:
		s.internalError(w, r, err)
	}
}

// --- The caller's own effective access ---

// getMyAccess reports what the signed-in account may do and reach. Studio
// reads it to decide which workspaces, actions, and upload destinations to
// offer; the API stays the authority for every one of them.
func (s *server) getMyAccess(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	role, err := s.auth.GetRole(r.Context(), principal.User.Role)
	if err != nil && !errors.Is(err, auth.ErrRoleNotFound) {
		s.internalError(w, r, err)
		return
	}
	access, err := s.contentAccess(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writable, err := s.media.WritableFolders(r.Context(), access)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	content := map[string]any{
		"libraryMode": modeName(access.LibraryAll),
		"tagMode":     modeName(access.TagsAll),
	}
	if writable != nil {
		content["writableFolderIds"] = writable
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"role":         map[string]any{"key": principal.User.Role, "name": role.Name, "builtin": auth.IsBuiltinRole(principal.User.Role)},
		"capabilities": principal.Capabilities.Strings(),
		"content":      content,
	}})
}

func modeName(all bool) string {
	if all {
		return media.AccessAll
	}
	return media.AccessRestricted
}
