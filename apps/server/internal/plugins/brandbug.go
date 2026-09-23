package plugins

// Brand Bug / Watermark: a persistent corner mark — logo, sponsor mark, legal
// notice, campaign badge, or location label — drawn over whatever normal
// content is playing. Unlike Countdown Bar it never reflows the content stage,
// and several instances can be on screen at once as long as they occupy
// different corners.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

const brandBugColumns = `id,name,corner,image_asset_id,text,width_percent,text_size_percent,opacity_percent,
	margin_percent,text_color,background_style,starts_at,ends_at,enabled,priority,target_scope,created_at,updated_at`

type BrandBugInput struct {
	Name         string     `json:"name"`
	Corner       string     `json:"corner"`
	Text         string     `json:"text"`
	ImageAssetID *uuid.UUID `json:"imageAssetId,omitempty"`
	// WidthPercent sizes the logo against the screen width; a text-only mark
	// uses it as its wrap width.
	WidthPercent int `json:"widthPercent"`
	// TextSizePercent is the caption's font size as a percentage of screen height.
	TextSizePercent int         `json:"textSizePercent"`
	OpacityPercent  int         `json:"opacityPercent"`
	MarginPercent   int         `json:"marginPercent"`
	TextColor       string      `json:"textColor"`
	BackgroundStyle string      `json:"backgroundStyle"`
	StartsAt        *time.Time  `json:"startsAt,omitempty"`
	EndsAt          *time.Time  `json:"endsAt,omitempty"`
	Enabled         bool        `json:"enabled"`
	Priority        int         `json:"priority"`
	TargetScope     string      `json:"targetScope"`
	TargetIDs       []uuid.UUID `json:"targetIds"`
}

