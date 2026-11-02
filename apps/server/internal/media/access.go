package media

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
)

// Content access narrows which part of the Media library an account reaches.
//
// The rules, in one place because every caller depends on all of them:
//
//   - Every account has an explicit policy. An account without a policy row
//     reaches nothing; there is no "no rows means everything" default.
//   - The Owner is never restricted. An installation must not be able to lock
//     itself out of its own library.
//   - Library mode "all" is the whole library. "restricted" is the union of
//     the granted folders and every folder beneath them. An asset with no
//     folder is outside every restricted policy.
//   - Tags are controlled metadata, not visibility. Tag mode governs which
//     tags an account may apply or remove; carrying an allowed tag never
//     makes an asset visible.
//   - Content access is a management boundary. Player playback, manifests,
//     and tag-driven playlists resolve the whole library regardless of who
//     last edited an asset.

// Library and tag modes.
const (
	AccessAll        = "all"
	AccessRestricted = "restricted"
)

// ErrOutOfScope means the account may not reach that content. Callers report
// it as not found so a restricted account learns nothing about content
// outside its folders.
var ErrOutOfScope = errors.New("content is outside your access")

// ErrScopeRestricted means the operation needs the whole library or every
// tag, such as restructuring folders, curating collections, or managing tags.
var ErrScopeRestricted = errors.New("this action requires access to the whole library")

// ErrTagNotAssignable means the account may not apply or remove a tag.
var ErrTagNotAssignable = errors.New("one or more tags cannot be applied by your account")

// Access is one account's resolved content policy.
type Access struct {
	UserID     uuid.UUID
	LibraryAll bool
	TagsAll    bool
}

// View is what one account may see in the library: its content access and
// the asset types its role may read. A nil Types means every type.
type View struct {
	Access Access
	Types  []string
}

// typeClause appends the readable-type predicate, TRUE for every type.
func (v View) typeClause(alias string, args *[]any) string {
	if v.Types == nil {
		return "TRUE"
	}
	*args = append(*args, v.Types)
	return alias + ".type=ANY($" + strconv.Itoa(len(*args)) + ")"
}

// assetClause is the full visibility predicate for one asset row.
func (v View) assetClause(alias string, args *[]any) string {
	return "(" + v.Access.assetScopeClause(alias, args) + " AND " + v.typeClause(alias, args) + ")"
}

// FullAccess is the unrestricted policy, used for the Owner and for internal
// callers that are not acting for a Studio user.
func FullAccess(user uuid.UUID) Access {
	return Access{UserID: user, LibraryAll: true, TagsAll: true}
}

// AccessFor resolves an account's policy. owner is the built-in Owner role,
// which is always unrestricted. A missing policy row fails closed.
func (s *Service) AccessFor(ctx context.Context, user uuid.UUID, owner bool) (Access, error) {
	if owner {
		return FullAccess(user), nil
	}
	return accessFor(ctx, s.db, user)
}

type queryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func accessFor(ctx context.Context, db queryRower, user uuid.UUID) (Access, error) {
	var library, tags string
	err := db.QueryRow(ctx, `SELECT library_mode,tag_mode FROM user_content_access WHERE user_id=$1`, user).Scan(&library, &tags)
	if errors.Is(err, pgx.ErrNoRows) {
		return Access{UserID: user}, nil
	}
	if err != nil {
		return Access{}, fmt.Errorf("read content access: %w", err)
	}
	return Access{UserID: user, LibraryAll: library == AccessAll, TagsAll: tags == AccessAll}, nil
}

// LockAccessForUpdate reads user's policy inside tx and holds a share lock on
// the policy row until tx ends. ReplaceContentAccess updates that row first,
// so a revocation waits for a registration that already passed this check
// instead of racing it. The caller decides separately whether user is the
// Owner.
func LockAccessForUpdate(ctx context.Context, tx pgx.Tx, user uuid.UUID) (Access, error) {
	var library, tags string
	err := tx.QueryRow(ctx, `SELECT library_mode,tag_mode FROM user_content_access WHERE user_id=$1 FOR SHARE`, user).Scan(&library, &tags)
	if errors.Is(err, pgx.ErrNoRows) {
		return Access{UserID: user}, nil
	}
	if err != nil {
		return Access{}, fmt.Errorf("lock content access: %w", err)
	}
	return Access{UserID: user, LibraryAll: library == AccessAll, TagsAll: tags == AccessAll}, nil
}

