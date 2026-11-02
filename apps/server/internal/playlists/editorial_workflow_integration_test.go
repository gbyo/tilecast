package playlists

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

type editorialTestSettings struct{ values map[string]any }

func (s editorialTestSettings) Organization(context.Context) (settings.Document, error) {
	return settings.Document{Values: s.values}, nil
}

// TestPlaylistSubmissionStaysFrozenWhileTheDraftMoves exercises the part of
// the workflow that cannot be proved by a unit test: the submitted snapshot is
// read from PostgreSQL and published independently of a newer draft revision.
func TestPlaylistSubmissionStaysFrozenWhileTheDraftMoves(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE playlist_revisions,playlist_items,playlists,asset_variants,assets,screen_player_status,screen_manifest_state,screen_playlist_assignments,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Editorial Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var organizationID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	screenID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Lobby','android-tv','Google','Test','14','1.0',1920,1080,1,'en-US','UTC')`, screenID, organizationID, uuid.New()); err != nil {
		t.Fatal(err)
	}
	assetIDs := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	for index, assetID := range assetIDs {
		if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by) VALUES($1,$2,$3,'image',$4,'image/png',$5,100,1920,1080,'ready',$6)`, assetID, organizationID, "Slide", "slide.png", make([]byte, 32), owner.User.ID); err != nil {
			t.Fatalf("asset %d: %v", index, err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible) VALUES($1,$2,'playback','local',$3,'image/png',100,$4,1920,1080,TRUE)`, uuid.New(), assetID, "variants/"+assetID.String(), make([]byte, 32)); err != nil {
			t.Fatalf("asset variant %d: %v", index, err)
		}
	}

	service := NewService(pool, &testNotifier{})
	playlist, err := service.Create(ctx, owner.User.ID, "Announcements", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(5000)
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: assetIDs[0], DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
	if _, err = service.Assign(ctx, screenID, playlist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	before, _, err := service.BuildManifest(ctx, screenID)
	if err != nil {
		t.Fatal(err)
	}

	workflow := approvals.NewService(pool, editorialTestSettings{values: map[string]any{
		"content.review_policy": "everyone",
	}})
	workflow.SetProvider(approvals.TypePlaylist, service)
	draft, err := service.GetDraft(ctx, playlist.ID)
	if err != nil {
		t.Fatal(err)
	}
	ownerAuthority, _ := auth.BuiltinCapabilities(auth.RoleOwner)
	submission, err := workflow.SubmitExpected(ctx, owner.User.ID, ownerAuthority, approvals.TypePlaylist, playlist.ID, nil, draft.DraftRevision)
	if err != nil {
		t.Fatal(err)
	}
	afterSubmit, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || afterSubmit.ManifestVersion != before.ManifestVersion {
		t.Fatalf("submission changed manifest: before=%d after=%d err=%v", before.ManifestVersion, afterSubmit.ManifestVersion, err)
	}
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: assetIDs[1], DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	if _, err = workflow.Approve(ctx, owner.User.ID, ownerAuthority, submission.ID, "looks good"); err != nil {
		t.Fatal(err)
	}
	afterApprove, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || afterApprove.ManifestVersion != before.ManifestVersion {
		t.Fatalf("approval changed manifest: before=%d after=%d err=%v", before.ManifestVersion, afterApprove.ManifestVersion, err)
	}
	if _, err = workflow.PublishSubmission(ctx, owner.User.ID, ownerAuthority, submission.ID); err != nil {
		t.Fatal(err)
	}
	afterPublish, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || afterPublish.ManifestVersion <= before.ManifestVersion {
		t.Fatalf("publication did not invalidate manifest: before=%d after=%d err=%v", before.ManifestVersion, afterPublish.ManifestVersion, err)
	}
	runtime, err := service.Get(ctx, playlist.ID)
	if err != nil {
		t.Fatal(err)
	}
	working, err := service.GetDraft(ctx, playlist.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtime.Items) != 1 {
		t.Fatalf("runtime playlist contains newer draft items: %d", len(runtime.Items))
	}
	if len(working.Items) != 2 || !working.HasUnpublishedChanges {
		t.Fatalf("working draft was not preserved: %#v", working)
	}
}