type BrandBug struct {
	ID uuid.UUID `json:"id"`
	BrandBugInput
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ManifestBrandBugConfig is the Player-facing projection. ImageVariantID is
// filled in by manifest assembly, which owns media variant selection.
type ManifestBrandBugConfig struct {
	Name               string     `json:"name"`
	Corner             string     `json:"corner"`
	ImageAssetID       *uuid.UUID `json:"imageAssetId,omitempty"`
	ImageVariantID     *uuid.UUID `json:"imageVariantId,omitempty"`
	ImageAvailableFrom *time.Time `json:"imageAvailableFrom,omitempty"`
	ImageExpiresAt     *time.Time `json:"imageExpiresAt,omitempty"`
	Text               string     `json:"text,omitempty"`
	WidthPercent       int        `json:"widthPercent"`
	TextSizePercent    int        `json:"textSizePercent"`
	OpacityPercent     int        `json:"opacityPercent"`
	MarginPercent      int        `json:"marginPercent"`
	TextColor          string     `json:"textColor"`
	BackgroundStyle    string     `json:"backgroundStyle"`
	StartsAt           *time.Time `json:"startsAt,omitempty"`
	EndsAt             *time.Time `json:"endsAt,omitempty"`
	Priority           int        `json:"priority"`
}

func (s *Service) ListBrandBugs(ctx context.Context) ([]BrandBug, error) {
	rows, err := s.db.Query(ctx, `SELECT `+brandBugColumns+` FROM brand_bug_instances
		ORDER BY corner,priority DESC,lower(name),id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []BrandBug{}
	for rows.Next() {
		item, scanErr := scanBrandBug(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Targets are read after the instance cursor is drained so the listing needs
	// one pooled connection at a time.
	for index := range items {
		if items[index].TargetIDs, err = s.targetIDsFrom(ctx, "brand_bug_targets", items[index].ID); err != nil {
			return nil, err
		}
	}
	return items, nil
}

func (s *Service) GetBrandBug(ctx context.Context, id uuid.UUID) (BrandBug, error) {
	row := s.db.QueryRow(ctx, `SELECT `+brandBugColumns+` FROM brand_bug_instances WHERE id=$1`, id)
	item, err := scanBrandBug(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrandBug{}, ErrNotFound
	}
	if err != nil {
		return BrandBug{}, err
	}
	item.TargetIDs, err = s.targetIDsFrom(ctx, "brand_bug_targets", id)
	return item, err
}

func scanBrandBug(row scanner) (BrandBug, error) {
	var item BrandBug
	err := row.Scan(&item.ID, &item.Name, &item.Corner, &item.ImageAssetID, &item.Text, &item.WidthPercent,
		&item.TextSizePercent, &item.OpacityPercent, &item.MarginPercent, &item.TextColor, &item.BackgroundStyle,
		&item.StartsAt, &item.EndsAt, &item.Enabled, &item.Priority, &item.TargetScope,
		&item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func (s *Service) CreateBrandBug(ctx context.Context, userID uuid.UUID, input BrandBugInput) (BrandBug, error) {
	if err := validateBrandBug(input); err != nil {
		return BrandBug{}, err
	}
	var organizationID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		return BrandBug{}, err
	}
	id := uuid.New()
	if err := s.writeBrandBug(ctx, id, organizationID, userID, input, true); err != nil {
		return BrandBug{}, err
	}
	return s.GetBrandBug(ctx, id)
}

func (s *Service) UpdateBrandBug(ctx context.Context, id, userID uuid.UUID, input BrandBugInput) (BrandBug, error) {
	if err := validateBrandBug(input); err != nil {
		return BrandBug{}, err
	}
	if err := s.writeBrandBug(ctx, id, uuid.Nil, userID, input, false); err != nil {
		return BrandBug{}, err
	}
	return s.GetBrandBug(ctx, id)
}

func (s *Service) writeBrandBug(ctx context.Context, id, organizationID, userID uuid.UUID, input BrandBugInput, create bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err = LockInstallation(ctx, tx, BrandBugID); err != nil {
		return err
	}
	if err = validateTargets(ctx, tx, input.TargetScope, input.TargetIDs); err != nil {
		return err
	}
	if err = validateBrandBugImage(ctx, tx, input.ImageAssetID); err != nil {
		return err
	}
	text := strings.TrimSpace(input.Text)
	if create {
		_, err = tx.Exec(ctx, `INSERT INTO brand_bug_instances
			(id,organization_id,name,corner,image_asset_id,text,width_percent,text_size_percent,opacity_percent,
			 margin_percent,text_color,background_style,starts_at,ends_at,enabled,priority,target_scope,created_by)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			id, organizationID, strings.TrimSpace(input.Name), input.Corner, input.ImageAssetID, text,
			input.WidthPercent, input.TextSizePercent, input.OpacityPercent, input.MarginPercent,
			strings.ToLower(input.TextColor), input.BackgroundStyle, input.StartsAt, input.EndsAt,
			input.Enabled, input.Priority, input.TargetScope, userID)
	} else {
		tag, updateErr := tx.Exec(ctx, `UPDATE brand_bug_instances SET name=$2,corner=$3,image_asset_id=$4,text=$5,
			width_percent=$6,text_size_percent=$7,opacity_percent=$8,margin_percent=$9,text_color=$10,
			background_style=$11,starts_at=$12,ends_at=$13,enabled=$14,priority=$15,target_scope=$16,updated_at=now()
			WHERE id=$1`,
			id, strings.TrimSpace(input.Name), input.Corner, input.ImageAssetID, text,
			input.WidthPercent, input.TextSizePercent, input.OpacityPercent, input.MarginPercent,
			strings.ToLower(input.TextColor), input.BackgroundStyle, input.StartsAt, input.EndsAt,
			input.Enabled, input.Priority, input.TargetScope)
		err = updateErr
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM brand_bug_targets WHERE instance_id=$1`, id); err != nil {
		return err
	}
	for _, targetID := range input.TargetIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO brand_bug_targets(instance_id,target_type,target_id) VALUES($1,$2,$3)`,
			id, input.TargetScope, targetID); err != nil {
			return err
		}
	}
	action := "plugin.brand_bug.updated"
	if create {
		action = "plugin.brand_bug.created"
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,'plugin',$4)`,
		uuid.New(), userID, action, id.String()); err != nil {
		return err
	}
	notes, err := s.bumpPlugin(ctx, tx, "brand_bug", id, "plugin.brand_bug.changed")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func (s *Service) DeleteBrandBug(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `DELETE FROM brand_bug_instances WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)
		VALUES($1,$2,'plugin.brand_bug.deleted','plugin',$3)`, uuid.New(), userID, id.String()); err != nil {
		return err
	}
	notes, err := s.bumpPlugin(ctx, tx, "brand_bug", id, "plugin.brand_bug.deleted")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func validateBrandBug(input BrandBugInput) error {
	name := strings.TrimSpace(input.Name)
	text := strings.TrimSpace(input.Text)
	if len(name) < 1 || len(name) > 180 || len(text) > 180 {
		return fmt.Errorf("%w: name or text is outside its allowed length", ErrInvalid)
	}
	// A mark with no logo and no caption would hold a corner invisibly.
	if input.ImageAssetID == nil && text == "" {
		return fmt.Errorf("%w: choose a logo image, enter text, or both", ErrInvalid)
	}
	if input.ImageAssetID != nil && *input.ImageAssetID == uuid.Nil {
		return fmt.Errorf("%w: imageAssetId is not a valid asset", ErrInvalid)
	}
	switch input.Corner {
	case "top_left", "top_right", "bottom_left", "bottom_right":
	default:
		return fmt.Errorf("%w: corner must be top_left, top_right, bottom_left, or bottom_right", ErrInvalid)
	}
	if input.BackgroundStyle != "none" && input.BackgroundStyle != "scrim" {
		return fmt.Errorf("%w: backgroundStyle must be none or scrim", ErrInvalid)
	}
	if !hexColor.MatchString(input.TextColor) {
		return fmt.Errorf("%w: textColor must be a #RRGGBB value", ErrInvalid)
	}
	if input.WidthPercent < 2 || input.WidthPercent > 40 ||
		input.TextSizePercent < 1 || input.TextSizePercent > 12 ||
		input.OpacityPercent < 10 || input.OpacityPercent > 100 ||
		input.MarginPercent < 0 || input.MarginPercent > 20 ||
		input.Priority < -1000 || input.Priority > 1000 {
		return fmt.Errorf("%w: size, opacity, margin, or priority is outside its allowed range", ErrInvalid)
	}
	if input.StartsAt != nil && input.EndsAt != nil && !input.EndsAt.After(*input.StartsAt) {
		return fmt.Errorf("%w: endsAt must be after startsAt", ErrInvalid)
	}
	return validateTargeting(input.TargetScope, input.TargetIDs)
}

// validateBrandBugImage refuses a logo that is missing, deleted, still
// processing, or not an image, so a saved mark cannot reference media the
// manifest will fail to project later.
func validateBrandBugImage(ctx context.Context, tx pgx.Tx, assetID *uuid.UUID) error {
	if assetID == nil {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets
		WHERE id=$1 AND type='image' AND processing_status='ready' AND deleted_at IS NULL)`, assetID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: the logo image is not a ready image asset", ErrInvalid)
	}
	return nil
}

func (s *Service) brandBugsForScreen(ctx context.Context, screenID uuid.UUID) ([]ManifestPlugin, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT i.id,i.name,i.corner,i.image_asset_id,i.text,i.width_percent,
		i.text_size_percent,i.opacity_percent,i.margin_percent,i.text_color,i.background_style,i.starts_at,i.ends_at,i.priority
		`+targetScopeFilter("brand_bug_instances", "brand_bug_targets")+`
		ORDER BY i.priority DESC,i.id`, screenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManifestPlugin{}
	for rows.Next() {
		var id uuid.UUID
		var config ManifestBrandBugConfig
		if err = rows.Scan(&id, &config.Name, &config.Corner, &config.ImageAssetID, &config.Text,
			&config.WidthPercent, &config.TextSizePercent, &config.OpacityPercent, &config.MarginPercent,
			&config.TextColor, &config.BackgroundStyle, &config.StartsAt, &config.EndsAt, &config.Priority); err != nil {
			return nil, err
		}
		out = append(out, ManifestPlugin{ID: id, Type: "brand_bug", Version: 1, Config: &config})
	}
	return out, rows.Err()
}
