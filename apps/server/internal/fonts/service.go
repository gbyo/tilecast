package fonts

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

const importConcurrency = 4

var errFamilyRace = errors.New("font family was created concurrently")

type Service struct {
	db      *pgxpool.Pool
	storage media.Storage
	catalog *Catalog
}

func NewService(db *pgxpool.Pool, storage media.Storage, catalog *Catalog) *Service {
	return &Service{db: db, storage: storage, catalog: catalog}
}

func (s *Service) Catalog() *Catalog { return s.catalog }

// FaceFileURL is the Studio address of one stored face file.
func FaceFileURL(familyID, faceID uuid.UUID) string {
	return "/api/v1/fonts/" + familyID.String() + "/faces/" + faceID.String() + "/file"
}

const familySelect = `SELECT f.id,f.family,f.source,f.source_id,f.source_version,f.category,f.license,f.subsets,f.created_at,f.updated_at FROM font_families f`

func (s *Service) List(ctx context.Context) ([]Family, error) {
	rows, err := s.db.Query(ctx, familySelect+` WHERE f.deleted_at IS NULL ORDER BY lower(f.family),f.id`)
	if err != nil {
		return nil, err
	}
	families := []Family{}
	index := map[uuid.UUID]int{}
	for rows.Next() {
		family, scanErr := scanFamily(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		index[family.ID] = len(families)
		families = append(families, family)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	faces, err := s.faces(ctx, nil)
	if err != nil {
		return nil, err
	}
	for familyID, list := range faces {
		if position, ok := index[familyID]; ok {
			families[position].Faces = list
			for _, face := range list {
				families[position].TotalBytes += face.FileSize
			}
		}
	}
	return families, nil
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Family, error) {
	family, err := scanFamily(s.db.QueryRow(ctx, familySelect+` WHERE f.id=$1 AND f.deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Family{}, ErrNotFound
	}
	if err != nil {
		return Family{}, err
	}
	faces, err := s.faces(ctx, &id)
	if err != nil {
		return Family{}, err
	}
	family.Faces = faces[id]
	for _, face := range family.Faces {
		family.TotalBytes += face.FileSize
	}
	return family, nil
}

type rowScanner interface{ Scan(...any) error }

func scanFamily(row rowScanner) (Family, error) {
	var family Family
	err := row.Scan(&family.ID, &family.Family, &family.Source, &family.SourceID, &family.SourceVersion, &family.Category, &family.License, &family.Subsets, &family.CreatedAt, &family.UpdatedAt)
	if family.Subsets == nil {
		family.Subsets = []string{}
	}
	family.Faces = []Face{}
	return family, err
}

func (s *Service) faces(ctx context.Context, familyID *uuid.UUID) (map[uuid.UUID][]Face, error) {
	query := `SELECT ff.family_id,ff.id,ff.asset_id,v.id,ff.style,ff.weight_min,ff.weight_max,ff.subset,ff.unicode_range,v.mime_type,v.file_size
		FROM font_faces ff
		JOIN assets a ON a.id=ff.asset_id AND a.deleted_at IS NULL
		JOIN asset_variants v ON v.asset_id=a.id AND v.kind='original' AND v.deleted_at IS NULL`
	args := []any{}
	if familyID != nil {
		query += ` WHERE ff.family_id=$1`
		args = append(args, *familyID)
	}
	query += ` ORDER BY ff.style,ff.weight_min,ff.subset,ff.id`
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[uuid.UUID][]Face{}
	for rows.Next() {
		var family uuid.UUID
		var face Face
		if err = rows.Scan(&family, &face.ID, &face.AssetID, &face.VariantID, &face.Style, &face.WeightMin, &face.WeightMax, &face.Subset, &face.UnicodeRange, &face.MIMEType, &face.FileSize); err != nil {
			return nil, err
		}
		face.FileURL = FaceFileURL(family, face.ID)
		result[family] = append(result[family], face)
	}
	return result, rows.Err()
}

// FaceDelivery resolves one stored face for Studio. Players read the same
// bytes through the device-authenticated asset route instead.
func (s *Service) FaceDelivery(ctx context.Context, familyID, faceID uuid.UUID) (media.Delivery, error) {
	var d media.Delivery
	var key string
	err := s.db.QueryRow(ctx, `SELECT a.id,v.id,v.storage_key,v.mime_type,v.file_size,encode(v.sha256,'hex')
		FROM font_faces ff
		JOIN font_families f ON f.id=ff.family_id AND f.deleted_at IS NULL
		JOIN assets a ON a.id=ff.asset_id AND a.deleted_at IS NULL AND a.type='font'
		JOIN asset_variants v ON v.asset_id=a.id AND v.kind='original' AND v.deleted_at IS NULL
		WHERE ff.id=$1 AND ff.family_id=$2`, faceID, familyID).Scan(&d.AssetID, &d.VariantID, &key, &d.MIMEType, &d.Size, &d.HashHex)
	if errors.Is(err, pgx.ErrNoRows) {
		return media.Delivery{}, ErrNotFound
	}
	if err != nil {
		return media.Delivery{}, err
	}
	if d.Path, err = s.storage.Path(key); err != nil {
		return media.Delivery{}, err
	}
	if info, statErr := os.Stat(d.Path); statErr != nil || info.Size() != d.Size {
		return media.Delivery{}, ErrNotFound
	}
	return d, nil
}

// storedFile is one font file written to storage before its rows commit.
type storedFile struct {
	assetID   uuid.UUID
	variantID uuid.UUID
	key       string
	sum       [32]byte
	size      int64
	mime      string
	filename  string
	style     string
	weightMin int
	weightMax int
	subset    string
	unicode   string
}

func (s *Service) store(assetID uuid.UUID, extension string, data []byte) (string, error) {
	key := media.OriginalKey(assetID, extension)
	if err := s.storage.WriteAtomic(key, func(w io.Writer) error {
		_, err := w.Write(data)
		return err
	}); err != nil {
		return "", err
	}
	return key, nil
}

func (s *Service) discard(files []storedFile) {
	for _, file := range files {
		_ = s.storage.Delete(file.key)
	}
}

// ImportGoogle copies the chosen files of one catalog family into storage.
// It is all or nothing: a failed download stores nothing.
func (s *Service) ImportGoogle(ctx context.Context, userID uuid.UUID, request GoogleImport) (Family, error) {
	if s.catalog == nil {
		return Family{}, ErrCatalogDisabled
	}
	request.SourceID = strings.TrimSpace(request.SourceID)
	if !sourceIDPattern.MatchString(request.SourceID) {
		return Family{}, fmt.Errorf("%w: choose a family from the catalog", ErrInvalid)
	}
	detail, err := s.catalog.Detail(ctx, request.SourceID)
	if err != nil {
		return Family{}, err
	}
	if err = s.ensureNameFree(ctx, detail.Family); err != nil {
		return Family{}, err
	}
	planned, subsets, err := planGoogleImport(detail, s.catalog.CDNBase, request)
	if err != nil {
		return Family{}, err
	}
	stored, err := s.download(ctx, planned)
	if err != nil {
		return Family{}, err
	}
	familyID := uuid.New()
	err = s.insert(ctx, userID, familyRow{
		id: familyID, family: detail.Family, source: SourceGoogle, sourceID: detail.ID, sourceVersion: detail.Version,
		category: detail.Category, license: detail.License, subsets: subsets,
	}, stored, "fonts.family_added")
	if err != nil {
		s.discard(stored)
		return Family{}, err
	}
	return s.Get(ctx, familyID)
}

func (s *Service) download(ctx context.Context, planned []plannedFile) ([]storedFile, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	stored := make([]storedFile, len(planned))
	var total int64
	var mu sync.Mutex
	// The first failure is the root cause: it cancels the siblings, whose own
	// errors are only the cancellation.
	var firstErr error
	fail := func(err error) {
		mu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		mu.Unlock()
		cancel()
	}
	limit := make(chan struct{}, importConcurrency)
	var wait sync.WaitGroup
	for index, file := range planned {
		wait.Add(1)
		go func(index int, file plannedFile) {
			defer wait.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			if ctx.Err() != nil {
				fail(ctx.Err())
				return
			}
			data, err := s.catalog.download(ctx, file.URL, MaxImportFileBytes)
			if err != nil {
				fail(err)
				return
			}
			mu.Lock()
			total += int64(len(data))
			over := total > MaxImportTotalBytes
			mu.Unlock()
			if over {
				fail(fmt.Errorf("%w: choose fewer subsets, styles, or weights", ErrTooLarge))
				return
			}
			assetID := uuid.New()
			key, err := s.store(assetID, ".woff2", data)
			if err != nil {
				fail(err)
				return
			}
			stored[index] = storedFile{
				assetID: assetID, variantID: uuid.New(), key: key, sum: sha256.Sum256(data), size: int64(len(data)),
				mime: "font/woff2", filename: filepath.Base(file.URL), style: file.Style,
				weightMin: file.WeightMin, weightMax: file.WeightMax, subset: file.Subset, unicode: file.UnicodeRange,
			}
		}(index, file)
	}
	wait.Wait()
	written := []storedFile{}
	for _, file := range stored {
		if file.key != "" {
			written = append(written, file)
		}
	}
	if firstErr != nil {
		s.discard(written)
		return nil, firstErr
	}
	return stored, nil
}

// Upload stores one TTF or OTF face. A face whose family name matches an
// uploaded family joins it, so Regular, Bold, and Italic arrive as
// separate files.
func (s *Service) Upload(ctx context.Context, userID uuid.UUID, filename string, data []byte, rightsConfirmed bool) (UploadResult, error) {
	if !rightsConfirmed {
		return UploadResult{}, ErrRightsRequired
	}
	if len(data) > MaxUploadBytes {
		return UploadResult{}, ErrTooLarge
	}
	face, err := parseUpload(data, filename)
	if err != nil {
		return UploadResult{}, err
	}
	sum := sha256.Sum256(data)
	assetID := uuid.New()
	key, err := s.store(assetID, face.Extension, data)
	if err != nil {
		return UploadResult{}, err
	}
	file := storedFile{
		assetID: assetID, variantID: uuid.New(), key: key, sum: sum, size: int64(len(data)), mime: face.MIMEType,
		filename: displayFilename(filename, face.Extension), style: face.Style, weightMin: face.WeightMin, weightMax: face.WeightMax,
	}
	familyID, err := s.attachUpload(ctx, userID, face.Family, file)
	if errors.Is(err, errFamilyRace) {
		// Another upload created the family first; join it.
		familyID, err = s.attachUpload(ctx, userID, face.Family, file)
	}
	if err != nil {
		s.discard([]storedFile{file})
		return UploadResult{}, err
	}
	family, err := s.Get(ctx, familyID)
	if err != nil {
		return UploadResult{}, err
	}
	return UploadResult{Family: family, EmbeddingRestricted: face.EmbeddingRestricted}, nil
}

func displayFilename(filename, extension string) string {
	name := cleanFamilyName(strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)))
	if name == "" {
		name = "font"
	}
	return name + extension
}

func (s *Service) attachUpload(ctx context.Context, userID uuid.UUID, familyName string, file storedFile) (uuid.UUID, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var familyID uuid.UUID
	var source string
	err = tx.QueryRow(ctx, `SELECT id,source FROM font_families WHERE lower(family)=lower($1) AND deleted_at IS NULL FOR UPDATE`, familyName).Scan(&familyID, &source)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		tx.Rollback(ctx) //nolint:errcheck
		familyID = uuid.New()
		err = s.insert(ctx, userID, familyRow{id: familyID, family: familyName, source: SourceUpload, rightsAttested: true}, []storedFile{file}, "fonts.family_added")
		if errors.Is(err, ErrExists) {
			return uuid.Nil, errFamilyRace
		}
		return familyID, err
	case err != nil:
		return uuid.Nil, err
	case source != SourceUpload:
		return uuid.Nil, ErrExists
	}
	var duplicate bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM font_faces ff JOIN assets a ON a.id=ff.asset_id AND a.deleted_at IS NULL WHERE ff.family_id=$1 AND a.sha256=$2)`, familyID, file.sum[:]).Scan(&duplicate); err != nil {
		return uuid.Nil, err
	}
	if duplicate {
		return uuid.Nil, fmt.Errorf("%w: this file is already in the family", ErrExists)
	}
	organizationID, err := organization(ctx, tx)
	if err != nil {
		return uuid.Nil, err
	}
	if err = insertFace(ctx, tx, organizationID, familyID, userID, familyName, file); err != nil {
		return uuid.Nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE font_families SET updated_at=now(),rights_attested_by=$2 WHERE id=$1`, familyID, userID); err != nil {
		return uuid.Nil, err
	}
	if err = record(ctx, tx, userID, "fonts.face_added", familyID, familyName); err != nil {
		return uuid.Nil, err
	}
	return familyID, tx.Commit(ctx)
}

type familyRow struct {
	id             uuid.UUID
	family         string
	source         string
	sourceID       string
	sourceVersion  string
	category       string
	license        string
	subsets        []string
	rightsAttested bool
}

func (s *Service) insert(ctx context.Context, userID uuid.UUID, row familyRow, files []storedFile, action string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	organizationID, err := organization(ctx, tx)
	if err != nil {
		return err
	}
	if row.subsets == nil {
		row.subsets = []string{}
	}
	var attested *uuid.UUID
	if row.rightsAttested {
		attested = &userID
	}
	if _, err = tx.Exec(ctx, `INSERT INTO font_families(id,organization_id,family,source,source_id,source_version,category,license,subsets,rights_attested_by,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		row.id, organizationID, row.family, row.source, row.sourceID, row.sourceVersion, row.category, row.license, row.subsets, attested, userID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ErrExists
		}
		return err
	}
	for _, file := range files {
		if err = insertFace(ctx, tx, organizationID, row.id, userID, row.family, file); err != nil {
			return err
		}
	}
	if err = record(ctx, tx, userID, action, row.id, row.family); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func insertFace(ctx context.Context, tx pgx.Tx, organizationID, familyID, userID uuid.UUID, familyName string, file storedFile) error {
	if _, err := tx.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,system_managed,created_by)
		VALUES($1,$2,$3,'font',$4,$5,$6,$7,'ready',TRUE,$8)`,
		file.assetID, organizationID, familyName, file.filename, file.mime, file.sum[:], file.size, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,player_compatible)
		VALUES($1,$2,'original','local',$3,$4,$5,$6,TRUE)`,
		file.variantID, file.assetID, file.key, file.mime, file.size, file.sum[:]); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO font_faces(id,family_id,asset_id,style,weight_min,weight_max,subset,unicode_range) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		uuid.New(), familyID, file.assetID, file.style, file.weightMin, file.weightMax, file.subset, file.unicode)
	return err
}

func (s *Service) ensureNameFree(ctx context.Context, family string) error {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM font_families WHERE lower(family)=lower($1) AND deleted_at IS NULL)`, family).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrExists
	}
	return nil
}

// Delete removes a family that no current Layout draft or published
// revision uses. Its files are removed by the media worker's ordinary file
// deletion job.
func (s *Service) Delete(ctx context.Context, userID, id uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var family string
	// The row lock serializes with Layout saves, which read the family FOR
	// SHARE before recording a dependency on it.
	if err = tx.QueryRow(ctx, `SELECT family FROM font_families WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&family); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT l.id,l.name FROM layouts l
		WHERE l.deleted_at IS NULL AND (
			EXISTS(SELECT 1 FROM layout_draft_dependencies d WHERE d.layout_id=l.id AND d.dependency_type='font' AND d.dependency_id=$1)
			OR EXISTS(SELECT 1 FROM layout_revision_dependencies r WHERE r.revision_id=l.published_revision_id AND r.dependency_type='font' AND r.dependency_id=$1))
		ORDER BY lower(l.name),l.id LIMIT 20`, id)
	if err != nil {
		return err
	}
	inUse := &InUse{}
	for rows.Next() {
		var ref LayoutRef
		if err = rows.Scan(&ref.ID, &ref.Name); err != nil {
			rows.Close()
			return err
		}
		inUse.Layouts = append(inUse.Layouts, ref)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	// Plugin instances record their use through Host.Fonts.
	refs, err := tx.Query(ctx, `SELECT label FROM font_references WHERE font_id=$1 ORDER BY lower(label),owner_id LIMIT 20`, id)
	if err != nil {
		return err
	}
	for refs.Next() {
		var label string
		if err = refs.Scan(&label); err != nil {
			refs.Close()
			return err
		}
		inUse.Plugins = append(inUse.Plugins, label)
	}
	refs.Close()
	if err = refs.Err(); err != nil {
		return err
	}
	if len(inUse.Layouts) > 0 || len(inUse.Plugins) > 0 {
		return inUse
	}
	if _, err = tx.Exec(ctx, `UPDATE font_families SET deleted_at=now(),updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE assets SET processing_status='deleting',deleted_at=COALESCE(deleted_at,now()),updated_at=now()
		WHERE id IN (SELECT asset_id FROM font_faces WHERE family_id=$1) AND processing_status NOT IN ('deleting','deleted')`, id); err != nil {
		return err
	}
	assetIDs := []uuid.UUID{}
	assetRows, err := tx.Query(ctx, `SELECT asset_id FROM font_faces WHERE family_id=$1`, id)
	if err != nil {
		return err
	}
	for assetRows.Next() {
		var assetID uuid.UUID
		if err = assetRows.Scan(&assetID); err != nil {
			assetRows.Close()
			return err
		}
		assetIDs = append(assetIDs, assetID)
	}
	assetRows.Close()
	if err = assetRows.Err(); err != nil {
		return err
	}
	for _, assetID := range assetIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO media_jobs(id,asset_id,kind,status) VALUES($1,$2,'delete_asset_files','queued') ON CONFLICT DO NOTHING`, uuid.New(), assetID); err != nil {
			return err
		}
	}
	if err = record(ctx, tx, userID, "fonts.family_deleted", id, family); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func organization(ctx context.Context, tx pgx.Tx) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&id)
	return id, err
}

func record(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action string, familyID uuid.UUID, family string) error {
	return audit.RecordTx(ctx, tx, audit.Event{
		Action:       action,
		ResourceType: "font_family",
		ResourceID:   familyID.String(),
		ResourceName: family,
		Actor:        &userID,
	})
}