// FolderWritableTx is FolderWritable inside an open transaction.
func FolderWritableTx(ctx context.Context, tx pgx.Tx, access Access, folder *uuid.UUID) error {
	return folderWritable(ctx, tx, access, folder)
}

// AccessibleFoldersSQL is the one definition of the folders a restricted
// account reaches: its granted folders and every descendant. userParam is
// the placeholder holding the account id. UNION (not UNION ALL) also stops
// the walk if a cycle ever existed.
func AccessibleFoldersSQL(userParam string) string {
	return `WITH RECURSIVE accessible_folders(id) AS (
		SELECT g.folder_id FROM user_content_folder_grants g WHERE g.user_id=` + userParam + `
		UNION
		SELECT f.id FROM content_folders f JOIN accessible_folders af ON f.parent_id=af.id
	) SELECT id FROM accessible_folders`
}

// AssetInScopeSQL is the one definition of "this asset is within that
// account's content access" for a restricted policy. Every scoped read and
// every scoped mutation is built from it, so the library a person sees and
// the assets they may act on cannot diverge. It is false, never NULL, for an
// asset without a folder, so it is also safe to negate.
func AssetInScopeSQL(alias, userParam string) string {
	return `(` + alias + `.folder_id IS NOT NULL AND ` + alias + `.folder_id IN (` + AccessibleFoldersSQL(userParam) + `))`
}

// assetScopeClause appends the scope predicate for access to a list of
// arguments, returning the SQL fragment. It is TRUE for the whole library.
func (a Access) assetScopeClause(alias string, args *[]any) string {
	if a.LibraryAll {
		return "TRUE"
	}
	*args = append(*args, a.UserID)
	return AssetInScopeSQL(alias, "$"+strconv.Itoa(len(*args)))
}

// FolderWritable reports whether access may place content in folder. A nil
// folder is the library root, which needs the whole library.
func (s *Service) FolderWritable(ctx context.Context, access Access, folder *uuid.UUID) error {
	return folderWritable(ctx, s.db, access, folder)
}

func folderWritable(ctx context.Context, db queryRower, access Access, folder *uuid.UUID) error {
	if folder == nil {
		if access.LibraryAll {
			return nil
		}
		return ErrOutOfScope
	}
	var exists, inScope bool
	query := `SELECT EXISTS(SELECT 1 FROM content_folders WHERE id=$1), TRUE`
	args := []any{*folder}
	if !access.LibraryAll {
		query = `SELECT EXISTS(SELECT 1 FROM content_folders WHERE id=$1), $1 IN (` + AccessibleFoldersSQL("$2") + `)`
		args = append(args, access.UserID)
	}
	if err := db.QueryRow(ctx, query, args...).Scan(&exists, &inScope); err != nil {
		return err
	}
	if !exists || !inScope {
		return ErrOutOfScope
	}
	return nil
}

// TagsAssignable reports whether access may add or remove every tag in ids.
// A tag that does not exist is reported as not assignable.
func (s *Service) TagsAssignable(ctx context.Context, access Access, ids []uuid.UUID) error {
	return tagsAssignable(ctx, s.db, access, ids)
}

func tagsAssignable(ctx context.Context, db queryRower, access Access, ids []uuid.UUID) error {
	unique := uniqueIDs(ids)
	if len(unique) == 0 {
		return nil
	}
	query := `SELECT count(*) FROM content_tags WHERE id=ANY($1)`
	args := []any{unique}
	if !access.TagsAll {
		query = `SELECT count(*) FROM content_tags t JOIN user_content_tag_grants g ON g.tag_id=t.id AND g.user_id=$2 WHERE t.id=ANY($1)`
		args = append(args, access.UserID)
	}
	var count int
	if err := db.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		return err
	}
	if count != len(unique) {
		return ErrTagNotAssignable
	}
	return nil
}

// AssetRef is the authorization-relevant shape of one library asset.
type AssetRef struct {
	ID   uuid.UUID
	Type string
}

// AuthorizeAssets resolves every id to its type, all or nothing. It returns
// ErrNotFound when any id is missing, deleted, a Form attachment, or outside
// access, so a restricted account cannot tell those apart and a
// bulk request that names one inaccessible asset changes nothing.
func (s *Service) AuthorizeAssets(ctx context.Context, access Access, ids []uuid.UUID, includeArchived bool) ([]AssetRef, error) {
	return authorizeAssets(ctx, s.db, access, ids, includeArchived)
}

