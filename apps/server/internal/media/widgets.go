package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
)

// configNormalizer validates and canonicalizes one provider's configuration.
// Both widget providers and Data Source providers satisfy it.
type configNormalizer interface {
	Normalize(context.Context, json.RawMessage) (any, error)
}

type websiteWidgetProvider struct{ service *Service }
type youtubeWidgetProvider struct{ service *Service }
type webDefinitionWidgetProvider struct {
	service    *Service
	definition contentdefs.WidgetDefinition
}

var youtubeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,128}$`)

const MaxWidgetPreviewBytes = 500 * 1024

type WidgetPreviewImage struct {
	Data        []byte
	ContentType string
	Width       int
	Height      int
	UpdatedAt   time.Time
}

// decodeConfig strictly decodes exactly one JSON object into target, rejecting unknown
// fields and any trailing content. Shared by widget and Data Source normalizers.
func decodeConfig(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("configuration must contain one JSON object")
		}
		return err
	}
	return nil
}

func (p websiteWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var config WebsiteConfig
	if err := decodeConfig(raw, &config); err != nil {
		return nil, err
	}
	// normalizeWebsite also validates asset metadata. Supply a bounded placeholder here;
	// CreateWidget and UpdateWidget apply the real name and description afterward.
	input := WebsiteInput{Name: "Website", WebsiteConfig: config, javascriptSet: true, domStorageSet: true}
	normalized, err := p.service.normalizeWebsite(ctx, input)
	return normalized.WebsiteConfig, err
}

func (p youtubeWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var config YouTubeConfig
	if err := decodeConfig(raw, &config); err != nil {
		return nil, err
	}
	config.URL = strings.TrimSpace(config.URL)
	u, err := url.Parse(config.URL)
	if err != nil || u.Scheme != "https" {
		return nil, errors.New("YouTube URL must use HTTPS")
	}
	host := strings.ToLower(strings.TrimPrefix(u.Hostname(), "www."))
	var videoID, playlistID string
	switch host {
	case "youtu.be":
		videoID = strings.Split(strings.Trim(u.Path, "/"), "/")[0]
	case "youtube.com", "m.youtube.com", "music.youtube.com":
		videoID = u.Query().Get("v")
		playlistID = u.Query().Get("list")
	default:
		return nil, errors.New("URL must use youtube.com or youtu.be")
	}
	if strings.Contains(u.Path, "/playlist") || (playlistID != "" && videoID == "") {
		config.Kind = "playlist"
		config.VideoID = ""
		config.PlaylistID = playlistID
		if !youtubeIDPattern.MatchString(playlistID) {
			return nil, errors.New("YouTube playlist URL is invalid")
		}
	} else {
		config.Kind = "video"
		config.VideoID = videoID
		config.PlaylistID = ""
		if !youtubeIDPattern.MatchString(videoID) {
			return nil, errors.New("YouTube video URL is invalid")
		}
	}
	if config.StartSeconds < 0 || config.StartSeconds > 86400 {
		return nil, errors.New("start time must be between 0 and 86400 seconds")
	}
	if config.EndSeconds != nil && *config.EndSeconds <= config.StartSeconds {
		return nil, errors.New("end time must be later than start time")
	}
	if config.Volume < 0 || config.Volume > 100 {
		return nil, errors.New("volume must be between 0 and 100 percent")
	}
	if config.CaptionLanguage != "" && !regexp.MustCompile(`^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$`).MatchString(config.CaptionLanguage) {
		return nil, errors.New("caption language must be a language code")
	}
	if config.FailureBehavior == "" {
		config.FailureBehavior = "placeholder"
	}
	if config.FailureBehavior != "placeholder" && config.FailureBehavior != "fallback_image" && config.FailureBehavior != "skip" {
		return nil, errors.New("failure behavior is invalid")
	}
	if config.PlaylistPlaybackMode == "" {
		config.PlaylistPlaybackMode = "until_end"
	}
	if config.PlaylistPlaybackMode != "until_end" && config.PlaylistPlaybackMode != "fixed_duration" {
		return nil, errors.New("playlist playback mode is invalid")
	}
	if config.PlaylistPlaybackMode == "fixed_duration" {
		if config.FixedDurationSeconds == nil || *config.FixedDurationSeconds < 1 || *config.FixedDurationSeconds > 86400 {
			return nil, errors.New("fixed duration must be between 1 and 86400 seconds")
		}
	} else {
		config.FixedDurationSeconds = nil
	}
	if config.FallbackImageAssetID != nil {
		var valid bool
		if err := p.service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND type='image' AND processing_status='ready' AND deleted_at IS NULL)`, *config.FallbackImageAssetID).Scan(&valid); err != nil {
			return nil, err
		}
		if !valid {
			return nil, errors.New("fallback asset must be a ready image")
		}
	}
	if config.FailureBehavior == "fallback_image" && config.FallbackImageAssetID == nil {
		return nil, errors.New("fallback image behavior requires a fallback image")
	}
	return config, nil
}

