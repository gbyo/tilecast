package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

func (s *server) listPlayerReleases(w http.ResponseWriter, r *http.Request) {
	var releaseCount int
	var checked *time.Time
	var providerError *string
	_ = s.db.QueryRow(r.Context(), `SELECT count(*) FROM player_releases`).Scan(&releaseCount)
	_ = s.db.QueryRow(r.Context(), `SELECT last_checked_at,safe_error FROM update_provider_state WHERE provider='github'`).Scan(&checked, &providerError)
	if releaseCount == 0 || checked == nil || time.Since(*checked) > 15*time.Minute {
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		_ = s.updates.Check(ctx)
		cancel()
		checked = nil
		providerError = nil
		_ = s.db.QueryRow(r.Context(), `SELECT last_checked_at,safe_error FROM update_provider_state WHERE provider='github'`).Scan(&checked, &providerError)
	}

	rows, err := s.db.Query(r.Context(), `SELECT id,COALESCE(github_tag,''),platform,player_family,architecture,source,channel,version_code,version_name,minimum_sdk,release_notes,published_at,apk_size,cache_downloaded_bytes,apk_sha256,signing_certificate_sha256,manifest_signature,cache_status,verification_status,verification_error,
		(SELECT count(*) FROM update_deployments d WHERE d.release_id=player_releases.id),
		(SELECT count(*) FROM update_deployments d WHERE d.release_id=player_releases.id AND d.status IN('pending','active'))
		FROM player_releases ORDER BY player_family,architecture,version_code DESC`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var tag, platform, family, architecture, source, channel, name, notes, hash, cert, signature, cache, verification string
		var code, size, downloadedBytes int64
		var deploymentCount, activeDeploymentCount int
		var sdk *int
		var published time.Time
		var verificationError *string
		if rows.Scan(&id, &tag, &platform, &family, &architecture, &source, &channel, &code, &name, &sdk, &notes, &published, &size, &downloadedBytes, &hash, &cert, &signature, &cache, &verification, &verificationError, &deploymentCount, &activeDeploymentCount) == nil {
			items = append(items, map[string]any{"id": id, "tag": tag, "platform": platform, "playerFamily": family, "architecture": architecture, "source": source, "channel": channel, "versionCode": code, "versionName": name, "minimumSdk": sdk, "releaseNotes": notes, "publishedAt": published, "apkSizeBytes": size, "downloadedBytes": downloadedBytes, "apkSha256": hash, "signingCertificateSha256": cert, "manifestSignature": signature, "cacheStatus": cache, "verificationStatus": verification, "verificationError": verificationError, "deploymentCount": deploymentCount, "activeDeploymentCount": activeDeploymentCount})
		}
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"repository": "Gibsonmb71/tilecast", "lastCheckedAt": checked, "providerError": providerError, "manifestKeyConfigured": s.updates.ManifestKeyConfigured(), "githubAuth": s.updates.GitHubAuthStatus(), "items": items}})
}

