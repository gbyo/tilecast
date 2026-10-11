package httpapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

type updateSelection struct {
	ReleaseID uuid.UUID   `json:"releaseId"`
	ScreenIDs []uuid.UUID `json:"screenIds"`
	GroupIDs  []uuid.UUID `json:"groupIds"`
}

type deploymentRelease struct {
	family, architecture, hash string
	versionCode, size          int64
	minimumSDK                 *int
}

type resolvedUpdateTarget struct {
	ID                uuid.UUID `json:"screenId"`
	Name              string    `json:"screenName"`
	Current           *int64    `json:"currentVersionCode"`
	Family            string    `json:"playerFamily"`
	Architecture      string    `json:"playerArchitecture"`
	Outcome           string    `json:"outcome"`
	Reason            *string   `json:"reason"`
	RecentlyContacted bool      `json:"recentlyContacted"`
	sdk               *int
	permission        string
	state             string
}

type updatePreview struct {
	TargetCount         int                    `json:"targetCount"`
	EligibleCount       int                    `json:"eligibleCount"`
	AlreadyCurrentCount int                    `json:"alreadyCurrentCount"`
	OfflineCount        int                    `json:"offlineCount"`
	BlockedCount        int                    `json:"blockedCount"`
	Screens             []resolvedUpdateTarget `json:"screens"`
}

// Both callers read release verification and targets in one transaction.
// Preview uses a read-only snapshot; creation obtains a fresh snapshot and
// retains the existing family filtering, canary, and command behavior.
func resolveUpdateSelection(ctx context.Context, tx pgx.Tx, input updateSelection, lockRelease bool) (deploymentRelease, []resolvedUpdateTarget, error) {
	var release deploymentRelease
	query := `SELECT player_family,architecture,version_code,minimum_sdk,apk_size,apk_sha256 FROM player_releases WHERE id=$1 AND verification_status='verified' AND cache_status='cached'`
	if lockRelease {
		// Preserve creation's protection against concurrent artifact removal.
		query += ` FOR SHARE`
	}
	err := tx.QueryRow(ctx, query, input.ReleaseID).Scan(&release.family, &release.architecture, &release.versionCode, &release.minimumSDK, &release.size, &release.hash)
	if err != nil {
		return release, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT s.id,s.name,ps.player_version_code,ps.android_sdk,COALESCE(ps.install_permission_status,'unknown'),COALESCE(s.last_heartbeat_at>now()-interval '15 minutes',false),COALESCE(ps.player_architecture,''),`+screenFamilySQL+` FROM screens s LEFT JOIN screen_player_status ps ON ps.screen_id=s.id WHERE s.deleted_at IS NULL AND s.organization_id=(SELECT id FROM organization_settings WHERE singleton) AND (s.id=ANY($1) OR EXISTS(SELECT 1 FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id WHERE m.screen_id=s.id AND g.deleted_at IS NULL AND m.screen_group_id=ANY($2))) ORDER BY s.id`, input.ScreenIDs, input.GroupIDs)
	if err != nil {
		return release, nil, err
	}
	defer rows.Close()
	targets := []resolvedUpdateTarget{}
	for rows.Next() {
		var target resolvedUpdateTarget
		if err := rows.Scan(&target.ID, &target.Name, &target.Current, &target.sdk, &target.permission, &target.RecentlyContacted, &target.Architecture, &target.Family); err != nil {
			return release, nil, err
		}
		evaluateUpdateTarget(release, &target)
		targets = append(targets, target)
	}
	return release, targets, rows.Err()
}

func evaluateUpdateTarget(release deploymentRelease, target *resolvedUpdateTarget) {
	target.state, target.Outcome, target.Reason = "pending", "eligible", nil
	if !target.RecentlyContacted {
		target.state, target.Outcome = "offline", "offline"
	}
	reason := ""
	if target.Family != release.family {
		reason = fmt.Sprintf("This release requires %s; this screen runs %s.", familyLabel(release.family), familyLabel(target.Family))
	} else if !updates.ScreenMatchesRelease(release.family, release.architecture, target.Family, target.Architecture) {
		reported := target.Architecture
		if reported == "" {
			reported = "an unknown architecture"
		}
		reason = fmt.Sprintf("This release requires %s architecture, but this screen reports %s.", release.architecture, reported)
	} else if release.minimumSDK != nil && target.sdk != nil && *target.sdk < *release.minimumSDK {
		reason = fmt.Sprintf("This release requires Android SDK %d, but this screen reports SDK %d.", *release.minimumSDK, *target.sdk)
	}
	if reason != "" {
		target.state, target.Outcome, target.Reason = "incompatible", "incompatible", &reason
	}
	// Preserve the existing no-downgrade precedence within a family.
	if target.Family == release.family && target.Current != nil && *target.Current >= release.versionCode {
		target.state, target.Outcome, target.Reason = "already_current", "already_current", nil
	}
}

func (s *server) previewUpdateDeployment(w http.ResponseWriter, r *http.Request) {
	var input updateSelection
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if input.ReleaseID == uuid.Nil || len(input.ScreenIDs)+len(input.GroupIDs) == 0 {
		writeError(w, 422, "update_deployment_invalid", "A release and at least one target are required.")
		return
	}
	if !s.authorizeScreenList(w, r, input.ScreenIDs, input.GroupIDs) {
		return
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	_, targets, err := resolveUpdateSelection(r.Context(), tx, input, false)
	if err == pgx.ErrNoRows {
		writeError(w, 422, "player_release_not_verified", "Only fully verified cached releases can be deployed.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	ids := make([]uuid.UUID, 0, len(targets))
	for _, target := range targets {
		ids = append(ids, target.ID)
	}
	if !s.authorizeScreenList(w, r, ids, nil) {
		return
	}
	preview := updatePreview{TargetCount: len(targets), Screens: targets}
	for _, target := range targets {
		switch target.Outcome {
		case "incompatible":
			preview.BlockedCount++
		case "already_current":
			preview.AlreadyCurrentCount++
		case "offline":
			preview.OfflineCount++
			preview.EligibleCount++
		default:
			preview.EligibleCount++
		}
	}
	writeJSON(w, 200, map[string]any{"data": preview})
}
