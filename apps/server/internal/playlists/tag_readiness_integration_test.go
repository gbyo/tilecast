package playlists

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTagPlaylistAssignmentUsesPublishedMatches(t *testing.T) {
	for _, match := range []string{"any", "all"} {
		t.Run(match, func(t *testing.T) {
			f := setupCapabilityFixture(t)
			first, _ := insertReadinessImage(t, f)
			second, _ := insertReadinessImage(t, f)
			tagIDs := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
			for index, tagID := range tagIDs {
				if _, err := f.pool.Exec(f.ctx, `INSERT INTO content_tags(id,organization_id,name,color,created_by) VALUES($1,$2,$3,'#2563eb',$4)`, tagID, f.org, tagID.String(), f.user); err != nil {
					t.Fatal(err)
				}
				if index < 2 {
					if _, err := f.pool.Exec(f.ctx, `INSERT INTO content_asset_tags(asset_id,tag_id) VALUES($1,$2)`, first, tagID); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := f.pool.Exec(f.ctx, `INSERT INTO content_asset_tags(asset_id,tag_id) VALUES($1,$2)`, second, tagIDs[0]); err != nil {
				t.Fatal(err)
			}
			playlist, err := f.service.Create(f.ctx, f.user, "Tag playlist", "", "tag")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.service.SetTagRule(f.ctx, playlist.ID, f.user, TagRuleInput{Enabled: true, Match: match, ImageDurationMS: 15000, TagIDs: tagIDs[:2]}); err != nil {
				t.Fatal(err)
			}
			publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
			// An unpublished rule must not change assignment or playback.
			if _, err = f.service.SetTagRule(f.ctx, playlist.ID, f.user, TagRuleInput{Enabled: true, Match: match, ImageDurationMS: 15000, TagIDs: tagIDs[2:]}); err != nil {
				t.Fatal(err)
			}
			if err = f.service.ValidatePresentationNow(f.ctx, "playlist", playlist.ID, time.Now()); err != nil {
				t.Fatalf("matching tag playlist rejected: %v", err)
			}
			tx, err := f.pool.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			state := readinessState{tx: tx, at: time.Now().UTC()}
			available := state.presentationAvailable(f.ctx, "playlist", playlist.ID, map[string]bool{})
			tx.Rollback(f.ctx)
			if !available {
				t.Fatal("matching tag playlist has no available path")
			}
			if _, err = f.service.Assign(f.ctx, f.screen, playlist.ID, f.user); err != nil {
				t.Fatalf("tag playlist assignment rejected: %v", err)
			}
			manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
			if err != nil {
				t.Fatal(err)
			}
			wantCount := 2
			if match == "all" {
				wantCount = 1
			}
			if manifest.DirectFallbackPlaylist == nil || len(manifest.DirectFallbackPlaylist.Items) != wantCount {
				t.Fatalf("tag playlist manifest = %#v, want %d items", manifest.DirectFallbackPlaylist, wantCount)
			}
			for _, item := range manifest.DirectFallbackPlaylist.Items {
				if item.AssetID != first && (match != "any" || item.AssetID != second) {
					t.Fatalf("unexpected matched asset: %s", item.AssetID)
				}
			}
		})
	}
}

func TestTagPlaylistReadinessIgnoresRetainedManualItems(t *testing.T) {
	f := setupCapabilityFixture(t)
	assetID, _ := insertReadinessImage(t, f)
	tagID := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO content_tags(id,organization_id,name,color,created_by) VALUES($1,$2,'Matching media','#2563eb',$3)`, tagID, f.org, f.user); err != nil {
		t.Fatal(err)
	}
	playlist, err := f.service.Create(f.ctx, f.user, "Retained manual items", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(10000)
	if _, err = f.service.AddItem(f.ctx, playlist.ID, f.user, ItemInput{AssetID: assetID, DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.SetTagRule(f.ctx, playlist.ID, f.user, TagRuleInput{Enabled: true, Match: "any", ImageDurationMS: duration, TagIDs: []uuid.UUID{tagID}}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
	if _, err = f.service.Assign(f.ctx, f.screen, playlist.ID, f.user); !errors.Is(err, ErrPresentationNotReady) {
		t.Fatalf("empty tag playlist with a retained manual item was accepted: %v", err)
	}
	if _, err = f.pool.Exec(f.ctx, `INSERT INTO content_asset_tags(asset_id,tag_id) VALUES($1,$2)`, assetID, tagID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Assign(f.ctx, f.screen, playlist.ID, f.user); err != nil {
		t.Fatalf("matching tag playlist rejected: %v", err)
	}
	for _, test := range []struct {
		name    string
		change  string
		restore string
	}{
		{"expired", `UPDATE assets SET expires_at=now()-interval '1 hour' WHERE id=$1`, `UPDATE assets SET expires_at=NULL WHERE id=$1`},
		{"archived", `UPDATE assets SET archived_at=now() WHERE id=$1`, `UPDATE assets SET archived_at=NULL WHERE id=$1`},
		{"deleted", `UPDATE assets SET deleted_at=now() WHERE id=$1`, `UPDATE assets SET deleted_at=NULL WHERE id=$1`},
		{"no playable variant", `UPDATE asset_variants SET player_compatible=FALSE WHERE asset_id=$1`, `UPDATE asset_variants SET player_compatible=TRUE WHERE asset_id=$1`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := f.pool.Exec(f.ctx, test.change, assetID); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := f.pool.Exec(f.ctx, test.restore, assetID); err != nil {
					t.Fatal(err)
				}
			})
			if _, err := f.service.Assign(f.ctx, f.screen, playlist.ID, f.user); !errors.Is(err, ErrPresentationNotReady) {
				t.Fatalf("tag playlist without eligible media was accepted: %v", err)
			}
		})
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE assets SET available_from=now()+interval '1 hour' WHERE id=$1`, assetID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Assign(f.ctx, f.screen, playlist.ID, f.user); err != nil {
		t.Fatalf("future-dated tag playlist assignment rejected: %v", err)
	}
	if err = f.service.ValidatePresentationNow(f.ctx, "playlist", playlist.ID, time.Now()); !errors.Is(err, ErrPresentationNotReady) {
		t.Fatalf("future-dated tag playlist was available immediately: %v", err)
	}
}
