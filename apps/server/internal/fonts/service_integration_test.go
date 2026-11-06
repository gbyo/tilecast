package fonts

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
)

type fontFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	user    uuid.UUID
	storage *media.LocalStorage
	service *Service
}

func setupFontFixture(t *testing.T) fontFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	// Requests reach the service through Studio, which names the audit surface.
	ctx := audit.WithSurface(context.Background(), audit.SurfaceStudio)
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE font_families, layouts, media_jobs, assets, sessions, audit_logs, users, organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Font Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	storage, err := media.NewLocalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return fontFixture{ctx: ctx, pool: pool, user: owner.User.ID, storage: storage}
}

func TestUploadImportListDeliverAndDelete(t *testing.T) {
	f := setupFontFixture(t)
	catalog, _ := catalogServer(t, nil)
	f.service = NewService(f.pool, f.storage, catalog)

	if _, err := f.service.Upload(f.ctx, f.user, "go.ttf", goregular.TTF, false); !errors.Is(err, ErrRightsRequired) {
		t.Fatalf("upload without the rights confirmation: %v", err)
	}
	uploaded, err := f.service.Upload(f.ctx, f.user, "Go-Regular.ttf", goregular.TTF, true)
	if err != nil {
		t.Fatal(err)
	}
	if uploaded.Family.Family != "Go" || uploaded.Family.Source != SourceUpload || len(uploaded.Family.Faces) != 1 {
		t.Fatalf("unexpected uploaded family %+v", uploaded.Family)
	}
	// A second face of the same family joins it; the same file twice does not.
	joined, err := f.service.Upload(f.ctx, f.user, "Go-Bold.ttf", gobold.TTF, true)
	if err != nil {
		t.Fatal(err)
	}
	if joined.Family.ID != uploaded.Family.ID || len(joined.Family.Faces) != 2 {
		t.Fatalf("bold face did not join the family: %+v", joined.Family)
	}
	if _, err = f.service.Upload(f.ctx, f.user, "again.ttf", gobold.TTF, true); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate face: %v", err)
	}

	imported, err := f.service.ImportGoogle(f.ctx, f.user, GoogleImport{SourceID: "inter", Subsets: []string{"latin", "cyrillic"}})
	if err != nil {
		t.Fatal(err)
	}
	if imported.Family != "Inter" || imported.License != "OFL-1.1" || imported.SourceVersion != "5.3.0" || len(imported.Faces) != 2 {
		t.Fatalf("unexpected import %+v", imported)
	}
	if imported.Faces[0].WeightMin != 100 || imported.Faces[0].WeightMax != 900 || imported.Faces[0].MIMEType != "font/woff2" {
		t.Fatalf("unexpected imported face %+v", imported.Faces[0])
	}
	if _, err = f.service.ImportGoogle(f.ctx, f.user, GoogleImport{SourceID: "inter"}); !errors.Is(err, ErrExists) {
		t.Fatalf("second import of the same family: %v", err)
	}

	families, err := f.service.List(f.ctx)
	if err != nil || len(families) != 2 || families[0].Family != "Go" || families[1].Family != "Inter" {
		t.Fatalf("unexpected list %+v %v", families, err)
	}
	face := imported.Faces[0]
	delivery, err := f.service.FaceDelivery(f.ctx, imported.ID, face.ID)
	if err != nil || delivery.MIMEType != "font/woff2" || delivery.Size != face.FileSize {
		t.Fatalf("face delivery %+v %v", delivery, err)
	}
	if _, err = f.service.FaceDelivery(f.ctx, uploaded.Family.ID, face.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a face must be read through its own family: %v", err)
	}

	// Font files never surface through the generic Media API.
	mediaService := media.NewService(f.pool, f.storage, media.Config{})
	if _, err = mediaService.GetAsset(f.ctx, face.AssetID); !errors.Is(err, media.ErrNotFound) {
		t.Fatalf("Media API returned a font asset: %v", err)
	}
	if err = mediaService.DeleteAsset(f.ctx, face.AssetID, f.user); !errors.Is(err, media.ErrNotFound) {
		t.Fatalf("Media API deleted a font asset: %v", err)
	}

	layoutService := layouts.NewService(f.pool)
	layout, err := layoutService.Create(f.ctx, f.user, "Lobby welcome", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	document := layouts.Document{
		SchemaVersion: 2,
		Canvas:        layouts.Canvas{Width: 1920, Height: 1080, Orientation: "landscape", BackgroundColor: "#0E141B"},
		Placements: []layouts.Placement{{
			ID: uuid.New(), Type: "primitive", Name: "Welcome", Width: 800, Height: 200, Opacity: 1, Visible: true,
			Primitive: &layouts.Primitive{Kind: "text", Text: "Welcome", FontID: &imported.ID},
		}},
	}
	layout, err = layoutService.SaveDraft(f.ctx, layout.ID, f.user, layout.DraftRevision, document)
	if err != nil {
		t.Fatal(err)
	}
	var inUse *InUse
	if err = f.service.Delete(f.ctx, f.user, imported.ID); !errors.As(err, &inUse) || len(inUse.Layouts) != 1 || inUse.Layouts[0].Name != "Lobby welcome" {
		t.Fatalf("deleting a family a Layout uses: %v", err)
	}
	document.Placements[0].Primitive.FontID = nil
	if _, err = layoutService.SaveDraft(f.ctx, layout.ID, f.user, layout.DraftRevision, document); err != nil {
		t.Fatal(err)
	}
	if err = f.service.Delete(f.ctx, f.user, imported.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Get(f.ctx, imported.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted family is still readable: %v", err)
	}
	var queued int
	if err = f.pool.QueryRow(f.ctx, `SELECT count(*) FROM media_jobs j JOIN font_faces ff ON ff.asset_id=j.asset_id WHERE ff.family_id=$1 AND j.kind='delete_asset_files'`, imported.ID).Scan(&queued); err != nil || queued != 2 {
		t.Fatalf("file deletion jobs: %d %v", queued, err)
	}
	// The name is free again once the family is removed.
	if _, err = f.service.ImportGoogle(f.ctx, f.user, GoogleImport{SourceID: "inter"}); err != nil {
		t.Fatalf("re-adding a removed family: %v", err)
	}
}

func TestUploadCannotJoinACatalogFamily(t *testing.T) {
	f := setupFontFixture(t)
	catalog, _ := catalogServer(t, nil)
	f.service = NewService(f.pool, f.storage, catalog)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO font_families(id,organization_id,family,source) SELECT $1,id,'Go','google' FROM organization_settings`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Upload(f.ctx, f.user, "go.ttf", goregular.TTF, true); !errors.Is(err, ErrExists) {
		t.Fatalf("upload into a catalog family: %v", err)
	}
	entries, err := os.ReadDir(f.storageRoot(t))
	if err == nil && len(entries) > 0 {
		var files int
		for _, entry := range entries {
			if entry.IsDir() {
				nested, _ := os.ReadDir(f.storageRoot(t) + "/" + entry.Name())
				files += len(nested)
			}
		}
		if files > 0 {
			t.Fatalf("a refused upload left %d stored files", files)
		}
	}
}

func (f fontFixture) storageRoot(t *testing.T) string {
	t.Helper()
	path, err := f.storage.Path("originals")
	if err != nil {
		t.Fatal(err)
	}
	return path
}
