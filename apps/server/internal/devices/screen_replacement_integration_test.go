package devices

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestScreenReplacementPreservesLogicalScreenAndRetiresHardware(t *testing.T) {
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
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}

	authService := auth.NewService(pool, time.Hour)
	owner, err := authService.Setup(ctx, auth.SetupInput{OrganizationName: "Replacement Library", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	presence := NewPresenceHub()
	service := NewService(pool, presence, "https://signage.example.org")
	identity, err := service.Identity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	oldMetadata := DeviceMetadata{
		PlayerInstallationID: uuid.NewString(), Platform: "linux", Manufacturer: "Intel", Model: "NUC6CAYH",
		AndroidVersion: "none", PlayerVersion: "0.9.0", ScreenWidth: 1920, ScreenHeight: 1080, Density: 1,
		Locale: "en-US", Timezone: "America/New_York",
	}
	oldPairing, err := service.CreatePairing(ctx, identity.InstallationID, oldMetadata)
	if err != nil {
		t.Fatal(err)
	}
	screen, err := service.ApprovePairing(ctx, oldPairing.ID, owner.User.ID, "Cafeteria", nil, "Cafeteria", "1", "", false)
	if err != nil {
		t.Fatal(err)
	}
	oldClaim, err := service.PollPairing(ctx, oldPairing.ID, oldPairing.PollSecret)
	if err != nil {
		t.Fatal(err)
	}
	oldEnrollment, err := service.Enroll(ctx, oldPairing.ID, oldClaim.EnrollmentToken)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,display_control_provider,display_control_providers,display_control_capabilities,display_power_state,display_control_policy_state)VALUES($1,'hdmi_cec',ARRAY['hdmi_cec'],'{"power":"hdmi_cec","mute":"hdmi_cec"}'::jsonb,'on','normal')`, screen.ID); err != nil {
		t.Fatal(err)
	}

	groupID, playlistID, scheduleID := uuid.New(), uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) SELECT $1,id,'Cafeteria wall',$2 FROM organization_settings WHERE singleton`, groupID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, groupID, screen.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE screen_groups SET display_mode='span',span_canvas_width=3840,span_canvas_height=1080 WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_group_panels(screen_group_id,screen_id,panel_order,x,y,width,height,rotation)VALUES($1,$2,0,1920,0,1920,1080,90)`, groupID, screen.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by) SELECT $1,id,'Cafeteria loop',$2 FROM organization_settings WHERE singleton`, playlistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_group_playlist_assignments(screen_group_id,playlist_id,assigned_by) VALUES($1,$2,$3)`, groupID, playlistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,daily_start,daily_end,days_of_week,created_by) SELECT $1,id,'Cafeteria hours',$2,'weekly','America/New_York','08:00','17:00',ARRAY[1,2,3,4,5]::smallint[],$3 FROM organization_settings WHERE singleton`, scheduleID, playlistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_group_id) VALUES($1,'group',$2)`, scheduleID, groupID); err != nil {
		t.Fatal(err)
	}

	newMetadata := oldMetadata
	newMetadata.PlayerInstallationID = uuid.NewString()
	newMetadata.Model = "NUC13ANHi5"
	newMetadata.PlayerVersion = "0.10.0"
	newPairing, err := service.CreatePairing(ctx, identity.InstallationID, newMetadata)
	if err != nil {
		t.Fatal(err)
	}
	approved, err := service.ApprovePairingWithOptions(ctx, newPairing.ID, owner.User.ID, PairingApproval{
		ReplaceHardware:     true,
		ReplacementScreenID: &screen.ID,
		Authorize:           SystemApproval,
	})
	if err != nil || approved.ID != screen.ID {
		t.Fatalf("replacement approval=%#v err=%v", approved, err)
	}
	if _, err := service.AuthenticateDevice(ctx, oldEnrollment.DeviceCredential); err != nil {
		t.Fatalf("old credential was retired before successful enrollment: %v", err)
	}
	newClaim, err := service.PollPairing(ctx, newPairing.ID, newPairing.PollSecret)
	if err != nil {
		t.Fatal(err)
	}
	newEnrollment, err := service.Enroll(ctx, newPairing.ID, newClaim.EnrollmentToken)
	if err != nil || newEnrollment.ScreenID != screen.ID {
		t.Fatalf("replacement enrollment=%#v err=%v", newEnrollment, err)
	}
	if _, err := service.AuthenticateDevice(ctx, oldEnrollment.DeviceCredential); !errors.Is(err, ErrRevokedCredential) {
		t.Fatalf("old credential was not retired after replacement: %v", err)
	}
	if _, err := service.AuthenticateDevice(ctx, newEnrollment.DeviceCredential); err != nil {
		t.Fatalf("new credential is invalid: %v", err)
	}

	var installation, model, playerVersion string
	if err := pool.QueryRow(ctx, `SELECT player_installation_id,device_model,player_version FROM screens WHERE id=$1`, screen.ID).Scan(&installation, &model, &playerVersion); err != nil {
		t.Fatal(err)
	}
	if installation != newMetadata.PlayerInstallationID || model != newMetadata.Model || playerVersion != newMetadata.PlayerVersion {
		t.Fatalf("replacement hardware was not applied: installation=%q model=%q version=%q", installation, model, playerVersion)
	}
	var provider, policy string
	var capabilities []byte
	if err := pool.QueryRow(ctx, `SELECT COALESCE(display_control_provider,''),display_control_policy_state,display_control_capabilities FROM screen_player_status WHERE screen_id=$1`, screen.ID).Scan(&provider, &policy, &capabilities); err != nil {
		t.Fatal(err)
	}
	if provider != "" || policy != "unknown" || string(capabilities) != `{}` {
		t.Fatalf("replacement retained stale display capability claims: provider=%q policy=%q capabilities=%s", provider, policy, capabilities)
	}
	var membership, assignment, target int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM screen_group_memberships WHERE screen_group_id=$1 AND screen_id=$2`, groupID, screen.ID).Scan(&membership); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM screen_group_playlist_assignments WHERE screen_group_id=$1 AND playlist_id=$2`, groupID, playlistID).Scan(&assignment); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schedule_targets WHERE schedule_id=$1 AND screen_group_id=$2`, scheduleID, groupID).Scan(&target); err != nil {
		t.Fatal(err)
	}
	if membership != 1 || assignment != 1 || target != 1 {
		t.Fatalf("logical relationships changed: membership=%d assignment=%d target=%d", membership, assignment, target)
	}
	var panelX, panelWidth, panelRotation int
	if err := pool.QueryRow(ctx, `SELECT x,width,rotation FROM screen_group_panels WHERE screen_group_id=$1 AND screen_id=$2`, groupID, screen.ID).Scan(&panelX, &panelWidth, &panelRotation); err != nil {
		t.Fatal(err)
	}
	if panelX != 1920 || panelWidth != 1920 || panelRotation != 90 {
		t.Fatalf("Span panel geometry changed during replacement: x=%d width=%d rotation=%d", panelX, panelWidth, panelRotation)
	}
	history, err := service.ListPlayerHistory(ctx, screen.ID)
	if err != nil || len(history) != 2 {
		t.Fatalf("hardware history=%#v err=%v", history, err)
	}
	if history[0].RetiredAt != nil || history[0].InstallationID != newMetadata.PlayerInstallationID || history[1].RetiredAt == nil {
		t.Fatalf("hardware history current/retired state is wrong: %#v", history)
	}
}