func (p webDefinitionWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	normalized, err := (definitionConfigNormalizer{service: p.service, schema: p.definition.ConfigurationSchema}).Normalize(ctx, raw)
	if err != nil {
		return nil, err
	}
	configuration := normalized.(map[string]any)
	if _, _, err = contentdefs.WebPresentationURL(p.definition, configuration); err != nil {
		return nil, err
	}
	return configuration, nil
}

func (s *Service) widgetProvider(name string) (configNormalizer, error) {
	if definition, ok := s.definitions.Widget(name); ok && !definition.LegacyEditor {
		if !definition.Availability.IsEnabled() {
			return nil, errors.New(definition.Availability.Reason)
		}
		if definition.Runtime == "web" {
			return webDefinitionWidgetProvider{service: s, definition: definition}, nil
		}
		return definitionConfigNormalizer{service: s, schema: definition.ConfigurationSchema}, nil
	}
	switch name {
	case "website":
		return websiteWidgetProvider{s}, nil
	case "youtube":
		return youtubeWidgetProvider{s}, nil
	case "clock":
		return clockWidgetProvider{}, nil
	case "date":
		return dateWidgetProvider{}, nil
	case "qrcode":
		return qrCodeWidgetProvider{}, nil
	case "countdown":
		return countdownWidgetProvider{}, nil
	case "ticker":
		return tickerWidgetProvider{s}, nil
	case "menu", "list", "table", "agenda":
		return displayWidgetProvider{s, name}, nil
	case "metric":
		return metricWidgetProvider{s}, nil
	case "cards":
		return cardsWidgetProvider{s}, nil
	case "weather":
		return weatherWidgetProvider{s}, nil
	case "spotlight":
		return spotlightWidgetProvider{s}, nil
	case "stat_grid":
		return statGridWidgetProvider{s}, nil
	case "chart":
		return chartWidgetProvider{s}, nil
	case "progress":
		return progressWidgetProvider{s}, nil
	case "timeline":
		return timelineWidgetProvider{s}, nil
	case "world_clock":
		return worldClockWidgetProvider{}, nil
	default:
		return nil, errors.New("widget provider is not supported")
	}
}

