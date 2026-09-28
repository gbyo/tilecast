package media

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
)

func cleanOrganizationName(name string, max int) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > max {
		return "", fmt.Errorf("name must be between 1 and %d characters", max)
	}
	return name, nil
}

func (s *Service) ListFolders(ctx context.Context) ([]ContentFolder, error) {
	rows, err := s.db.Query(ctx, `SELECT f.id,f.parent_id,f.name,f.description,count(a.id),f.created_at,f.updated_at FROM content_folders f LEFT JOIN assets a ON a.folder_id=f.id AND a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) GROUP BY f.id ORDER BY lower(f.name),f.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ContentFolder{}
	for rows.Next() {
		var v ContentFolder
		if err := rows.Scan(&v.ID, &v.ParentID, &v.Name, &v.Description, &v.AssetCount, &v.CreatedAt, &v.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}

func (s *Service) CreateFolder(ctx context.Context, userID uuid.UUID, parentID *uuid.UUID, name, description string) (ContentFolder, error) {
	name, err := cleanOrganizationName(name, 120)
	if err != nil {
		return ContentFolder{}, err
	}
	if len(strings.TrimSpace(description)) > 500 {
		return ContentFolder{}, errors.New("description must be 500 characters or fewer")
	}
	id := uuid.New()
	var v ContentFolder
	err = s.db.QueryRow(ctx, `INSERT INTO content_folders(id,organization_id,parent_id,name,description,created_by) SELECT $1,id,$2,$3,$4,$5 FROM organization_settings RETURNING id,parent_id,name,description,0,created_at,updated_at`, id, parentID, name, strings.TrimSpace(description), userID).Scan(&v.ID, &v.ParentID, &v.Name, &v.Description, &v.AssetCount, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

func (s *Service) UpdateFolder(ctx context.Context, id uuid.UUID, parentID *uuid.UUID, name, description string) (ContentFolder, error) {
	name, err := cleanOrganizationName(name, 120)
	if err != nil {
		return ContentFolder{}, err
	}
	if parentID != nil {
		if *parentID == id {
			return ContentFolder{}, errors.New("a folder cannot contain itself")
		}
		var cycle bool
		err = s.db.QueryRow(ctx, `WITH RECURSIVE parents AS (SELECT id,parent_id FROM content_folders WHERE id=$1 UNION ALL SELECT f.id,f.parent_id FROM content_folders f JOIN parents p ON f.id=p.parent_id) SELECT EXISTS(SELECT 1 FROM parents WHERE id=$2)`, parentID, id).Scan(&cycle)
		if err != nil || cycle {
			if cycle {
				return ContentFolder{}, errors.New("a folder cannot be moved inside itself")
			}
			return ContentFolder{}, err
		}
	}
	var v ContentFolder
	err = s.db.QueryRow(ctx, `UPDATE content_folders SET parent_id=$2,name=$3,description=$4,updated_at=now() WHERE id=$1 RETURNING id,parent_id,name,description,(SELECT count(*) FROM assets WHERE folder_id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND (expires_at IS NULL OR expires_at>now())),created_at,updated_at`, id, parentID, name, strings.TrimSpace(description)).Scan(&v.ID, &v.ParentID, &v.Name, &v.Description, &v.AssetCount, &v.CreatedAt, &v.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return v, err
}

func (s *Service) DeleteFolder(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE content_folders SET parent_id=NULL,updated_at=now() WHERE parent_id=$1`, id); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM content_folders WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'content.folder_deleted','content_folder',$3)`, uuid.New(), userID, id.String())
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Service) ListCollections(ctx context.Context) ([]ContentCollection, error) {
	rows, err := s.db.Query(ctx, `SELECT c.id,c.name,c.description,count(a.id),c.created_at,c.updated_at FROM content_collections c LEFT JOIN content_collection_assets ca ON ca.collection_id=c.id LEFT JOIN assets a ON a.id=ca.asset_id AND a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) GROUP BY c.id ORDER BY lower(c.name),c.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ContentCollection{}
	for rows.Next() {
		var v ContentCollection
		if err := rows.Scan(&v.ID, &v.Name, &v.Description, &v.AssetCount, &v.CreatedAt, &v.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}

func (s *Service) CreateCollection(ctx context.Context, userID uuid.UUID, name, description string) (ContentCollection, error) {
	name, err := cleanOrganizationName(name, 120)
	if err != nil {
		return ContentCollection{}, err
	}
	if len(strings.TrimSpace(description)) > 500 {
		return ContentCollection{}, errors.New("description must be 500 characters or fewer")
	}
	id := uuid.New()
	var v ContentCollection
	err = s.db.QueryRow(ctx, `INSERT INTO content_collections(id,organization_id,name,description,created_by) SELECT $1,id,$2,$3,$4 FROM organization_settings RETURNING id,name,description,0,created_at,updated_at`, id, name, strings.TrimSpace(description), userID).Scan(&v.ID, &v.Name, &v.Description, &v.AssetCount, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

func (s *Service) UpdateCollection(ctx context.Context, id uuid.UUID, name, description string) (ContentCollection, error) {
	name, err := cleanOrganizationName(name, 120)
	if err != nil {
		return ContentCollection{}, err
	}
	if len(strings.TrimSpace(description)) > 500 {
		return ContentCollection{}, errors.New("description must be 500 characters or fewer")
	}
	var v ContentCollection
	err = s.db.QueryRow(ctx, `UPDATE content_collections SET name=$2,description=$3,updated_at=now() WHERE id=$1 RETURNING id,name,description,(SELECT count(*) FROM content_collection_assets ca JOIN assets a ON a.id=ca.asset_id WHERE ca.collection_id=$1 AND a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())),created_at,updated_at`, id, name, strings.TrimSpace(description)).Scan(&v.ID, &v.Name, &v.Description, &v.AssetCount, &v.CreatedAt, &v.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return v, err
}

func (s *Service) DeleteCollection(ctx context.Context, id uuid.UUID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM content_collections WHERE id=$1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Service) ListTags(ctx context.Context) ([]ContentTag, error) {
	rows, err := s.db.Query(ctx, `SELECT t.id,t.name,t.color,count(a.id) FROM content_tags t LEFT JOIN content_asset_tags at ON at.tag_id=t.id LEFT JOIN assets a ON a.id=at.asset_id AND a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) GROUP BY t.id ORDER BY lower(t.name),t.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ContentTag{}
	for rows.Next() {
		var v ContentTag
		if err := rows.Scan(&v.ID, &v.Name, &v.Color, &v.AssetCount); err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}

func (s *Service) CreateTag(ctx context.Context, userID uuid.UUID, name, color string) (ContentTag, error) {
	name, err := cleanOrganizationName(name, 60)
	if err != nil {
		return ContentTag{}, err
	}
	if color == "" {
		color = "#64748b"
	}
	if !regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`).MatchString(color) {
		return ContentTag{}, errors.New("color must be a six-digit hexadecimal color")
	}
	id := ids.New(ctx)
	var v ContentTag
	err = s.db.QueryRow(ctx, `INSERT INTO content_tags(id,organization_id,name,color,created_by) SELECT $1,id,$2,$3,$4 FROM organization_settings RETURNING id,name,color,0`, id, name, color, userID).Scan(&v.ID, &v.Name, &v.Color, &v.AssetCount)
	return v, err
}

func (s *Service) UpdateTag(ctx context.Context, id uuid.UUID, name, color string) (ContentTag, error) {
	name, err := cleanOrganizationName(name, 60)
	if err != nil {
		return ContentTag{}, err
	}
	if color == "" {
		color = "#64748b"
	}
	if !regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`).MatchString(color) {
		return ContentTag{}, errors.New("color must be a six-digit hexadecimal color")
	}
	var v ContentTag
	err = s.db.QueryRow(ctx, `UPDATE content_tags SET name=$2,color=$3 WHERE id=$1 RETURNING id,name,color,(SELECT count(*) FROM content_asset_tags at JOIN assets a ON a.id=at.asset_id WHERE at.tag_id=$1 AND a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()))`, id, name, color).Scan(&v.ID, &v.Name, &v.Color, &v.AssetCount)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return v, err
}

func (s *Service) DeleteTag(ctx context.Context, id uuid.UUID) error {
	rows, err := s.db.Query(ctx, `SELECT p.name FROM playlist_tags pt JOIN playlists p ON p.id=pt.playlist_id WHERE pt.tag_id=$1 AND p.deleted_at IS NULL ORDER BY p.name LIMIT 10`, id)
	if err != nil {
		return err
	}
	usedBy := []string{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		usedBy = append(usedBy, "playlist "+name)
	}
	rows.Close()
	if len(usedBy) > 0 {
		return &DependencyError{Resource: "Tag", UsedBy: usedBy}
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM content_tags WHERE id=$1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Service) BulkOrganize(ctx context.Context, userID uuid.UUID, in BulkOrganizeInput) error {
	if len(in.AssetIDs) == 0 || len(in.AssetIDs) > 250 {
		return errors.New("assetIds must contain between 1 and 250 unique assets")
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range in.AssetIDs {
		if seen[id] {
			return errors.New("assetIds must not contain duplicates")
		}
		seen[id] = true
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM assets WHERE id=ANY($1) AND deleted_at IS NULL AND archived_at IS NULL AND (expires_at IS NULL OR expires_at>now())`, in.AssetIDs).Scan(&count); err != nil {
		return err
	}
	if count != len(in.AssetIDs) {
		return ErrNotFound
	}
	allTagIDs := append(append([]uuid.UUID{}, in.AddTagIDs...), in.RemoveTagIDs...)
	allCollectionIDs := append(append([]uuid.UUID{}, in.AddCollectionIDs...), in.RemoveCollectionIDs...)
	if err = validateOrganizationIDs(ctx, tx, "content_tags", allTagIDs); err != nil {
		return err
	}
	if err = validateOrganizationIDs(ctx, tx, "content_collections", allCollectionIDs); err != nil {
		return err
	}
	if in.SetFolder {
		if in.FolderID != nil {
			var ok bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content_folders WHERE id=$1)`, in.FolderID).Scan(&ok); err != nil || !ok {
				if err == nil {
					return ErrNotFound
				}
				return err
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE assets SET folder_id=$2,updated_at=now() WHERE id=ANY($1)`, in.AssetIDs, in.FolderID); err != nil {
			return err
		}
	}
	for _, id := range in.AddTagIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO content_asset_tags(asset_id,tag_id) SELECT unnest($1::uuid[]),$2 ON CONFLICT DO NOTHING`, in.AssetIDs, id); err != nil {
			return ErrNotFound
		}
	}
	for _, id := range in.RemoveTagIDs {
		if _, err = tx.Exec(ctx, `DELETE FROM content_asset_tags WHERE asset_id=ANY($1) AND tag_id=$2`, in.AssetIDs, id); err != nil {
			return err
		}
	}
	for _, id := range in.AddCollectionIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO content_collection_assets(collection_id,asset_id) SELECT $2,unnest($1::uuid[]) ON CONFLICT DO NOTHING`, in.AssetIDs, id); err != nil {
			return ErrNotFound
		}
	}
	for _, id := range in.RemoveCollectionIDs {
		if _, err = tx.Exec(ctx, `DELETE FROM content_collection_assets WHERE asset_id=ANY($1) AND collection_id=$2`, in.AssetIDs, id); err != nil {
			return err
		}
	}
	// jsonb_build_object cannot infer an untyped bind parameter on PostgreSQL's
	// extended query path. Give the audit count an explicit type so organizing
	// content does not fail and roll the entire transaction back at the last step.
	_, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'content.bulk_organized','asset_batch',$3,jsonb_build_object('assetCount',$4::integer))`, uuid.New(), userID, uuid.New().String(), len(in.AssetIDs))
	if err != nil {
		return err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if len(in.AddTagIDs) > 0 || len(in.RemoveTagIDs) > 0 {
		if transactional, ok := s.invalidator.(TransactionalAssetInvalidator); ok {
			transactionalUsed = true
			changes, err = transactional.TagAssignmentsChangedInTx(ctx, tx, append(append([]uuid.UUID{}, in.AddTagIDs...), in.RemoveTagIDs...), "media.tags_updated")
			if err != nil {
				return err
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if transactionalUsed {
		s.invalidator.(TransactionalAssetInvalidator).NotifyManifestChanges(changes)
	} else if s.invalidator != nil && (len(in.AddTagIDs) > 0 || len(in.RemoveTagIDs) > 0) {
		if err := s.invalidator.TagAssignmentsChanged(ctx, append(append([]uuid.UUID{}, in.AddTagIDs...), in.RemoveTagIDs...), "media.tags_updated"); err != nil {
			return err
		}
	}
	return nil
}

func validateOrganizationIDs(ctx context.Context, tx pgx.Tx, table string, ids []uuid.UUID) error {
	unique := map[uuid.UUID]struct{}{}
	for _, id := range ids {
		unique[id] = struct{}{}
	}
	if len(unique) == 0 {
		return nil
	}
	values := make([]uuid.UUID, 0, len(unique))
	for id := range unique {
		values = append(values, id)
	}
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE id=ANY($1)", values).Scan(&count); err != nil {
		return err
	}
	if count != len(values) {
		return ErrNotFound
	}
	return nil
}

func (s *Service) loadOrganization(ctx context.Context, a *Asset) error {
	if err := s.db.QueryRow(ctx, `SELECT folder_id FROM assets WHERE id=$1`, a.ID).Scan(&a.FolderID); err != nil {
		return err
	}
	a.Tags = []ContentTag{}
	rows, err := s.db.Query(ctx, `SELECT t.id,t.name,t.color FROM content_tags t JOIN content_asset_tags at ON at.tag_id=t.id WHERE at.asset_id=$1 ORDER BY lower(t.name)`, a.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var t ContentTag
		if err := rows.Scan(&t.ID, &t.Name, &t.Color); err != nil {
			rows.Close()
			return err
		}
		a.Tags = append(a.Tags, t)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	a.CollectionIDs = []uuid.UUID{}
	rows, err = s.db.Query(ctx, `SELECT collection_id FROM content_collection_assets WHERE asset_id=$1 ORDER BY collection_id`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return err
		}
		a.CollectionIDs = append(a.CollectionIDs, id)
	}
	return rows.Err()
}
