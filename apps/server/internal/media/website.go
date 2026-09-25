package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
)

type WebsitePolicy struct {
	AllowPrivateHTTP                                                                          bool
	DefaultTimeoutSeconds, MaxTimeoutSeconds, MinRefreshSeconds, MaxAllowedHosts, MaxWebsites int
}

var colorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
var hostPattern = regexp.MustCompile(`^[A-Za-z0-9.-]+$`)

func (in *WebsiteInput) UnmarshalJSON(data []byte) error {
	type alias WebsiteInput
	var decoded alias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*in = WebsiteInput(decoded)
	_, in.javascriptSet = fields["javascriptEnabled"]
	_, in.domStorageSet = fields["domStorageEnabled"]
	return nil
}

type websiteAuthoringDefaults struct {
	javascriptEnabled     bool
	domStorageEnabled     bool
	timeoutSeconds        int
	cookiePolicy          string
	reloadPolicy          string
	minimumRefreshSeconds int
	failureBehavior       string
	zoomPercent           int
	fallbackImageAssetID  *uuid.UUID
}

// websiteDefaults reads the same organization-scoped registry values that are
// sent in PlayerConfig. Keeping the authoring defaults here means a website
// created by an API client that omits an optional field and a website rendered
// by a player use one contract. A missing runtime-settings row is treated as a
// fresh installation and uses the documented registry defaults.
func (s *Service) websiteDefaults(ctx context.Context) (websiteAuthoringDefaults, error) {
	defaults := websiteAuthoringDefaults{
		javascriptEnabled:     true,
		domStorageEnabled:     true,
		timeoutSeconds:        s.cfg.Website.DefaultTimeoutSeconds,
		cookiePolicy:          "first_party",
		reloadPolicy:          "on_each_activation",
		minimumRefreshSeconds: s.cfg.Website.MinRefreshSeconds,
		failureBehavior:       "placeholder",
		zoomPercent:           100,
	}
	if s.db == nil {
		return defaults, nil
	}
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT settings FROM organization_runtime_settings LIMIT 1`).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return defaults, nil
		}
		return defaults, err
	}
	var values map[string]any
	if err := json.Unmarshal(raw, &values); err != nil {
		return defaults, err
	}
	if value, ok := values["website.default_javascript"].(bool); ok {
		defaults.javascriptEnabled = value
	}
	if value, ok := values["website.default_dom_storage"].(bool); ok {
		defaults.domStorageEnabled = value
	}
	if value, ok := values["website.default_timeout_seconds"].(float64); ok && value >= 1 {
		defaults.timeoutSeconds = int(value)
	}
	if value, ok := values["website.default_cookie_policy"].(string); ok && value != "" {
		defaults.cookiePolicy = value
	}
	if value, ok := values["website.default_reload_policy"].(string); ok && value != "" {
		defaults.reloadPolicy = value
	}
	if value, ok := values["website.minimum_refresh_seconds"].(float64); ok && value >= 1 {
		defaults.minimumRefreshSeconds = int(value)
	}
	if value, ok := values["website.default_failure_behavior"].(string); ok && value != "" {
		defaults.failureBehavior = value
	}
	if value, ok := values["website.default_zoom_percent"].(float64); ok && value >= 1 {
		defaults.zoomPercent = int(value)
	}
	if value, ok := values["website.default_fallback_image_id"].(string); ok && strings.TrimSpace(value) != "" {
		id, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return defaults, errors.New("website default fallback image id is invalid")
		}
		defaults.fallbackImageAssetID = &id
	}
	return defaults, nil
}

func validWebsiteHost(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return true
	}
	return len(host) <= 253 && hostPattern.MatchString(host) && !strings.Contains(host, "..") && !strings.HasPrefix(host, ".") && !strings.HasSuffix(host, ".")
}

func (s *Service) normalizeWebsite(ctx context.Context, in WebsiteInput) (WebsiteInput, error) {
	defaults, err := s.websiteDefaults(ctx)
	if err != nil {
		return in, err
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	in.URL = strings.TrimSpace(in.URL)
	if len(in.Name) < 1 || len(in.Name) > 180 {
		return in, errors.New("name must be between 1 and 180 characters")
	}
	if len(in.Description) > 2000 {
		return in, errors.New("description must be at most 2000 characters")
	}
	if len(in.URL) < 1 || len(in.URL) > 2048 {
		return in, errors.New("website URL must be between 1 and 2048 characters")
	}
	u, err := url.Parse(in.URL)
	if err != nil || u.Hostname() == "" || u.User != nil {
		return in, errors.New("website URL must have a valid host and no embedded credentials")
	}
	u.Fragment = ""
	if u.Scheme != "https" {
		if u.Scheme != "http" || !s.cfg.Website.AllowPrivateHTTP || !privateHost(u.Hostname()) {
			return in, errors.New("website URL must use HTTPS unless private HTTP is explicitly enabled")
		}
	}
	if u.Port() != "" {
		port := u.Port()
		if (u.Scheme == "https" && port != "443") || (u.Scheme == "http" && port != "80") {
			return in, errors.New("website URL uses a port not permitted by policy")
		}
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if !validWebsiteHost(host) {
		return in, errors.New("website URL host is invalid")
	}
	allowed := map[string]bool{host: true}
	for _, raw := range in.AllowedHosts {
		h := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(raw, ".")))
		if h == "" || strings.ContainsAny(h, "/:*@") || !validWebsiteHost(h) {
			return in, errors.New("allowed hosts must be exact host names or canonical IP addresses")
		}
		allowed[h] = true
	}
	if len(allowed) > s.cfg.Website.MaxAllowedHosts {
		return in, errors.New("allowed host count exceeds the configured limit")
	}
	in.AllowedHosts = in.AllowedHosts[:0]
	for h := range allowed {
		in.AllowedHosts = append(in.AllowedHosts, h)
	}
	sort.Strings(in.AllowedHosts)
	if in.LoadTimeoutSeconds == 0 {
		in.LoadTimeoutSeconds = defaults.timeoutSeconds
	}
	if in.LoadTimeoutSeconds < 1 || in.LoadTimeoutSeconds > s.cfg.Website.MaxTimeoutSeconds {
		return in, errors.New("load timeout is outside the configured range")
	}
	if in.ZoomPercent == 0 {
		in.ZoomPercent = defaults.zoomPercent
	}
	if in.ZoomPercent < 50 || in.ZoomPercent > 200 {
		return in, errors.New("zoom must be between 50 and 200 percent")
	}
	if in.ScrollX < 0 || in.ScrollX > 100000 || in.ScrollY < 0 || in.ScrollY > 100000 {
		return in, errors.New("scroll positions must be between 0 and 100000")
	}
	if len(in.CustomUserAgent) > 512 {
		return in, errors.New("custom user agent must be at most 512 characters")
	}
	for _, r := range in.CustomUserAgent {
		if unicode.IsControl(r) {
			return in, errors.New("custom user agent must not contain control characters")
		}
	}
	if in.CookiePolicy == "" {
		in.CookiePolicy = defaults.cookiePolicy
	}
	if in.CookiePolicy != "disabled" && in.CookiePolicy != "first_party" && in.CookiePolicy != "first_and_third_party" {
		return in, errors.New("cookie policy is invalid")
	}
	if in.ReloadPolicy == "" {
		in.ReloadPolicy = defaults.reloadPolicy
	}
	if in.ReloadPolicy != "load_once" && in.ReloadPolicy != "on_each_activation" && in.ReloadPolicy != "interval" {
		return in, errors.New("reload policy is invalid")
	}
	if in.ReloadPolicy == "interval" {
		if in.RefreshIntervalSeconds == nil || *in.RefreshIntervalSeconds < defaults.minimumRefreshSeconds || *in.RefreshIntervalSeconds > 86400 {
			return in, errors.New("refresh interval is outside the configured range")
		}
	} else {
		in.RefreshIntervalSeconds = nil
	}
	if in.FailureBehavior == "" {
		in.FailureBehavior = defaults.failureBehavior
	}
	if in.FailureBehavior != "last_success" && in.FailureBehavior != "placeholder" && in.FailureBehavior != "fallback_image" && in.FailureBehavior != "skip" {
		return in, errors.New("failure behavior is invalid")
	}
	if in.BackgroundColor == "" {
		in.BackgroundColor = "#13231E"
	}
	if !colorPattern.MatchString(in.BackgroundColor) {
		return in, errors.New("background color must be a six-digit hex color")
	}
	if in.FallbackImageAssetID == nil && defaults.fallbackImageAssetID != nil {
		in.FallbackImageAssetID = defaults.fallbackImageAssetID
	}
	if in.FallbackImageAssetID != nil {
		var ok bool
		if err = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND type='image' AND processing_status='ready' AND deleted_at IS NULL)`, *in.FallbackImageAssetID).Scan(&ok); err != nil {
			return in, err
		}
		if !ok {
			return in, errors.New("fallback asset must be a ready image")
		}
	}
	if in.FailureBehavior == "fallback_image" && in.FallbackImageAssetID == nil {
		return in, errors.New("fallback image behavior requires a fallback image")
	}
	in.DisplayURL = u.String()
	in.URL = u.String()
	if !in.javascriptSet && !in.JavaScriptEnabled {
		in.JavaScriptEnabled = defaults.javascriptEnabled
	}
	if !in.domStorageSet && !in.DOMStorageEnabled {
		in.DOMStorageEnabled = defaults.domStorageEnabled
	}
	return in, nil
}
func privateHost(host string) bool {
	h := strings.ToLower(host)
	if h == "localhost" || strings.HasSuffix(h, ".local") {
		return true
	}
	ip, err := netip.ParseAddr(h)
	return err == nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())
}