func (s *Service) CreateWidget(ctx context.Context, user uuid.UUID, input WidgetInput) (Asset, error) {
	input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 180 || len(input.Description) > 2000 {
		return Asset{}, errors.New("widget name or description is invalid")
	}
	if err := validatePreset(input.Provider, input.PresetID); err != nil {
		return Asset{}, err
	}
	if definition, ok := s.definitions.Widget(input.Provider); ok && definition.Recipe != nil {
		return s.createAppRecipeWidget(ctx, user, input, definition)
	}
	provider, err := s.widgetProvider(input.Provider)
	if err != nil {
		return Asset{}, err
	}
	configuration, err := provider.Normalize(ctx, input.Configuration)
	if err != nil {
		return Asset{}, err
	}
	if input.Provider == "website" {
		config := configuration.(WebsiteConfig)
		return s.CreateWebsite(ctx, user, WebsiteInput{Name: input.Name, Description: input.Description, WebsiteConfig: config, javascriptSet: true, domStorageSet: true})
	}
	encoded, _ := json.Marshal(configuration)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var organizationID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		return Asset{}, err
	}
	id := ids.New(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO assets(id,organization_id,name,description,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by) VALUES($1,$2,$3,$4,'widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$5)`, id, organizationID, input.Name, input.Description, user); err != nil {
		return Asset{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO widgets(asset_id,provider,preset_id,config_version,configuration) VALUES($1,$2,$3,$4,$5::jsonb)`, id, input.Provider, input.PresetID, widgetConfigVersion(input.Provider), string(encoded)); err != nil {
		return Asset{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'widget.created','widget',$3,jsonb_build_object('provider',$4::text))`, uuid.New(), user, id.String(), input.Provider); err != nil {
		return Asset{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	return s.GetAsset(ctx, id)
}

// A stored snapshot depicts a Widget's configuration, so it survives edits that cannot change what
// was rendered — renaming a Widget or rewording its description keeps the image the library already
// shows. Only a configuration, config version, or preset change discards it, and the editor uploads
// a replacement immediately after saving. Postgres evaluates every assignment against the row's
// existing values, so this condition compares what is stored with what is arriving; jsonb equality
// rather than raw bytes keeps the comparison honest about key order.
const widgetPreviewStillDepicts = `configuration=$2::jsonb AND config_version=$3 AND preset_id IS NOT DISTINCT FROM $4`

var updateWidgetStatement = fmt.Sprintf(`UPDATE widgets SET configuration=$2::jsonb,config_version=$3,preset_id=$4,updated_at=now(),
	preview_image=CASE WHEN %[1]s THEN preview_image ELSE NULL END,
	preview_content_type=CASE WHEN %[1]s THEN preview_content_type ELSE NULL END,
	preview_width=CASE WHEN %[1]s THEN preview_width ELSE NULL END,
	preview_height=CASE WHEN %[1]s THEN preview_height ELSE NULL END,
	preview_updated_at=CASE WHEN %[1]s THEN preview_updated_at ELSE NULL END
	WHERE asset_id=$1`, widgetPreviewStillDepicts)

func (s *Service) UpdateWidget(ctx context.Context, id, user uuid.UUID, input WidgetInput) (Asset, error) {
	existing, err := s.GetAsset(ctx, id)
	if err != nil || existing.Widget == nil {
		return Asset{}, ErrNotFound
	}
	if input.Provider == "" {
		input.Provider = existing.Widget.Provider
	}
	if input.Provider != existing.Widget.Provider {
		return Asset{}, errors.New("widget provider cannot be changed")
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 180 || len(input.Description) > 2000 {
		return Asset{}, errors.New("widget name or description is invalid")
	}
	if input.PresetID == nil {
		input.PresetID = existing.Widget.PresetID
	}
	if err := validatePreset(input.Provider, input.PresetID); err != nil {
		return Asset{}, err
	}
	if definition, ok := s.definitions.Widget(input.Provider); ok && definition.Recipe != nil {
		return s.updateAppRecipeWidget(ctx, id, user, input, definition, *existing.Widget)
	}
	provider, err := s.widgetProvider(input.Provider)
	if err != nil {
		return Asset{}, err
	}
	configuration, err := provider.Normalize(ctx, input.Configuration)
	if err != nil {
		return Asset{}, err
	}
	if input.Provider == "website" {
		config := configuration.(WebsiteConfig)
		return s.UpdateWebsite(ctx, id, user, WebsiteInput{Name: input.Name, Description: input.Description, WebsiteConfig: config, javascriptSet: true, domStorageSet: true})
	}
	encoded, _ := json.Marshal(configuration)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `UPDATE assets SET name=$2,description=$3,updated_at=now() WHERE id=$1 AND type='widget' AND deleted_at IS NULL`, id, input.Name, strings.TrimSpace(input.Description))
	if err != nil || tag.RowsAffected() == 0 {
		return Asset{}, ErrNotFound
	}
	if _, err = tx.Exec(ctx, updateWidgetStatement, id, string(encoded), widgetConfigVersion(input.Provider), input.PresetID); err != nil {
		return Asset{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'widget.updated','widget',$3)`, uuid.New(), user, id.String()); err != nil {
		return Asset{}, err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if transactional, ok := s.invalidator.(TransactionalAssetInvalidator); ok {
		transactionalUsed = true
		changes, err = transactional.AssetChangedInTx(ctx, tx, id, "widget.updated")
		if err != nil {
			return Asset{}, fmt.Errorf("invalidate widget manifest: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	if transactionalUsed {
		s.invalidator.(TransactionalAssetInvalidator).NotifyManifestChanges(changes)
	} else if s.invalidator != nil {
		if err := s.invalidator.AssetChanged(ctx, id, "widget.updated"); err != nil {
			return Asset{}, fmt.Errorf("invalidate widget manifest: %w", err)
		}
	}
	return s.GetAsset(ctx, id)
}

func (s *Service) StoreWidgetPreview(ctx context.Context, id, user uuid.UUID, data []byte) error {
	if err := validateWidgetPreview(data); err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `UPDATE widgets widget SET preview_image=$2,preview_content_type='image/jpeg',preview_width=960,preview_height=540,preview_updated_at=now(),updated_at=now() FROM assets asset WHERE widget.asset_id=$1 AND asset.id=widget.asset_id AND asset.type='widget' AND asset.deleted_at IS NULL`, id, data)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'widget.preview.updated','widget',$3)`, uuid.New(), user, id.String()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateWidgetPreview(data []byte) error {
	if len(data) < 1 || len(data) > MaxWidgetPreviewBytes {
		return fmt.Errorf("widget preview image must be between 1 and %d bytes", MaxWidgetPreviewBytes)
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 960 || config.Height != 540 {
		return errors.New("widget preview image must be a 960 by 540 JPEG")
	}
	return nil
}

func (s *Service) WidgetPreview(ctx context.Context, id uuid.UUID) (WidgetPreviewImage, error) {
	var image WidgetPreviewImage
	err := s.db.QueryRow(ctx, `SELECT widget.preview_image,widget.preview_content_type,widget.preview_width,widget.preview_height,widget.preview_updated_at FROM widgets widget JOIN assets asset ON asset.id=widget.asset_id AND asset.type='widget' AND asset.deleted_at IS NULL WHERE widget.asset_id=$1 AND widget.preview_image IS NOT NULL`, id).Scan(&image.Data, &image.ContentType, &image.Width, &image.Height, &image.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return WidgetPreviewImage{}, ErrNotFound
	}
	if err != nil {
		return WidgetPreviewImage{}, err
	}
	return image, nil
}

func widgetConfigVersion(provider string) int {
	switch provider {
	case "countdown", "ticker", "menu", "list", "table", "agenda", "metric", "cards", "weather", "spotlight", "stat_grid", "chart", "progress", "timeline":
		return 2
	default:
		return 1
	}
}

func (s *Service) DuplicateWidget(ctx context.Context, id, user uuid.UUID) (Asset, error) {
	asset, err := s.GetAsset(ctx, id)
	if err != nil || asset.Widget == nil {
		return Asset{}, ErrNotFound
	}
	configuration := asset.Widget.Configuration
	if len(asset.Widget.AuthorConfiguration) > 0 {
		configuration = asset.Widget.AuthorConfiguration
	}
	copied, err := s.CreateWidget(ctx, user, WidgetInput{Provider: asset.Widget.Provider, PresetID: asset.Widget.PresetID, Name: asset.Name + " copy", Description: asset.Description, Configuration: configuration})
	if err != nil {
		return Asset{}, err
	}
	// The copy renders exactly what the original renders, so the original's snapshot already depicts
	// it. Carrying the image over means a duplicate appears in the library with a preview instead of
	// waiting for someone to open it in the editor and save it again.
	if _, err := s.db.Exec(ctx, `UPDATE widgets copy SET preview_image=original.preview_image,preview_content_type=original.preview_content_type,preview_width=original.preview_width,preview_height=original.preview_height,preview_updated_at=original.preview_updated_at FROM widgets original WHERE copy.asset_id=$1 AND original.asset_id=$2 AND original.preview_image IS NOT NULL`, copied.ID, id); err != nil {
		return Asset{}, err
	}
	return s.GetAsset(ctx, copied.ID)
}

func (s *Service) loadWidget(ctx context.Context, id uuid.UUID) (*Widget, error) {
	var widget Widget
	err := s.db.QueryRow(ctx, `SELECT provider,preset_id,config_version,configuration,app_configuration,managed_data_source_id FROM widgets WHERE asset_id=$1`, id).Scan(&widget.Provider, &widget.PresetID, &widget.ConfigVersion, &widget.Configuration, &widget.AuthorConfiguration, &widget.ManagedDataSourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &widget, err
}

func validatePreset(provider string, presetID *string) error {
	if presetID == nil {
		return nil
	}
	allowed := map[string]string{
		"leaderboard": "list", "status_board": "cards", "queue_board": "list",
		"schedule_departures": "agenda", "opening_hours": "table", "directory": "cards",
	}
	if allowed[*presetID] != provider {
		return errors.New("widget preset is not compatible with the provider")
	}
	return nil
}