func (s *server) uploadPlayerRelease(w http.ResponseWriter, r *http.Request) {
	if !s.updates.ManifestKeyConfigured() {
		writeError(w, http.StatusServiceUnavailable, "update_manifest_key_missing", "A trusted update manifest public key must be configured before importing releases.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.updates.MaximumUploadBytes())
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "player_release_upload_invalid", "Upload a multipart form containing the three required release files.")
		return
	}
	temporary, err := os.MkdirTemp("", "tilecast-player-release-*")
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer os.RemoveAll(temporary)

	files := map[string]string{}
	for {
		part, partErr := reader.NextPart()
		if errors.Is(partErr, io.EOF) {
			break
		}
		if partErr != nil {
			writeError(w, http.StatusBadRequest, "player_release_upload_invalid", "The release upload could not be read.")
			return
		}
		name := filepath.Base(part.FileName())
		limit, accepted := releaseUploadPartLimit(name, part.Header.Get("Content-Type"), s.updates.MaximumAPKBytes())
		if !accepted || name != part.FileName() || files[name] != "" {
			part.Close()
			writeError(w, http.StatusUnprocessableEntity, "player_release_file_invalid", "Only one copy of each required Tilecast Player release file is accepted.")
			return
		}
		path := filepath.Join(temporary, name)
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if createErr != nil {
			part.Close()
			s.internalError(w, r, createErr)
			return
		}
		written, copyErr := io.Copy(file, io.LimitReader(part, limit+1))
		closeErr := file.Close()
		part.Close()
		if copyErr != nil || closeErr != nil || written > limit {
			writeError(w, http.StatusRequestEntityTooLarge, "player_release_file_too_large", "A release file exceeds its configured size limit.")
			return
		}
		files[name] = path
	}
	// The uploaded files select the family: a Tilecast Edge envelope and
	// archive, an AppImage (the Electron Linux Player, with its Linux-suffixed
	// manifest), or otherwise the Android APK.
	artifactName, manifestName, signatureName := "tilecast-player.apk", "tilecast-player-update.json", "tilecast-player-update.json.sig"
	if files[updates.LinuxArtifactName] != "" {
		artifactName, manifestName, signatureName = updates.LinuxArtifactName, "tilecast-player-update-linux.json", "tilecast-player-update-linux.json.sig"
	}
	if files[updates.EdgeManifestName] != "" {
		manifestName, signatureName, artifactName = updates.EdgeManifestName, updates.EdgeManifestName+".sig", ""
		for name := range files {
			if edgeArchiveName.MatchString(name) {
				artifactName = name
			}
		}
		if artifactName == "" {
			writeError(w, http.StatusUnprocessableEntity, "player_release_file_missing", "Missing required release file: the Tilecast Edge archive.")
			return
		}
	}
	for _, name := range []string{artifactName, manifestName, signatureName} {
		if files[name] == "" {
			writeError(w, http.StatusUnprocessableEntity, "player_release_file_missing", "Missing required release file: "+name+".")
			return
		}
	}
	manifest, err := os.ReadFile(files[manifestName])
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	signature, err := os.ReadFile(files[signatureName])
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var userID *uuid.UUID
	if session, ok := r.Context().Value(sessionContextKey).(auth.Session); ok {
		userID = &session.User.ID
	}
	result, err := s.updates.ImportUpload(r.Context(), files[artifactName], artifactName, manifest, signature, userID)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "player_release_verification_failed", err.Error())
		return
	}
	resourceID := result.ID.String()
	auditMetadata, _ := json.Marshal(map[string]any{"platform": result.Manifest.NormalizedPlatform(), "playerFamily": result.Manifest.NormalizedFamily(), "architecture": result.Manifest.Architecture(), "versionCode": result.Manifest.VersionCode, "channel": result.Manifest.Channel, "duplicate": result.Duplicate})
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,'player_updates.release_uploaded','player_release',$3,$4::jsonb)`, uuid.New(), userID, resourceID, string(auditMetadata))
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{"id": result.ID, "platform": result.Manifest.NormalizedPlatform(), "playerFamily": result.Manifest.NormalizedFamily(), "architecture": result.Manifest.Architecture(), "source": result.Source, "versionCode": result.Manifest.VersionCode, "versionName": result.Manifest.VersionName, "channel": result.Manifest.Channel, "apkSizeBytes": result.Manifest.ArtifactSize(), "releaseNotes": result.Manifest.ReleaseNotes, "cacheStatus": result.CacheStatus, "verificationStatus": result.VerificationStatus, "duplicate": result.Duplicate}})
}

// edgeArchiveName matches the archive of a Tilecast Edge release
// (updates.EdgeArtifactName); the signed envelope must name it exactly.
var edgeArchiveName = regexp.MustCompile(`^tilecast-edge-[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z.]+)?-(x86_64|aarch64)\.tar\.zst$`)

func releaseUploadPartLimit(name, contentType string, maximum int64) (int64, bool) {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if edgeArchiveName.MatchString(name) {
		return maximum, mediaType == "application/zstd" || mediaType == "application/octet-stream"
	}
	switch name {
	case updates.EdgeManifestName:
		return 16 << 10, mediaType == "application/json" || mediaType == "application/octet-stream"
	case updates.EdgeManifestName + ".sig":
		return 4 << 10, mediaType == "application/octet-stream" || mediaType == "text/plain"
	case "tilecast-player.apk":
		return maximum, mediaType == "application/vnd.android.package-archive" || mediaType == "application/octet-stream"
	case updates.LinuxArtifactName:
		return maximum, mediaType == "application/octet-stream" || mediaType == "application/x-executable"
	case "tilecast-player-update.json", "tilecast-player-update-linux.json":
		return 128 << 10, mediaType == "application/json" || mediaType == "application/octet-stream"
	case "tilecast-player-update.json.sig", "tilecast-player-update-linux.json.sig":
		return 4 << 10, mediaType == "application/octet-stream" || mediaType == "text/plain"
	default:
		return 0, false
	}
}

func (s *server) checkPlayerReleases(w http.ResponseWriter, r *http.Request) {
	if !s.updates.ManifestKeyConfigured() {
		writeError(w, http.StatusServiceUnavailable, "update_manifest_key_missing", "Tilecast Player update trust is not configured. Rebuild the server with the official trust key or set TILECAST_UPDATE_MANIFEST_PUBLIC_KEY.")
		return
	}
	if err := s.updates.Check(r.Context()); err != nil {
		writeError(w, 502, "github_release_check_failed", err.Error())
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'player_updates.checked','update_provider','github')`, uuid.New(), user.ID)
	writeJSON(w, 200, map[string]any{"data": map[string]any{"checked": true}})
}

func (s *server) startGitHubDeviceAuthorization(w http.ResponseWriter, r *http.Request) {
	result, err := s.updates.BeginGitHubDeviceAuthorization(r.Context())
	if err != nil {
		if errors.Is(err, updates.ErrGitHubAuthUnavailable) {
			writeError(w, http.StatusServiceUnavailable, "github_sign_in_unavailable", "GitHub sign-in is unavailable. Configure TILECAST_GITHUB_CLIENT_ID with a device-flow-enabled OAuth App client ID.")
			return
		}
		writeError(w, http.StatusBadGateway, "github_sign_in_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": result})
}

type githubDevicePollInput struct {
	FlowID string `json:"flowId"`
}

func (s *server) pollGitHubDeviceAuthorization(w http.ResponseWriter, r *http.Request) {
	var input githubDevicePollInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.FlowID = strings.TrimSpace(input.FlowID)
	if _, err := uuid.Parse(input.FlowID); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "github_sign_in_flow_invalid", "GitHub sign-in request is invalid or expired.")
		return
	}
	result, err := s.updates.PollGitHubDeviceAuthorization(r.Context(), input.FlowID)
	if err != nil {
		switch {
		case errors.Is(err, updates.ErrGitHubAuthUnavailable):
			writeError(w, http.StatusServiceUnavailable, "github_sign_in_unavailable", "GitHub sign-in is unavailable.")
		case errors.Is(err, updates.ErrGitHubAuthFlow):
			writeError(w, http.StatusGone, "github_sign_in_expired", err.Error())
		default:
			writeError(w, http.StatusBadGateway, "github_sign_in_failed", err.Error())
		}
		return
	}
	if result.Status == "connected" {
		user := r.Context().Value(sessionContextKey).(auth.Session).User
		metadata, _ := json.Marshal(map[string]string{"login": result.Login})
		_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,'player_updates.github_connected','update_provider','github',$3::jsonb)`, uuid.New(), user.ID, string(metadata))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) disconnectGitHub(w http.ResponseWriter, r *http.Request) {
	if err := s.updates.DisconnectGitHub(); err != nil {
		switch {
		case errors.Is(err, updates.ErrGitHubAuthManaged):
			writeError(w, http.StatusConflict, "github_auth_environment_managed", err.Error())
		case errors.Is(err, updates.ErrGitHubAuthUnavailable):
			writeError(w, http.StatusServiceUnavailable, "github_sign_in_unavailable", err.Error())
		default:
			s.internalError(w, r, err)
		}
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'player_updates.github_disconnected','update_provider','github')`, uuid.New(), user.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) cachePlayerRelease(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var status string
	if err := s.db.QueryRow(r.Context(), `UPDATE player_releases SET cache_status='downloading',cache_downloaded_bytes=0,verification_status='verified_manifest',verification_error=NULL,updated_at=now() WHERE id=$1 AND verification_status IN('verified_manifest','failed') AND cache_status<>'downloading' RETURNING cache_status`, id).Scan(&status); err != nil {
		writeError(w, 409, "player_release_not_importable", "Release is unavailable or already verified.")
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		if err := s.updates.Cache(ctx, id); err != nil {
			message := err.Error()
			if len(message) > 240 {
				message = message[:240]
			}
			_, _ = s.db.Exec(ctx, `UPDATE player_releases SET cache_status='failed',verification_status='failed',verification_error=$2,updated_at=now() WHERE id=$1`, id, message)
		}
	}()
	writeJSON(w, 202, map[string]any{"data": map[string]any{"id": id, "cacheStatus": status}})
}

