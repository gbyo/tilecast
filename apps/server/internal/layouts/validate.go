package layouts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

var (
	colorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$`)
	fieldPattern = regexp.MustCompile(`^[A-Za-z0-9_]{1,80}$`)
)

func ValidateDocument(document Document) error {
	if document.SchemaVersion != 2 {
		return errors.New("layout schemaVersion must be 2")
	}
	canvas := document.Canvas
	if canvas.Width < 320 || canvas.Width > 7680 || canvas.Height < 320 || canvas.Height > 7680 {
		return errors.New("layout canvas dimensions must be between 320 and 7680 pixels")
	}
	if canvas.Orientation != "landscape" && canvas.Orientation != "portrait" && canvas.Orientation != "custom" {
		return errors.New("layout canvas orientation is invalid")
	}
	if canvas.Orientation == "landscape" && canvas.Width <= canvas.Height {
		return errors.New("landscape layouts must be wider than they are tall")
	}
	if canvas.Orientation == "portrait" && canvas.Height <= canvas.Width {
		return errors.New("portrait layouts must be taller than they are wide")
	}
	if !validColor(canvas.BackgroundColor) {
		return errors.New("layout background color is invalid")
	}
	if !finite(canvas.SafeAreaPercent) || canvas.SafeAreaPercent < 0 || canvas.SafeAreaPercent > 20 {
		return errors.New("layout safe area must be between 0 and 20 percent")
	}
	if canvas.BackgroundVariantID != nil && canvas.BackgroundAssetID == nil {
		return errors.New("layout backgroundVariantId requires backgroundAssetId")
	}
	if len(document.Placements) > 200 {
		return errors.New("layouts may contain at most 200 placements")
	}
	ids := make(map[uuid.UUID]bool, len(document.Placements))
	groups := map[uuid.UUID]bool{}
	for index, placement := range document.Placements {
		if placement.ID == uuid.Nil || ids[placement.ID] {
			return fmt.Errorf("layout placement %d has a missing or duplicate id", index+1)
		}
		ids[placement.ID] = true
		if placement.Primitive != nil && placement.Primitive.Kind == "group" {
			groups[placement.ID] = true
		}
		if err := validatePlacement(placement, canvas); err != nil {
			return fmt.Errorf("layout placement %d: %w", index+1, err)
		}
	}
	for _, placement := range document.Placements {
		if placement.GroupID != nil && (!groups[*placement.GroupID] || *placement.GroupID == placement.ID) {
			return errors.New("layout placement references an invalid group")
		}
	}
	return nil
}

func validatePlacement(p Placement, canvas Canvas) error {
	if p.Type != "widget" && p.Type != "asset" && p.Type != "playlistZone" && p.Type != "primitive" {
		return errors.New("type is invalid")
	}
	if name := strings.TrimSpace(p.Name); name == "" || len(name) > 120 {
		return errors.New("name must be between 1 and 120 characters")
	}
	if !finite(p.X) || !finite(p.Y) || !finite(p.Width) || !finite(p.Height) || p.X < 0 || p.Y < 0 || p.Width <= 0 || p.Height <= 0 || p.X+p.Width > float64(canvas.Width)+0.001 || p.Y+p.Height > float64(canvas.Height)+0.001 {
		return errors.New("bounds must fit inside the canvas")
	}
	if p.Layer < 0 || p.Layer > 999 || !finite(p.Opacity) || p.Opacity < 0 || p.Opacity > 1 {
		return errors.New("layer or opacity is invalid")
	}
	if len(p.Overrides) > 4096 || (len(p.Overrides) > 0 && !json.Valid(p.Overrides)) {
		return errors.New("presentation overrides are invalid")
	}
	if p.Type == "widget" && len(p.Overrides) > 0 {
		var overrides struct {
			Fit                string `json:"fit"`
			Alignment          string `json:"alignment"`
			ForegroundColor    string `json:"foregroundColor"`
			BackgroundColor    string `json:"backgroundColor"`
			FallbackVisibility string `json:"fallbackVisibility"`
			Muted              *bool  `json:"muted"`
		}
		decoder := json.NewDecoder(bytes.NewReader(p.Overrides))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&overrides); err != nil {
			return errors.New("Widget placement contains unsupported overrides")
		}
		if overrides.Fit != "" && overrides.Fit != "contain" && overrides.Fit != "cover" && overrides.Fit != "stretch" {
			return errors.New("Widget placement fit override is invalid")
		}
		if overrides.Alignment != "" && overrides.Alignment != "left" && overrides.Alignment != "center" && overrides.Alignment != "right" {
			return errors.New("Widget placement alignment override is invalid")
		}
		if overrides.ForegroundColor != "" && !validColor(overrides.ForegroundColor) || overrides.BackgroundColor != "" && !validColor(overrides.BackgroundColor) {
			return errors.New("Widget placement color override is invalid")
		}
		if overrides.FallbackVisibility != "" && overrides.FallbackVisibility != "show" && overrides.FallbackVisibility != "hide" {
			return errors.New("Widget placement fallback override is invalid")
		}
	}
	if p.VariantID != nil && (p.Type != "asset" || p.AssetID == nil) {
		return errors.New("variantId is only valid for asset placements")
	}
	references := 0
	if p.WidgetID != nil {
		references++
	}
	if p.AssetID != nil {
		references++
	}
	if p.PlaylistID != nil {
		references++
	}
	if p.Primitive != nil {
		references++
	}
	if references != 1 {
		return errors.New("must contain exactly one typed reference")
	}
	switch p.Type {
	case "widget":
		if p.WidgetID == nil {
			return errors.New("Widget placement requires widgetId")
		}
	case "asset":
		if p.AssetID == nil {
			return errors.New("asset placement requires assetId")
		}
	case "playlistZone":
		if p.PlaylistID == nil {
			return errors.New("playlist zone requires playlistId")
		}
	case "primitive":
		if p.Primitive == nil {
			return errors.New("primitive placement requires primitive")
		}
		if err := validatePrimitive(*p.Primitive); err != nil {
			return err
		}
	}
	if p.Playback != nil {
		if p.Playback.Fit != "" && p.Playback.Fit != "contain" && p.Playback.Fit != "cover" && p.Playback.Fit != "stretch" {
			return errors.New("playback fit is invalid")
		}
		if p.Playback.Fallback != "" && p.Playback.Fallback != "hide" && p.Playback.Fallback != "background" && p.Playback.Fallback != "previous" {
			return errors.New("playback fallback is invalid")
		}
		if !finite(p.Playback.CornerRadius) || p.Playback.CornerRadius < 0 || p.Playback.CornerRadius > 1000 {
			return errors.New("playback corner radius is invalid")
		}
	}
	return nil
}

func validatePrimitive(p Primitive) error {
	if p.Kind != "text" && p.Kind != "rectangle" && p.Kind != "circle" && p.Kind != "line" && p.Kind != "group" {
		return errors.New("primitive kind is invalid")
	}
	if len(p.Text) > 4000 || len(p.FontFamily) > 40 {
		return errors.New("primitive text is too long")
	}
	if p.FontID != nil && (p.Kind != "text" || *p.FontID == uuid.Nil) {
		return errors.New("only text primitives may choose a library font")
	}
	if p.Kind == "text" {
		if p.FontFamily != "" && p.FontFamily != "Inter" && p.FontFamily != "Roboto" && p.FontFamily != "Source Sans 3" && p.FontFamily != "Noto Sans" {
			return errors.New("text font is not bundled")
		}
		if p.FontSize != 0 && (!finite(p.FontSize) || p.FontSize < 8 || p.FontSize > 600) {
			return errors.New("text font size is invalid")
		}
		if p.FontWeight != 0 && p.FontWeight != 400 && p.FontWeight != 500 && p.FontWeight != 600 && p.FontWeight != 700 && p.FontWeight != 800 {
			return errors.New("text weight is invalid")
		}
	}
	for _, color := range []string{p.Color, p.BackgroundColor, p.BorderColor, p.FillColor, p.StrokeColor} {
		if color != "" && !validColor(color) {
			return errors.New("primitive color is invalid")
		}
	}
	if p.Binding != nil {
		if len(p.Binding.Prefix) > 500 || len(p.Binding.Suffix) > 500 || len(p.Binding.FallbackText) > 500 {
			return errors.New("structured binding text is too long")
		}
		if p.Binding.DataSourceID == uuid.Nil || !fieldPattern.MatchString(p.Binding.Field) {
			return errors.New("structured binding is invalid")
		}
		if p.Binding.Format != "" && p.Binding.Format != "text" && p.Binding.Format != "date-short" && p.Binding.Format != "date-long" && p.Binding.Format != "number" && p.Binding.Format != "integer" && p.Binding.Format != "currency" {
			return errors.New("structured binding format is invalid")
		}
	}
	return nil
}

func validColor(value string) bool { return colorPattern.MatchString(value) }
func finite(value float64) bool    { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func Dependencies(document Document) []Dependency {
	seen := map[string]bool{}
	result := []Dependency{}
	add := func(kind string, id *uuid.UUID) {
		if id == nil || *id == uuid.Nil {
			return
		}
		key := kind + ":" + id.String()
		if !seen[key] {
			seen[key] = true
			result = append(result, Dependency{Type: kind, ID: *id})
		}
	}
	add("asset", document.Canvas.BackgroundAssetID)
	for _, placement := range document.Placements {
		add("widget", placement.WidgetID)
		add("asset", placement.AssetID)
		add("playlist", placement.PlaylistID)
		if placement.Primitive != nil && placement.Primitive.Binding != nil {
			id := placement.Primitive.Binding.DataSourceID
			add("data_source", &id)
		}
		if placement.Primitive != nil {
			add("font", placement.Primitive.FontID)
		}
	}
	return result
}