type queryer interface {
	queryRower
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func authorizeAssets(ctx context.Context, db queryer, access Access, ids []uuid.UUID, includeArchived bool) ([]AssetRef, error) {
	unique := uniqueIDs(ids)
	if len(unique) == 0 {
		return []AssetRef{}, nil
	}
	args := []any{unique}
	// Plugin-managed (system_managed) Widgets are library rows a playlist
	// can reference, so they stay addressable by id; they carry no folder,
	// which keeps them outside every restricted policy. Form attachments are
	// never Media.
	where := []string{"a.id=ANY($1)", "a.deleted_at IS NULL", "a.origin='library'"}
	if !includeArchived {
		where = append(where, "a.archived_at IS NULL", "(a.expires_at IS NULL OR a.expires_at>now())")
	}
	where = append(where, access.assetScopeClause("a", &args))
	query := "SELECT a.id,a.type FROM assets a WHERE "
	for i, clause := range where {
		if i > 0 {
			query += " AND "
		}
		query += clause
	}
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	refs := []AssetRef{}
	for rows.Next() {
		var ref AssetRef
		if err := rows.Scan(&ref.ID, &ref.Type); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(refs) != len(unique) {
		return nil, ErrNotFound
	}
	return refs, nil
}

func uniqueIDs(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// ContentAccessPolicy is an account's stored policy with its grants resolved
// to names, for the user administration surface.
type ContentAccessPolicy struct {
	LibraryMode string             `json:"libraryMode"`
	TagMode     string             `json:"tagMode"`
	Folders     []ContentGrantName `json:"folders"`
	Tags        []ContentGrantName `json:"tags"`
	// Configured is false when the account has no policy row, which means it
	// reaches nothing until one is saved.
	Configured bool `json:"configured"`
}

// ContentGrantName is one granted folder or tag.
type ContentGrantName struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
	// Path is the folder's ancestry joined with " / ", for folders only.
	Path string `json:"path,omitempty"`
}

// ContentAccessInput replaces an account's policy.
type ContentAccessInput struct {
	LibraryMode string      `json:"libraryMode"`
	TagMode     string      `json:"tagMode"`
	FolderIDs   []uuid.UUID `json:"folderIds"`
	TagIDs      []uuid.UUID `json:"tagIds"`
}

// ContentAccessPolicyFor returns an account's stored policy.
func (s *Service) ContentAccessPolicyFor(ctx context.Context, user uuid.UUID) (ContentAccessPolicy, error) {
	policy := ContentAccessPolicy{LibraryMode: AccessRestricted, TagMode: AccessRestricted, Folders: []ContentGrantName{}, Tags: []ContentGrantName{}}
	err := s.db.QueryRow(ctx, `SELECT library_mode,tag_mode FROM user_content_access WHERE user_id=$1`, user).Scan(&policy.LibraryMode, &policy.TagMode)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ContentAccessPolicy{}, err
	}
	policy.Configured = err == nil
	rows, err := s.db.Query(ctx, `
		WITH RECURSIVE chain(grant_id,id,parent_id,name,depth) AS (
			SELECT f.id,f.id,f.parent_id,f.name,0 FROM user_content_folder_grants g JOIN content_folders f ON f.id=g.folder_id WHERE g.user_id=$1
			UNION ALL
			SELECT c.grant_id,p.id,p.parent_id,p.name,c.depth+1 FROM content_folders p JOIN chain c ON p.id=c.parent_id WHERE c.depth<32
		)
		SELECT grant_id,
		       (SELECT name FROM chain c2 WHERE c2.grant_id=c.grant_id AND c2.depth=0),
		       string_agg(name,' / ' ORDER BY depth DESC)
		FROM chain c GROUP BY grant_id ORDER BY 3`, user)
	if err != nil {
		return ContentAccessPolicy{}, err
	}
	for rows.Next() {
		var grant ContentGrantName
		if err := rows.Scan(&grant.ID, &grant.Name, &grant.Path); err != nil {
			rows.Close()
			return ContentAccessPolicy{}, err
		}
		policy.Folders = append(policy.Folders, grant)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ContentAccessPolicy{}, err
	}
	rows, err = s.db.Query(ctx, `SELECT t.id,t.name FROM user_content_tag_grants g JOIN content_tags t ON t.id=g.tag_id WHERE g.user_id=$1 ORDER BY lower(t.name),t.id`, user)
	if err != nil {
		return ContentAccessPolicy{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var grant ContentGrantName
		if err := rows.Scan(&grant.ID, &grant.Name); err != nil {
			return ContentAccessPolicy{}, err
		}
		policy.Tags = append(policy.Tags, grant)
	}
	return policy, rows.Err()
}

// AccessDelegationError explains why an actor may not grant a policy.
type AccessDelegationError struct{ Reason string }

func (e *AccessDelegationError) Error() string { return e.Reason }

// ReplaceContentAccess sets an account's policy. actorAccess is the policy of
// the person making the change: nobody may grant content they cannot reach
// themselves, so a restricted administrator can hand out only folders inside
// their own access and only tags they may apply.
func (s *Service) ReplaceContentAccess(ctx context.Context, actor uuid.UUID, actorAccess Access, user uuid.UUID, input ContentAccessInput) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := ReplaceContentAccessTx(ctx, tx, actor, actorAccess, user, input); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReplaceContentAccessTx is ReplaceContentAccess inside an open transaction,
// so account creation can write the policy atomically with the account.
func ReplaceContentAccessTx(ctx context.Context, tx pgx.Tx, actor uuid.UUID, actorAccess Access, user uuid.UUID, input ContentAccessInput) error {
	if input.LibraryMode != AccessAll && input.LibraryMode != AccessRestricted {
		return &ConfigurationError{Err: errors.New("libraryMode must be all or restricted")}
	}
	if input.TagMode != AccessAll && input.TagMode != AccessRestricted {
		return &ConfigurationError{Err: errors.New("tagMode must be all or restricted")}
	}
	folders, tags := uniqueIDs(input.FolderIDs), uniqueIDs(input.TagIDs)
	if input.LibraryMode == AccessAll {
		folders = nil
	}
	if input.TagMode == AccessAll {
		tags = nil
	}
	if len(folders) > 200 || len(tags) > 200 {
		return &ConfigurationError{Err: errors.New("a policy may grant at most 200 folders and 200 tags")}
	}
	if input.LibraryMode == AccessAll && !actorAccess.LibraryAll {
		return &AccessDelegationError{Reason: "you cannot grant the whole library because your own access is restricted"}
	}
	if input.TagMode == AccessAll && !actorAccess.TagsAll {
		return &AccessDelegationError{Reason: "you cannot grant every tag because your own tags are restricted"}
	}
	for _, folder := range folders {
		id := folder
		if err := folderWritable(ctx, tx, actorAccess, &id); err != nil {
			if errors.Is(err, ErrOutOfScope) {
				return &AccessDelegationError{Reason: "one of the selected folders does not exist or is outside your own access"}
			}
			return err
		}
	}
	if err := tagsAssignable(ctx, tx, actorAccess, tags); err != nil {
		if errors.Is(err, ErrTagNotAssignable) {
			return &AccessDelegationError{Reason: "one of the selected tags does not exist or is outside your own tags"}
		}
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_content_access(user_id,library_mode,tag_mode,updated_by,updated_at)
		VALUES($1,$2,$3,$4,now())
		ON CONFLICT(user_id) DO UPDATE SET library_mode=EXCLUDED.library_mode,tag_mode=EXCLUDED.tag_mode,updated_by=EXCLUDED.updated_by,updated_at=now()`,
		user, input.LibraryMode, input.TagMode, actor); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_content_folder_grants WHERE user_id=$1`, user); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_content_tag_grants WHERE user_id=$1`, user); err != nil {
		return err
	}
	if len(folders) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO user_content_folder_grants(user_id,folder_id,created_by) SELECT $1,unnest($2::uuid[]),$3`, user, folders, actor); err != nil {
			return err
		}
	}
	if len(tags) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO user_content_tag_grants(user_id,tag_id,created_by) SELECT $1,unnest($2::uuid[]),$3`, user, tags, actor); err != nil {
			return err
		}
	}
	actorID := actor
	return audit.RecordTx(ctx, tx, audit.Event{
		Action: "user.content_access_changed", ResourceType: "user", ResourceID: user.String(),
		Summary:  fmt.Sprintf("Content access set to %s library, %s tags", input.LibraryMode, input.TagMode),
		Metadata: map[string]any{"libraryMode": input.LibraryMode, "tagMode": input.TagMode, "folderCount": len(folders), "tagCount": len(tags)},
		Actor:    &actorID,
	})
}

// WritableFolders lists the folders access may place content in, for the
// upload destination picker. It is nil for the whole library, which may also
// use the root.
func (s *Service) WritableFolders(ctx context.Context, access Access) ([]uuid.UUID, error) {
	if access.LibraryAll {
		return nil, nil
	}
	rows, err := s.db.Query(ctx, AccessibleFoldersSQL("$1"), access.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