func (s *Service) CreateWebsite(ctx context.Context, user uuid.UUID, in WebsiteInput) (Asset, error) {
	in, err := s.normalizeWebsite(ctx, in)
	if err != nil {
		return Asset{}, err
	}
	var count int
	if err = s.db.QueryRow(ctx, `SELECT count(*) FROM widgets s JOIN assets a ON a.id=s.asset_id WHERE s.provider='website' AND a.deleted_at IS NULL`).Scan(&count); err != nil {
		return Asset{}, err
	}
	if count >= s.cfg.Website.MaxWebsites {
		return Asset{}, errors.New("website asset count exceeds the configured limit")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback(ctx)
	var org uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&org); err != nil {
		return Asset{}, err
	}
	id := ids.New(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO assets(id,organization_id,name,description,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,$3,$4,'widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$5)`, id, org, in.Name, in.Description, user)
	if err != nil {
		return Asset{}, err
	}
	if err = insertWebsite(ctx, tx, id, in); err != nil {
		return Asset{}, err
	}
	configuration, _ := json.Marshal(in.WebsiteConfig)
	if _, err = tx.Exec(ctx, `INSERT INTO widgets(asset_id,provider,config_version,configuration) VALUES($1,'website',1,$2::jsonb)`, id, string(configuration)); err != nil {
		return Asset{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'widget.created','widget',$3)`, uuid.New(), user, id.String())
	if err != nil {
		return Asset{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	return s.GetAsset(ctx, id)
}
func insertWebsite(ctx context.Context, tx pgx.Tx, id uuid.UUID, in WebsiteInput) error {
	_, err := tx.Exec(ctx, `INSERT INTO website_assets(asset_id,url,display_url,allowed_hosts,javascript_enabled,dom_storage_enabled,cookie_policy,reload_policy,refresh_interval_seconds,load_timeout_seconds,zoom_percent,scroll_x,scroll_y,custom_user_agent,background_color,failure_behavior,fallback_image_asset_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, id, in.URL, in.DisplayURL, in.AllowedHosts, in.JavaScriptEnabled, in.DOMStorageEnabled, in.CookiePolicy, in.ReloadPolicy, in.RefreshIntervalSeconds, in.LoadTimeoutSeconds, in.ZoomPercent, in.ScrollX, in.ScrollY, in.CustomUserAgent, in.BackgroundColor, in.FailureBehavior, in.FallbackImageAssetID)
	return err
}
func (s *Service) UpdateWebsite(ctx context.Context, id, user uuid.UUID, in WebsiteInput) (Asset, error) {
	in, err := s.normalizeWebsite(ctx, in)
	if err != nil {
		return Asset{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE assets SET name=$2,description=$3,updated_at=now() WHERE id=$1 AND type='widget' AND deleted_at IS NULL`, id, in.Name, in.Description)
	if err != nil {
		return Asset{}, err
	}
	if tag.RowsAffected() == 0 {
		return Asset{}, ErrNotFound
	}
	_, err = tx.Exec(ctx, `UPDATE website_assets SET url=$2,display_url=$3,allowed_hosts=$4,javascript_enabled=$5,dom_storage_enabled=$6,cookie_policy=$7,reload_policy=$8,refresh_interval_seconds=$9,load_timeout_seconds=$10,zoom_percent=$11,scroll_x=$12,scroll_y=$13,custom_user_agent=$14,background_color=$15,failure_behavior=$16,fallback_image_asset_id=$17,updated_at=now() WHERE asset_id=$1`, id, in.URL, in.DisplayURL, in.AllowedHosts, in.JavaScriptEnabled, in.DOMStorageEnabled, in.CookiePolicy, in.ReloadPolicy, in.RefreshIntervalSeconds, in.LoadTimeoutSeconds, in.ZoomPercent, in.ScrollX, in.ScrollY, in.CustomUserAgent, in.BackgroundColor, in.FailureBehavior, in.FallbackImageAssetID)
	if err != nil {
		return Asset{}, err
	}
	configuration, _ := json.Marshal(in.WebsiteConfig)
	if _, err = tx.Exec(ctx, `UPDATE widgets SET configuration=$2::jsonb,config_version=1,preview_image=NULL,preview_content_type=NULL,preview_width=NULL,preview_height=NULL,preview_updated_at=NULL,updated_at=now() WHERE asset_id=$1 AND provider='website'`, id, string(configuration)); err != nil {
		return Asset{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'widget.updated','widget',$3)`, uuid.New(), user, id.String())
	if err != nil {
		return Asset{}, err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if transactional, ok := s.invalidator.(TransactionalAssetInvalidator); ok {
		transactionalUsed = true
		changes, err = transactional.AssetChangedInTx(ctx, tx, id, "website.updated")
		if err != nil {
			return Asset{}, fmt.Errorf("invalidate website manifest: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	if transactionalUsed {
		s.invalidator.(TransactionalAssetInvalidator).NotifyManifestChanges(changes)
	} else if s.invalidator != nil {
		if err := s.invalidator.AssetChanged(ctx, id, "website.updated"); err != nil {
			return Asset{}, fmt.Errorf("invalidate website manifest: %w", err)
		}
	}
	return s.GetAsset(ctx, id)
}
func (s *Service) loadWebsite(ctx context.Context, id uuid.UUID) (*WebsiteConfig, error) {
	var configuration []byte
	if err := s.db.QueryRow(ctx, `SELECT configuration FROM widgets WHERE asset_id=$1 AND provider='website'`, id).Scan(&configuration); err == nil {
		var website WebsiteConfig
		if err = json.Unmarshal(configuration, &website); err != nil {
			return nil, err
		}
		return &website, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var w WebsiteConfig
	err := s.db.QueryRow(ctx, `SELECT url,display_url,allowed_hosts,javascript_enabled,dom_storage_enabled,cookie_policy,reload_policy,refresh_interval_seconds,load_timeout_seconds,zoom_percent,scroll_x,scroll_y,custom_user_agent,background_color,failure_behavior,fallback_image_asset_id,created_at,updated_at FROM website_assets WHERE asset_id=$1`, id).Scan(&w.URL, &w.DisplayURL, &w.AllowedHosts, &w.JavaScriptEnabled, &w.DOMStorageEnabled, &w.CookiePolicy, &w.ReloadPolicy, &w.RefreshIntervalSeconds, &w.LoadTimeoutSeconds, &w.ZoomPercent, &w.ScrollX, &w.ScrollY, &w.CustomUserAgent, &w.BackgroundColor, &w.FailureBehavior, &w.FallbackImageAssetID, &w.CreatedAt, &w.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &w, err
}
func (s *Service) WebsiteDiagnostics(ctx context.Context, id uuid.UUID) (WebsiteDiagnostics, error) {
	asset, err := s.GetAsset(ctx, id)
	if err != nil || asset.Website == nil {
		return WebsiteDiagnostics{}, ErrNotFound
	}
	d := WebsiteDiagnostics{AssetID: id, ConfiguredURL: asset.Website.DisplayURL, AllowedHosts: asset.Website.AllowedHosts, FallbackImageAssetID: asset.Website.FallbackImageAssetID, ReportingScreens: []WebsiteReportingScreen{}}
	rows, err := s.db.Query(ctx, `SELECT sc.id,sc.name,COALESCE(ps.website_state,''),ps.website_current_host,ps.website_load_completed_at,ps.website_failure_at,ps.website_failure_category FROM screen_player_status ps JOIN screens sc ON sc.id=ps.screen_id WHERE ps.current_website_asset_id=$1 OR ps.last_website_asset_id=$1 ORDER BY sc.name`, id)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	for rows.Next() {
		var x WebsiteReportingScreen
		var success, failure *time.Time
		var category *string
		if err = rows.Scan(&x.ID, &x.Name, &x.State, &x.Host, &success, &failure, &category); err != nil {
			return d, err
		}
		d.ReportingScreens = append(d.ReportingScreens, x)
		if success != nil && (d.LastSuccessfulLoad == nil || success.After(*d.LastSuccessfulLoad)) {
			d.LastSuccessfulLoad = success
		}
		if failure != nil && (d.LastFailure == nil || failure.After(*d.LastFailure)) {
			d.LastFailure = failure
			d.LastFailureCategory = category
		}
	}
	return d, rows.Err()
}
