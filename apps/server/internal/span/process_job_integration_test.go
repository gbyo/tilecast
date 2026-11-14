package span

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// The worker reads the wall geometry from screen_group_panels and hashes it
// the way PrepareVideo did, so every panel of a wall is prepared, not only the
// panel with order 0. A panel whose geometry changed after it was queued
// fails instead of producing a stale crop.
func TestProcessJobPreparesEveryWallPanel(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ffmpeg, ffmpegErr := exec.LookPath("ffmpeg")
	ffprobe, ffprobeErr := exec.LookPath("ffprobe")
	if ffmpegErr != nil || ffprobeErr != nil {
		t.Skip("ffmpeg and ffprobe are required to prepare wall panels")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Span", OwnerName: "Owner", Username: "wall-owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	execSQL := func(sql string, args ...any) {
		t.Helper()
		if _, execErr := pool.Exec(ctx, sql, args...); execErr != nil {
			t.Fatal(execErr)
		}
	}

	storage, err := media.NewLocalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sourceKey := "playback/wall.mp4"
	sourcePath, err := storage.Path(sourceKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(sourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if output, encodeErr := exec.CommandContext(ctx, ffmpeg, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=3840x720:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", sourcePath).CombinedOutput(); encodeErr != nil {
		t.Fatalf("encode source: %v: %s", encodeErr, output)
	}

	group, asset, variant := uuid.New(), uuid.New(), uuid.New()
	execSQL(`INSERT INTO screen_groups(id,organization_id,name,created_by,display_mode,span_canvas_width,span_canvas_height)VALUES($1,$2,'Wall',$3,'span',3840,720)`, group, org, owner.User.ID)
	execSQL(`INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,'Wall clip','video','wall.mp4','video/mp4',$3,100,'ready',$4)`, asset, org, make([]byte, 32), owner.User.ID)
	execSQL(`INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,player_compatible)VALUES($1,$2,'playback','local',$3,'video/mp4',100,$4,TRUE)`, variant, asset, sourceKey, make([]byte, 32))
	screens := make([]uuid.UUID, 3)
	for order := range screens {
		screens[order] = uuid.New()
		execSQL(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Wall panel','android','Generic','TV','14','1.0',1280,720,1,'en-US','UTC')`, screens[order], org, uuid.NewString())
		execSQL(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, group, screens[order], owner.User.ID)
		execSQL(`INSERT INTO screen_group_panels(screen_group_id,screen_id,panel_order,x,y,width,height)VALUES($1,$2,$3,$4,0,1280,720)`, group, screens[order], order, order*1280)
	}
	service := NewService(pool, storage, Config{FFmpegPath: ffmpeg, FFprobePath: ffprobe}, nil)
	process := func(panelID uuid.UUID) error {
		t.Helper()
		payload, marshalErr := json.Marshal(map[string]string{"panelId": panelID.String()})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		return service.ProcessJob(ctx, "generate_span_video_panel", nil, payload)
	}

	panelIDs := make([]uuid.UUID, len(screens))
	for order, screen := range screens {
		queued, prepareErr := service.PrepareVideo(ctx, screen, asset, variant)
		if prepareErr != nil || queued.Status != "queued" {
			t.Fatalf("panel %d prepare: panel=%#v err=%v", order, queued, prepareErr)
		}
		panelIDs[order] = queued.ID
		if processErr := process(queued.ID); processErr != nil {
			t.Fatalf("panel %d process: %v", order, processErr)
		}
		ready, prepareErr := service.PrepareVideo(ctx, screen, asset, variant)
		if prepareErr != nil || ready.Status != "ready" || ready.Width != 1280 || ready.Height != 720 || ready.SHA256 == "" {
			t.Fatalf("panel %d after process: panel=%#v err=%v", order, ready, prepareErr)
		}
	}

	// The wall is resized after a panel was queued: the job refuses the stale
	// geometry and records the failure instead of encoding the old crop.
	execSQL(`UPDATE screen_group_panels SET width=1000 WHERE screen_group_id=$1 AND screen_id=$2`, group, screens[1])
	if err = process(panelIDs[1]); err == nil {
		t.Fatal("ProcessJob accepted geometry that changed while the panel was queued")
	}
	var status, code string
	if err = pool.QueryRow(ctx, `SELECT status,error_code FROM span_video_panels WHERE id=$1`, panelIDs[1]).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "span_panel_failed" {
		t.Fatalf("stale panel status=%q code=%q", status, code)
	}
}