// deletePlayerRelease frees the disk a release occupies. Releases that were
// never deployed disappear entirely; the rest keep their record so deployment
// history stays intact and only lose the cached artifact.
func (s *server) deletePlayerRelease(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var cacheStatus string
	if err := s.db.QueryRow(r.Context(), `SELECT cache_status FROM player_releases WHERE id=$1`, id).Scan(&cacheStatus); err != nil {
		writeError(w, http.StatusNotFound, "player_release_not_found", "Release was not found.")
		return
	}
	if cacheStatus == "downloading" {
		writeError(w, http.StatusConflict, "player_release_busy", "This release is downloading. Wait for the download to finish before removing it.")
		return
	}
	var active int
	_ = s.db.QueryRow(r.Context(), `SELECT count(*) FROM update_deployments WHERE release_id=$1 AND status IN('pending','active')`, id).Scan(&active)
	if active > 0 {
		writeError(w, http.StatusConflict, "player_release_in_use", "A deployment of this release is still running. Cancel or finish it before removing the release.")
		return
	}
	deleted, err := s.updates.Purge(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	action := "player_updates.release_cache_freed"
	if deleted {
		action = "player_updates.release_deleted"
	}
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,'player_release',$4)`, uuid.New(), user.ID, action, id.String())
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"id": id, "deleted": deleted}})
}

type deploymentInput struct {
	ReleaseID              uuid.UUID   `json:"releaseId"`
	Name                   string      `json:"name"`
	Mode                   string      `json:"mode"`
	MaintenanceWindowStart *time.Time  `json:"maintenanceWindowStart"`
	ScreenIDs              []uuid.UUID `json:"screenIds"`
	GroupIDs               []uuid.UUID `json:"groupIds"`
	CanarySize             int         `json:"canarySize"`
}

func (s *server) createUpdateDeployment(w http.ResponseWriter, r *http.Request) {
	var input deploymentInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 180 || (input.Mode != "download_only" && input.Mode != "install_now" && input.Mode != "maintenance_window") || len(input.ScreenIDs)+len(input.GroupIDs) == 0 || input.CanarySize < 0 || input.CanarySize > 50 {
		writeError(w, 422, "update_deployment_invalid", "Name, deployment mode, and at least one target are required.")
		return
	}
	if input.Mode == "maintenance_window" && (input.MaintenanceWindowStart == nil || input.MaintenanceWindowStart.Before(time.Now())) {
		writeError(w, 422, "update_deployment_invalid", "Choose a future maintenance window.")
		return
	}
	var versionCode, apkSize int64
	var minimumSDK *int
	var family, architecture, hash string
	if err := s.db.QueryRow(r.Context(), `SELECT player_family,architecture,version_code,minimum_sdk,apk_size,apk_sha256 FROM player_releases WHERE id=$1 AND verification_status='verified' AND cache_status='cached'`, input.ReleaseID).Scan(&family, &architecture, &versionCode, &minimumSDK, &apkSize, &hash); err != nil {
		writeError(w, 422, "player_release_not_verified", "Only fully verified cached releases can be deployed.")
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	id := uuid.New()
	rolloutMode := "full"
	rolloutPhase := "full"
	if input.CanarySize > 0 {
		rolloutMode = "canary"
		rolloutPhase = "canary"
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO update_deployments(id,release_id,name,mode,maintenance_window_start,created_by,status,started_at,rollout_mode,rollout_phase,canary_size)VALUES($1,$2,$3,$4,$5,$6,'active',now(),$7,$8,$9)`, id, input.ReleaseID, input.Name, input.Mode, input.MaintenanceWindowStart, user.ID, rolloutMode, rolloutPhase, input.CanarySize)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !s.authorizeScreenList(w, r, input.ScreenIDs, input.GroupIDs) {
		return
	}
	for _, screen := range uniqueUUIDs(input.ScreenIDs) {
		if _, err = tx.Exec(r.Context(), `INSERT INTO update_deployment_targets(deployment_id,target_type,screen_id) SELECT $1,'screen',$2 WHERE EXISTS(SELECT 1 FROM screens WHERE id=$2 AND deleted_at IS NULL)`, id, screen); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	for _, group := range uniqueUUIDs(input.GroupIDs) {
		if _, err = tx.Exec(r.Context(), `INSERT INTO update_deployment_targets(deployment_id,target_type,screen_group_id) SELECT $1,'group',$2 WHERE EXISTS(SELECT 1 FROM screen_groups WHERE id=$2 AND deleted_at IS NULL)`, id, group); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	// A release reaches only screens of its family. A player that reports its
	// family (Tilecast Edge always does) is taken at its word; for older
	// players the platform decides: "linux" is the Electron Linux Player, and
	// every other platform string ("fire-tv", "android-tv", ...) is Android,
	// so future Android form factors stay eligible. An Electron release can
	// therefore never reach an Edge screen, nor an Edge release an Electron one.
	rows, err := tx.Query(r.Context(), `SELECT DISTINCT s.id,ps.player_version_code,ps.android_sdk,COALESCE(ps.install_permission_status,'unknown'),COALESCE(s.last_heartbeat_at>now()-interval '15 minutes',false),COALESCE(ps.player_architecture,'') FROM screens s LEFT JOIN screen_player_status ps ON ps.screen_id=s.id WHERE s.deleted_at IS NULL AND `+screenFamilySQL+`=$3 AND (s.id=ANY($1) OR EXISTS(SELECT 1 FROM screen_group_memberships m WHERE m.screen_id=s.id AND m.screen_group_id=ANY($2))) ORDER BY s.id`, input.ScreenIDs, input.GroupIDs, family)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	type target struct {
		id           uuid.UUID
		current      *int64
		sdk          *int
		permission   string
		recent       bool
		architecture string
	}
	targets := []target{}
	for rows.Next() {
		var item target
		if err = rows.Scan(&item.id, &item.current, &item.sdk, &item.permission, &item.recent, &item.architecture); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		targets = append(targets, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	if len(targets) == 0 {
		writeError(w, 422, "update_target_required", "No eligible "+familyLabel(family)+" screens matched the targets.")
		return
	}
	canarySize := normalizedCanarySize(input.CanarySize, len(targets))
	if input.CanarySize > 0 && canarySize == 0 {
		rolloutMode = "full"
		rolloutPhase = "full"
		if _, err = tx.Exec(r.Context(), `UPDATE update_deployments SET rollout_mode='full',rollout_phase='full',canary_size=0 WHERE id=$1`, id); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	for index, target := range targets {
		isCanary := canarySize > 0 && index < canarySize
		state := "pending"
		if !target.recent {
			state = "offline"
		}
		if minimumSDK != nil && target.sdk != nil && *target.sdk < *minimumSDK {
			state = "incompatible"
		}
		// An architecture-specific release needs a screen that reported the
		// same architecture; an unknown one is not assumed to match.
		if architecture != "" && target.architecture != architecture {
			state = "incompatible"
		}
		if target.current != nil && *target.current >= versionCode {
			state = "already_current"
		}
		if canarySize > 0 && !isCanary && (state == "pending" || state == "offline") {
			state = "held"
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO screen_update_states(deployment_id,screen_id,previous_version_code,expected_version_code,permission_status,state,completed_at,is_canary)VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 IN('already_current','incompatible') THEN now() END,$7)`, id, target.id, target.current, versionCode, target.permission, state, isCanary); err != nil {
			s.internalError(w, r, err)
			return
		}
		if state == "pending" || state == "offline" {
			payload, _ := json.Marshal(updateCommandPayload(id, input.ReleaseID, family, versionCode, hash, input.Mode, input.MaintenanceWindowStart))
			commandID := uuid.New()
			if _, err = tx.Exec(r.Context(), `INSERT INTO player_commands(id,organization_id,screen_id,type,payload,idempotency_key,created_by,expires_at) SELECT $1,organization_id,id,'install_player_update',$2::jsonb,$1,$3,now()+interval '7 days' FROM screens WHERE id=$4`, commandID, string(payload), user.ID, target.id); err != nil {
				s.internalError(w, r, err)
				return
			}
		}
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,'player_update.deployed','update_deployment',$3,jsonb_build_object('targetCount',$4::integer,'duplicateTargetsRemoved',$5::integer))`, uuid.New(), user.ID, id.String(), len(targets), len(input.ScreenIDs)+len(input.GroupIDs)-len(targets)); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, target := range targets {
		s.devices.Notify(target.id, map[string]any{"type": "commands.available"})
	}
	writeJSON(w, 201, map[string]any{"data": map[string]any{"id": id, "status": "active", "targetCount": len(targets), "apkSizeBytes": apkSize, "rolloutMode": rolloutMode, "rolloutPhase": rolloutPhase, "canarySize": canarySize}})
}

// screenFamilySQL is the Player release family of screen s (joined with its
// status as ps): what the player reported, or what its platform always meant.
const screenFamilySQL = `COALESCE(ps.player_family,CASE WHEN s.platform='linux' THEN 'electron-linux' ELSE 'android' END)`

func familyLabel(family string) string {
	switch family {
	case updates.FamilyEdge:
		return "Tilecast Edge"
	case updates.FamilyElectronLinux:
		return "Linux (Electron)"
	default:
		return "Android"
	}
}

// updateCommandPayload is the install_player_update command payload. The
// family lets a player refuse a deployment for another family before it
// fetches anything.
func updateCommandPayload(deployment, release uuid.UUID, family string, versionCode int64, hash, mode string, window *time.Time) map[string]any {
	return map[string]any{"deploymentId": deployment, "releaseId": release, "playerFamily": family, "expectedVersionCode": versionCode, "expectedApkSha256": hash, "expectedArtifactSha256": hash, "installationMode": mode, "maintenanceWindowStart": window}
}

func normalizedCanarySize(requested, targetCount int) int {
	if requested <= 0 || requested >= targetCount {
		return 0
	}
	return requested
}

// edgeDeploymentSQL is true when screen update state st belongs to a Tilecast
// Edge release. Edge success is never inferred from a heartbeat's version
// code: an Edge release is provisional after activation, and only the
// screen's explicit confirmation, reported through the update status
// endpoint, settles it (docs/tilecast-edge.md §15).
const edgeDeploymentSQL = `EXISTS(SELECT 1 FROM update_deployments ed JOIN player_releases er ON er.id=ed.release_id WHERE ed.id=st.deployment_id AND er.player_family='edge')`

// reconcileUpdateDeployments settles what the live heartbeat path should already
// have settled. It exists because a target stuck mid-install while its screen is
// demonstrably healthy at the expected version is a reporting bug, not an
// operational state, and Studio must not show it as progress forever.
//
// Bounded on purpose: three fixed statements, no per-row work, no retries. The
// order matters — settle first, so a canary that did reconnect healthily is not
// then paused for failing to.
func (s *server) reconcileUpdateDeployments(ctx context.Context) {
	// A screen counts as reconnected when it is currently heartbeating, reports a
	// version code at or above the expected one, has been up long enough for that
	// to mean the build stayed up, is not in safe mode, and reports no update
	// failure. The version code is the running process reporting itself, and the
	// process the update replaced could not have sent it.
	//
	// Every non-terminal state, not just `reconnecting`. Which state a finished
	// update was left in records only which of the player's best-effort status
	// reports was the last to land: the Android installer replaces the process
	// while the target still reads `installing`, and a Linux player whose reports
	// were lost installs anyway and leaves the target as far back as `pending`.
	//
	// Playing content is not required, and requiring it was the bug that stranded
	// whole sites: a screen asleep outside its active hours reports no playback at
	// all, so an update it had plainly finished could not settle until its next
	// school day. Uptime carries that weight instead — see devices.SettledUptimeSeconds.
	_, _ = s.db.Exec(ctx, `UPDATE screen_update_states st SET state='succeeded',reconnect_at=COALESCE(st.reconnect_at,now()),completed_at=now(),updated_at=now() WHERE st.state NOT IN('succeeded','failed','cancelled','incompatible','already_current') AND NOT `+edgeDeploymentSQL+` AND EXISTS(SELECT 1 FROM screens sc JOIN screen_player_status ps ON ps.screen_id=sc.id WHERE sc.id=st.screen_id AND sc.last_heartbeat_at>now()-interval '5 minutes' AND ps.player_version_code>=st.expected_version_code AND (sc.uptime_seconds IS NULL OR sc.uptime_seconds>=$1) AND NOT ps.safe_mode AND (ps.update_error IS NULL OR ps.update_error=''))`, devices.SettledUptimeSeconds)
	_, _ = s.db.Exec(ctx, `UPDATE update_deployments d SET status='paused',rollout_phase='paused',paused_at=now(),pause_reason='A canary did not reconnect within ten minutes.' WHERE d.status='active' AND d.rollout_phase='canary' AND EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.is_canary AND st.state IN('installing','reconnecting') AND st.updated_at<now()-interval '10 minutes')`)
	// The aggregate follows the targets: an active deployment with no unfinished
	// target is finished, whichever path finished the last one. Idempotent, so a
	// deployment that is already completed keeps its original completion time.
	_, _ = s.db.Exec(ctx, `UPDATE update_deployments d SET status='completed',completed_at=COALESCE(d.completed_at,now()) WHERE d.status='active' AND EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id) AND NOT EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.state NOT IN('succeeded','failed','cancelled','incompatible','already_current'))`)
}

// A deployment is not a screen, so the update-deployment routes cannot be
// scoped with requireScreenScope on an {id}. Their screen target is the set of
// screens the deployment created states for, which is fixed when the deployment
// starts and does not drift with group membership afterwards. The reads narrow
// to that set; the operations refuse anything they cannot cover in full.
const deploymentScreenStates = `screen_update_states st JOIN screens sc ON sc.id=st.screen_id`

// authorizeDeploymentScope authorizes every screen a deployment reaches.
//
// All or nothing, like every other bulk operation: cancelling the part of a
// deployment an operator can reach would leave the rest of it running and report
// a change they did not ask for. When none of it is in scope the answer is 404,
// because a scoped operator has no business learning the deployment exists.
func (s *server) authorizeDeploymentScope(w http.ResponseWriter, r *http.Request, deployment uuid.UUID) bool {
	user, scoped, ok := s.callerScope(w, r)
	if !ok {
		return false
	}
	if !scoped {
		return true
	}
	var total, inScope int
	if err := s.db.QueryRow(r.Context(),
		`SELECT count(*),count(*) FILTER(WHERE `+devices.InScopeSQL("sc", "$2")+`) FROM `+
			deploymentScreenStates+` WHERE st.deployment_id=$1`, deployment, user).Scan(&total, &inScope); err != nil {
		s.internalError(w, r, err)
		return false
	}
	if inScope == 0 {
		writeError(w, http.StatusNotFound, "update_deployment_not_found", "Deployment was not found.")
		return false
	}
	if inScope < total {
		writeError(w, http.StatusForbidden, "out_of_scope",
			"This deployment reaches screens outside your assigned scope.")
		return false
	}
	return true
}

func (s *server) listUpdateDeployments(w http.ResponseWriter, r *http.Request) {
	s.reconcileUpdateDeployments(r.Context())
	user, scoped, ok := s.callerScope(w, r)
	if !ok {
		return
	}
	// A scoped operator sees the deployments that reach their screens, and every
	// count is a count of their screens. The inner join is what drops a
	// deployment that reaches none of them.
	states := `LEFT JOIN screen_update_states st ON st.deployment_id=d.id`
	args := []any{}
	if scoped {
		states = `JOIN screen_update_states st ON st.deployment_id=d.id JOIN screens sc ON sc.id=st.screen_id AND ` +
			devices.InScopeSQL("sc", "$1")
		args = append(args, user)
	}
	rows, err := s.db.Query(r.Context(), `SELECT d.id,d.name,d.mode,d.status,d.created_at,r.platform,r.player_family,r.architecture,r.version_code,r.version_name,count(st.screen_id),count(*) FILTER(WHERE st.state='succeeded'),count(*) FILTER(WHERE st.state='failed'),count(*) FILTER(WHERE st.state IN ('waiting_for_permission','waiting_for_user')),d.rollout_mode,d.rollout_phase,d.canary_size,d.pause_reason,max(st.safe_error) FILTER(WHERE st.state='failed') FROM update_deployments d JOIN player_releases r ON r.id=d.release_id `+states+` GROUP BY d.id,r.id ORDER BY d.created_at DESC LIMIT 100`, args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var name, mode, status, platform, family, architecture, version, rolloutMode, rolloutPhase string
		var pauseReason, lastFailure *string
		var created time.Time
		var code int64
		var total, succeeded, failed, waiting int64
		var canarySize int
		if err = rows.Scan(&id, &name, &mode, &status, &created, &platform, &family, &architecture, &code, &version, &total, &succeeded, &failed, &waiting, &rolloutMode, &rolloutPhase, &canarySize, &pauseReason, &lastFailure); err != nil {
			s.internalError(w, r, err)
			return
		}
		items = append(items, map[string]any{"id": id, "name": name, "mode": mode, "status": status, "createdAt": created, "platform": platform, "playerFamily": family, "architecture": architecture, "versionCode": code, "versionName": version, "targetCount": total, "succeededCount": succeeded, "failedCount": failed, "waitingForUserCount": waiting, "rolloutMode": rolloutMode, "rolloutPhase": rolloutPhase, "canarySize": canarySize, "pauseReason": pauseReason, "lastFailure": lastFailure})
	}
	if err = rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) getUpdateDeployment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	s.reconcileUpdateDeployments(r.Context())
	user, scoped, ok := s.callerScope(w, r)
	if !ok {
		return
	}
	// The screen rows are narrowed rather than refused: a scoped operator reads
	// how their own screens are doing in a deployment that also covers screens
	// they cannot reach.
	filter, args := ``, []any{id}
	if scoped {
		filter = ` AND ` + devices.InScopeSQL("sc", "$2")
		args = append(args, user)
	}
	rows, err := s.db.Query(r.Context(), `SELECT st.screen_id,sc.name,st.previous_version_code,st.expected_version_code,st.downloaded_bytes,st.permission_status,st.installer_status,st.state,st.safe_error,st.updated_at,st.is_canary,st.download_started_at,st.downloaded_at,st.install_started_at,st.completed_at FROM `+
		deploymentScreenStates+` WHERE st.deployment_id=$1`+filter+` ORDER BY sc.name,sc.id`, args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var screen uuid.UUID
		var name, state string
		var previous *int64
		var expected, downloaded int64
		var permission, installer, errorText *string
		var updated time.Time
		var canary bool
		var downloadStarted, downloadFinished, installStarted, completed *time.Time
		// A read that failed is not a deployment that reaches nothing: reporting
		// it as 404 would tell a scoped operator their screens are not covered.
		if err := rows.Scan(&screen, &name, &previous, &expected, &downloaded, &permission, &installer, &state, &errorText, &updated, &canary, &downloadStarted, &downloadFinished, &installStarted, &completed); err != nil {
			s.internalError(w, r, err)
			return
		}
		items = append(items, map[string]any{"screenId": screen, "screenName": name, "previousVersionCode": previous, "expectedVersionCode": expected, "downloadedBytes": downloaded, "permissionStatus": permission, "installerStatus": installer, "state": state, "safeError": errorText, "updatedAt": updated, "isCanary": canary, "downloadStartedAt": downloadStarted, "downloadedAt": downloadFinished, "installStartedAt": installStarted, "completedAt": completed})
	}
	if err = rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	if scoped && len(items) == 0 {
		// Either it does not exist or it reaches nothing in scope. Both are 404,
		// so the id cannot be used to learn which.
		writeError(w, 404, "update_deployment_not_found", "Deployment was not found.")
		return
	}
	// The detail view reads on its own — a per-screen row means little without the
	// release it installs, the artifact size that turns downloaded bytes into
	// progress, and the rollout state that explains why a screen is still waiting.
	summary, ok := s.updateDeploymentSummary(w, r, id)
	if !ok {
		return
	}
	summary["id"] = id
	summary["screens"] = items
	writeJSON(w, 200, map[string]any{"data": summary})
}

// updateDeploymentSummary reads the deployment header its detail view renders.
// Scope is already settled by the caller, which narrows the screen rows.
func (s *server) updateDeploymentSummary(w http.ResponseWriter, r *http.Request, id uuid.UUID) (map[string]any, bool) {
	var name, mode, status, platform, family, architecture, version, rolloutMode, rolloutPhase string
	var pauseReason *string
	var created time.Time
	var completed *time.Time
	var code, artifactSize int64
	var canarySize int
	err := s.db.QueryRow(r.Context(), `SELECT d.name,d.mode,d.status,d.created_at,d.completed_at,d.rollout_mode,d.rollout_phase,d.canary_size,d.pause_reason,r.platform,r.player_family,r.architecture,r.version_code,r.version_name,r.apk_size FROM update_deployments d JOIN player_releases r ON r.id=d.release_id WHERE d.id=$1`, id).
		Scan(&name, &mode, &status, &created, &completed, &rolloutMode, &rolloutPhase, &canarySize, &pauseReason, &platform, &family, &architecture, &code, &version, &artifactSize)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "update_deployment_not_found", "Deployment was not found.")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return map[string]any{"name": name, "mode": mode, "status": status, "createdAt": created, "completedAt": completed, "rolloutMode": rolloutMode, "rolloutPhase": rolloutPhase, "canarySize": canarySize, "pauseReason": pauseReason, "platform": platform, "playerFamily": family, "architecture": architecture, "versionCode": code, "versionName": version, "artifactSizeBytes": artifactSize}, true
}

func (s *server) cancelUpdateDeployment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	// Cancelling stops the deployment on every screen it reaches, so a scoped
	// operator must be able to reach all of them.
	if !s.authorizeDeploymentScope(w, r, id) {
		return
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE update_deployments SET status='cancelled',cancelled_at=now() WHERE id=$1 AND status='active'`, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, 409, "update_deployment_completed", "Deployment is no longer active.")
		return
	}
	_, _ = s.db.Exec(r.Context(), `UPDATE screen_update_states SET state='cancelled',completed_at=now(),updated_at=now() WHERE deployment_id=$1 AND state NOT IN ('succeeded','already_current')`, id)
	_, _ = s.db.Exec(r.Context(), `UPDATE player_commands SET state='cancelled',completed_at=now(),updated_at=now() WHERE payload->>'deploymentId'=$1 AND type='install_player_update' AND state IN ('pending','delivered','acknowledged')`, id.String())
	writeJSON(w, 200, map[string]any{"data": map[string]any{"id": id, "status": "cancelled"}})
}

func (s *server) retryUpdateScreen(w http.ResponseWriter, r *http.Request) {
	deployment, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	screen, ok := urlUUID(w, r, "screenId")
	if !ok {
		return
	}
	// A retry installs on one screen, so the single-screen rule applies rather
	// than the whole deployment's: an operator may retry their own screen in a
	// deployment that also covers screens they cannot reach.
	if !s.authorizeScreen(w, r, screen) {
		return
	}
	var release uuid.UUID
	var version int64
	var hash, mode, family string
	var window *time.Time
	if err := s.db.QueryRow(r.Context(), `SELECT d.release_id,pr.version_code,pr.apk_sha256,d.mode,pr.player_family,d.maintenance_window_start FROM update_deployments d JOIN player_releases pr ON pr.id=d.release_id JOIN screen_update_states st ON st.deployment_id=d.id AND st.screen_id=$2 WHERE d.id=$1 AND st.state='failed'`, deployment, screen).Scan(&release, &version, &hash, &mode, &family, &window); err != nil {
		writeError(w, 409, "update_retry_not_allowed", "Only failed screen updates can be retried.")
		return
	}
	payload, _ := json.Marshal(updateCommandPayload(deployment, release, family, version, hash, mode, window))
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	command := uuid.New()
	_, err := s.db.Exec(r.Context(), `INSERT INTO player_commands(id,organization_id,screen_id,type,payload,idempotency_key,created_by,expires_at) SELECT $1,organization_id,id,'install_player_update',$2::jsonb,$1,$3,now()+interval '7 days' FROM screens WHERE id=$4`, command, string(payload), user.ID, screen)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	_, _ = s.db.Exec(r.Context(), `UPDATE screen_update_states SET state='pending',safe_error=NULL,downloaded_bytes=0,updated_at=now() WHERE deployment_id=$1 AND screen_id=$2`, deployment, screen)
	s.devices.Notify(screen, map[string]any{"type": "commands.available"})
	writeJSON(w, 202, map[string]any{"data": map[string]any{"state": "pending"}})
}

func (s *server) playerUpdateMetadata(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	release, ok := urlUUID(w, r, "releaseId")
	if !ok {
		return
	}
	var code, size int64
	var platform, family, architecture, name, hash, cert, artifactName, signature string
	var manifestBytes []byte
	var stateSchema *int
	var sdk *int
	if err := s.db.QueryRow(r.Context(), `SELECT pr.platform,pr.player_family,pr.architecture,pr.version_code,pr.version_name,pr.minimum_sdk,pr.apk_size,pr.apk_sha256,pr.signing_certificate_sha256,pr.apk_name,pr.manifest_bytes,pr.manifest_signature,pr.state_schema_version FROM player_releases pr WHERE pr.id=$1 AND pr.verification_status='verified' AND EXISTS(SELECT 1 FROM screen_update_states st JOIN update_deployments d ON d.id=st.deployment_id WHERE st.screen_id=$2 AND d.release_id=pr.id AND d.status='active' AND st.state NOT IN ('cancelled','incompatible'))`, release, principal.ScreenID).Scan(&platform, &family, &architecture, &code, &name, &sdk, &size, &hash, &cert, &artifactName, &manifestBytes, &signature, &stateSchema); err != nil {
		writeError(w, 404, "player_update_not_found", "Update is unavailable for this screen.")
		return
	}
	data := map[string]any{"releaseId": release, "artifactId": artifactName, "platform": platform, "versionCode": code, "versionName": name}
	switch family {
	case updates.FamilyEdge:
		// The exact signed envelope: the screen verifies its signature and
		// every field against this answer and the command before it downloads.
		data["playerFamily"] = family
		data["architecture"] = architecture
		data["artifactSizeBytes"] = size
		data["artifactSha256"] = hash
		data["artifactPath"] = fmt.Sprintf("/api/v1/player/updates/%s/artifact", release)
		data["signedManifest"] = base64.StdEncoding.EncodeToString(manifestBytes)
		data["manifestSignature"] = signature
		data["stateSchemaVersion"] = stateSchema
	case updates.FamilyElectronLinux:
		data["playerFamily"] = family
		data["artifactSizeBytes"] = size
		data["artifactSha256"] = hash
		data["artifactPath"] = fmt.Sprintf("/api/v1/player/updates/%s/artifact", release)
	default:
		data["applicationId"] = updates.ApplicationID
		data["minimumSdk"] = sdk
		data["apkSizeBytes"] = size
		data["apkSha256"] = hash
		data["signingCertificateSha256"] = cert
		data["apkPath"] = fmt.Sprintf("/api/v1/player/updates/%s/apk", release)
	}
	writeJSON(w, 200, map[string]any{"data": data})
}

// playerUpdateArtifact streams the verified release artifact (APK or AppImage)
// to a targeted screen. It backs both the /apk (Android) and /artifact (Linux)
// routes; the platform recorded with the release selects the filename and type.
func (s *server) playerUpdateArtifact(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	release, ok := urlUUID(w, r, "releaseId")
	if !ok {
		return
	}
	var allowed bool
	_ = s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM screen_update_states st JOIN update_deployments d ON d.id=st.deployment_id WHERE st.screen_id=$1 AND d.release_id=$2 AND d.status='active' AND st.state NOT IN ('cancelled','incompatible'))`, principal.ScreenID, release).Scan(&allowed)
	if !allowed {
		writeError(w, 403, "player_update_not_targeted", "This screen is not targeted for the update.")
		return
	}
	path, size, hash, family, err := s.updates.ArtifactPath(r.Context(), release)
	if err != nil {
		writeError(w, 404, "player_update_not_found", "Verified update artifact is unavailable.")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, 404, "player_update_not_found", "Verified update artifact is unavailable.")
		return
	}
	defer file.Close()
	filename, contentType := "tilecast-player.apk", "application/vnd.android.package-archive"
	switch family {
	case updates.FamilyElectronLinux:
		filename, contentType = updates.LinuxArtifactName, "application/octet-stream"
	case updates.FamilyEdge:
		filename, contentType = "tilecast-edge.tar.zst", "application/zstd"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("ETag", `"sha256-`+hash+`"`)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	http.ServeContent(w, r, filename, time.Time{}, ioSection{file, size})
}

type ioSection struct {
	*os.File
	size int64
}

func (f ioSection) Seek(offset int64, whence int) (int64, error) { return f.File.Seek(offset, whence) }

func (s *server) playerUpdateStatus(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	deployment, ok := urlUUID(w, r, "deploymentId")
	if !ok {
		return
	}
	var body struct {
		State            string `json:"state"`
		DownloadedBytes  int64  `json:"downloadedBytes"`
		PermissionStatus string `json:"permissionStatus"`
		InstallerStatus  string `json:"installerStatus"`
		Error            string `json:"error"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	allowed := map[string]bool{"downloading": true, "downloaded": true, "verifying": true, "ready": true, "waiting_for_permission": true, "waiting_for_user": true, "installing": true, "reconnecting": true, "failed": true, "succeeded": true}
	if !allowed[body.State] || body.DownloadedBytes < 0 || len(body.Error) > 240 || len(body.PermissionStatus) > 64 || len(body.InstallerStatus) > 64 {
		writeError(w, 422, "update_status_invalid", "Update status is invalid.")
		return
	}
	// `succeeded` is the explicit confirmation of a provisional Tilecast Edge
	// release. Other families settle from the heartbeat of the new build.
	if body.State == "succeeded" {
		var family string
		if err := s.db.QueryRow(r.Context(), `SELECT r.player_family FROM update_deployments d JOIN player_releases r ON r.id=d.release_id WHERE d.id=$1`, deployment).Scan(&family); err != nil || family != updates.FamilyEdge {
			writeError(w, 422, "update_status_invalid", "Update status is invalid.")
			return
		}
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE screen_update_states SET state=$3,downloaded_bytes=$4,permission_status=NULLIF($5,''),installer_status=NULLIF($6,''),safe_error=NULLIF($7,''),download_started_at=CASE WHEN $3='downloading' THEN COALESCE(download_started_at,now()) ELSE download_started_at END,downloaded_at=CASE WHEN $3 IN('downloaded','verifying','ready','waiting_for_permission','waiting_for_user','installing','reconnecting') THEN COALESCE(downloaded_at,now()) ELSE downloaded_at END,install_started_at=CASE WHEN $3='installing' THEN COALESCE(install_started_at,now()) ELSE install_started_at END,reconnect_at=CASE WHEN $3 IN('reconnecting','succeeded') THEN COALESCE(reconnect_at,now()) ELSE reconnect_at END,completed_at=CASE WHEN $3='succeeded' THEN now() ELSE completed_at END,updated_at=now() WHERE deployment_id=$1 AND screen_id=$2 AND state NOT IN('cancelled','succeeded')`, deployment, principal.ScreenID, body.State, body.DownloadedBytes, body.PermissionStatus, body.InstallerStatus, body.Error)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, 409, "update_deployment_cancelled", "Deployment is cancelled or complete.")
		return
	}
	_, _ = s.db.Exec(r.Context(), `UPDATE screen_player_status SET current_update_deployment_id=$2,update_state=$3,update_downloaded_bytes=$4,update_error=NULLIF($5,'') WHERE screen_id=$1`, principal.ScreenID, deployment, body.State, body.DownloadedBytes, body.Error)
	s.advanceCanaryDeployment(r.Context(), deployment, body.State == "failed")
	if body.State == "succeeded" {
		_, _ = s.db.Exec(r.Context(), `UPDATE update_deployments d SET status='completed',completed_at=COALESCE(d.completed_at,now()) WHERE d.id=$1 AND d.status='active' AND NOT EXISTS(SELECT 1 FROM screen_update_states st WHERE st.deployment_id=d.id AND st.state NOT IN('succeeded','failed','cancelled','incompatible','already_current'))`, deployment)
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"state": body.State}})
}

