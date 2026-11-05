package span

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// A wall panel that is not ready always has a job that can make it ready:
// concurrent manifest builds share one row, a row left without a job is
// queued again, and a failed panel is retried after its cooldown.
func TestPrepareVideoIsIdempotentAndRecoversStrandedPanels(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Span", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, execErr := pool.Exec(ctx, sql, args...); execErr != nil {
			t.Fatal(execErr)
		}
	}
	screen, group, asset, variant := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Wall left','linux','Generic','PC','','1.0',1920,1080,1,'en-US','UTC')`, screen, org, uuid.NewString())
	exec(`INSERT INTO screen_groups(id,organization_id,name,created_by,display_mode)VALUES($1,$2,'Wall',$3,'span')`, group, org, owner.User.ID)
	exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, group, screen, owner.User.ID)
	exec(`INSERT INTO screen_group_panels(screen_group_id,screen_id,panel_order,x,y,width,height)VALUES($1,$2,0,0,0,960,1080)`, group, screen)
	exec(`INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,'Clip','video','clip.mp4','video/mp4',$3,100,'ready',$4)`, asset, org, make([]byte, 32), owner.User.ID)
	exec(`INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,player_compatible)VALUES($1,$2,'playback','local','playback/clip','video/mp4',100,$3,TRUE)`, variant, asset, make([]byte, 32))
	service := NewService(pool, nil, Config{}, nil)

	var wg sync.WaitGroup
	errs := make([]error, 8)
	panels := make([]VideoPanel, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			panels[i], errs[i] = service.PrepareVideo(ctx, screen, asset, variant)
		}(i)
	}
	wg.Wait()
	for i, prepareErr := range errs {
		if prepareErr != nil || panels[i].ID != panels[0].ID || panels[i].Status != "queued" {
			t.Fatalf("concurrent prepare %d: panel=%#v err=%v", i, panels[i], prepareErr)
		}
	}
	jobs := func() int {
		t.Helper()
		var count int
		if countErr := pool.QueryRow(ctx, `SELECT count(*) FROM media_jobs WHERE kind='generate_span_video_panel' AND status IN('queued','running') AND payload->>'panelId'=$1`, panels[0].ID.String()).Scan(&count); countErr != nil {
			t.Fatal(countErr)
		}
		return count
	}
	if count := jobs(); count != 1 {
		t.Fatalf("active jobs=%d, want 1", count)
	}

	// The job is lost (exhausted or never written): the panel is queued again.
	exec(`UPDATE media_jobs SET status='failed' WHERE kind='generate_span_video_panel'`)
	if _, err = service.PrepareVideo(ctx, screen, asset, variant); err != nil {
		t.Fatal(err)
	}
	if count := jobs(); count != 1 {
		t.Fatalf("stranded queued panel has %d active jobs, want 1", count)
	}

	// A recent failure is reported as failed and is not retried at once.
	exec(`UPDATE media_jobs SET status='failed' WHERE kind='generate_span_video_panel'`)
	exec(`UPDATE span_video_panels SET status='failed',updated_at=now() WHERE id=$1`, panels[0].ID)
	failed, err := service.PrepareVideo(ctx, screen, asset, variant)
	if err != nil || failed.Status != "failed" || jobs() != 0 {
		t.Fatalf("recent failure: panel=%#v err=%v jobs=%d", failed, err, jobs())
	}
	// After the cooldown it is retried.
	exec(`UPDATE span_video_panels SET updated_at=now()-interval '1 hour' WHERE id=$1`, panels[0].ID)
	retried, err := service.PrepareVideo(ctx, screen, asset, variant)
	if err != nil || retried.Status != "queued" || jobs() != 1 {
		t.Fatalf("failure after cooldown: panel=%#v err=%v jobs=%d", retried, err, jobs())
	}
}