func (s *server) advanceCanaryDeployment(ctx context.Context, deployment uuid.UUID, failed bool) {
	var phase string
	if s.db.QueryRow(ctx, `SELECT rollout_phase FROM update_deployments WHERE id=$1 AND status='active'`, deployment).Scan(&phase) != nil || phase != "canary" {
		return
	}
	if failed {
		_, _ = s.db.Exec(ctx, `UPDATE update_deployments SET status='paused',rollout_phase='paused',paused_at=now(),pause_reason='A canary player reported an update failure.' WHERE id=$1 AND status='active'`, deployment)
		return
	}
	var remaining int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM screen_update_states WHERE deployment_id=$1 AND is_canary AND state NOT IN('succeeded','already_current')`, deployment).Scan(&remaining)
	if remaining != 0 {
		return
	}
	rows, err := s.db.Query(ctx, `UPDATE screen_update_states SET state='pending',updated_at=now() WHERE deployment_id=$1 AND state='held' RETURNING screen_id`, deployment)
	if err != nil {
		return
	}
	var screens []uuid.UUID
	for rows.Next() {
		var screen uuid.UUID
		if rows.Scan(&screen) == nil {
			screens = append(screens, screen)
		}
	}
	rows.Close()
	var release uuid.UUID
	var version int64
	var hash, mode, family string
	var window *time.Time
	var creator *uuid.UUID
	if s.db.QueryRow(ctx, `SELECT d.release_id,r.version_code,r.apk_sha256,d.mode,d.maintenance_window_start,d.created_by,r.player_family FROM update_deployments d JOIN player_releases r ON r.id=d.release_id WHERE d.id=$1`, deployment).Scan(&release, &version, &hash, &mode, &window, &creator, &family) != nil {
		return
	}
	for _, screen := range screens {
		payload, _ := json.Marshal(updateCommandPayload(deployment, release, family, version, hash, mode, window))
		command := uuid.New()
		_, _ = s.db.Exec(ctx, `INSERT INTO player_commands(id,organization_id,screen_id,type,payload,idempotency_key,created_by,expires_at) SELECT $1,organization_id,id,'install_player_update',$2::jsonb,$1,$3,now()+interval '7 days' FROM screens WHERE id=$4`, command, string(payload), creator, screen)
		s.devices.Notify(screen, map[string]any{"type": "commands.available"})
	}
	_, _ = s.db.Exec(ctx, `UPDATE update_deployments SET rollout_phase='full' WHERE id=$1 AND status='active'`, deployment)
}

func (s *server) advanceCanaryDeploymentsForScreen(ctx context.Context, screen uuid.UUID) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT d.id FROM update_deployments d JOIN screen_update_states current ON current.deployment_id=d.id AND current.screen_id=$1 AND current.is_canary WHERE d.status='active' AND d.rollout_phase='canary' AND current.state IN('succeeded','already_current') AND NOT EXISTS(SELECT 1 FROM screen_update_states remaining WHERE remaining.deployment_id=d.id AND remaining.is_canary AND remaining.state NOT IN('succeeded','already_current'))`, screen)
	if err != nil {
		return
	}
	var deployments []uuid.UUID
	for rows.Next() {
		var deployment uuid.UUID
		if rows.Scan(&deployment) == nil {
			deployments = append(deployments, deployment)
		}
	}
	rows.Close()
	for _, deployment := range deployments {
		s.advanceCanaryDeployment(ctx, deployment, false)
	}
}
