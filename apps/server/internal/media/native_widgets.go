package media

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
)

var widgetColorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

type metricWidgetProvider struct{ service *Service }

func (p metricWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c MetricWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndTypedFields(ctx, c.DataSourceID)
	if err != nil || !p.service.dataSourceProviderAccepted("metric", provider) {
		return nil, errors.New("metric requires a numeric record-based data Source")
	}
	numeric := map[string]bool{"number": true, "integer": true, "percent": true, "currency": true}
	if c.ValueField == "" || !numeric[fields[c.ValueField]] {
		return nil, errors.New("metric value field must be numeric")
	}
	for _, field := range []string{c.LabelField, c.SecondaryField} {
		if field != "" {
			if _, ok := fields[field]; !ok {
				return nil, errors.New("metric field is not provided by the selected data Source")
			}
		}
	}
	c.Label = sanitizeCalendarText(c.Label, 120)
	c.Prefix = sanitizeCalendarText(c.Prefix, 20)
	c.Suffix = sanitizeCalendarText(c.Suffix, 20)
	c.EmptyState = sanitizeCalendarText(c.EmptyState, 240)
	if c.EmptyState == "" {
		c.EmptyState = "No value available"
	}
	if c.Format == "" {
		c.Format = "number"
	}
	if !map[string]bool{"number": true, "integer": true, "percent": true, "currency": true}[c.Format] || c.Precision < 0 || c.Precision > 6 {
		return nil, errors.New("metric format is invalid")
	}
	if c.Alignment == "" {
		c.Alignment = "center"
	}
	if c.Alignment != "left" && c.Alignment != "center" && c.Alignment != "right" {
		return nil, errors.New("metric alignment is invalid")
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type spotlightWidgetProvider struct{ service *Service }

func (p spotlightWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c SpotlightWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndFields(ctx, c.DataSourceID)
	if err != nil || !p.service.dataSourceProviderAccepted("spotlight", provider) {
		return nil, errors.New("spotlight requires a record-based data Source")
	}
	if c.TitleField == "" || !fields[c.TitleField] {
		return nil, errors.New("spotlight title field is invalid")
	}
	for _, field := range []string{c.SubtitleField, c.BodyField, c.BadgeField, c.DateField} {
		if field != "" && !fields[field] {
			return nil, errors.New("spotlight field is not provided by the selected data Source")
		}
	}
	if c.ImageAssetID != nil {
		var ready bool
		err = p.service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND type='image' AND processing_status='ready' AND deleted_at IS NULL)`, *c.ImageAssetID).Scan(&ready)
		if err != nil || !ready {
			return nil, errors.New("spotlight image is unavailable")
		}
	}
	if err := normalizeVisualConfig(&c.WidgetVisualConfig); err != nil {
		return nil, err
	}
	return c, nil
}

type statGridWidgetProvider struct{ service *Service }

func (p statGridWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c StatGridWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndTypedFields(ctx, c.DataSourceID)
	if err != nil || !p.service.dataSourceProviderAccepted("stat_grid", provider) {
		return nil, errors.New("stat grid requires a numeric data Source")
	}
	if len(c.Metrics) < 1 || len(c.Metrics) > 12 || c.Columns < 1 || c.Columns > 4 {
		return nil, errors.New("stat grid supports 1 to 12 metrics and 1 to 4 columns")
	}
	for index := range c.Metrics {
		metric := &c.Metrics[index]
		if !isNumericField(fields[metric.ValueField]) {
			return nil, errors.New("stat grid value fields must be numeric")
		}
		if metric.LabelField != "" {
			if _, ok := fields[metric.LabelField]; !ok {
				return nil, errors.New("stat grid label field is unavailable")
			}
		}
		metric.Label = sanitizeCalendarText(metric.Label, 80)
		metric.Prefix = sanitizeCalendarText(metric.Prefix, 20)
		metric.Suffix = sanitizeCalendarText(metric.Suffix, 20)
		if metric.Format == "" {
			metric.Format = "number"
		}
		if !isNumericField(metric.Format) || metric.Precision < 0 || metric.Precision > 6 {
			return nil, errors.New("stat grid metric format is invalid")
		}
	}
	if err := normalizeVisualConfig(&c.WidgetVisualConfig); err != nil {
		return nil, err
	}
	return c, nil
}

type chartWidgetProvider struct{ service *Service }

func (p chartWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c ChartWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndTypedFields(ctx, c.DataSourceID)
	if err != nil || !p.service.dataSourceProviderAccepted("chart", provider) {
		return nil, errors.New("chart requires a numeric data Source")
	}
	if c.ChartType == "" {
		c.ChartType = "line"
	}
	if c.ChartType != "line" && c.ChartType != "bar" && c.ChartType != "donut" {
		return nil, errors.New("chart type is invalid")
	}
	if len(c.Series) < 1 || len(c.Series) > 4 {
		return nil, errors.New("chart supports one to four series")
	}
	for index := range c.Series {
		series := &c.Series[index]
		if !isNumericField(fields[series.Field]) {
			return nil, errors.New("chart series fields must be numeric")
		}
		series.Label = sanitizeCalendarText(series.Label, 80)
		if series.Color != "" && !widgetColorPattern.MatchString(series.Color) {
			return nil, errors.New("chart series color is invalid")
		}
	}
	if c.CategoryField != "" {
		if _, ok := fields[c.CategoryField]; !ok {
			return nil, errors.New("chart category field is unavailable")
		}
	}
	if c.TimeField != "" && fields[c.TimeField] != "date" && fields[c.TimeField] != "datetime" {
		return nil, errors.New("chart time field must be a date or datetime")
	}
	if c.Minimum != nil && c.Maximum != nil && *c.Minimum >= *c.Maximum {
		return nil, errors.New("chart bounds are invalid")
	}
	c.Dataset = sanitizeCalendarText(c.Dataset, 80)
	if err := normalizeVisualConfig(&c.WidgetVisualConfig); err != nil {
		return nil, err
	}
	return c, nil
}

type progressWidgetProvider struct{ service *Service }

func (p progressWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c ProgressWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndTypedFields(ctx, c.DataSourceID)
	if err != nil || !p.service.dataSourceProviderAccepted("progress", provider) || !isNumericField(fields[c.ValueField]) {
		return nil, errors.New("progress requires a numeric value field")
	}
	if c.TargetField != "" && !isNumericField(fields[c.TargetField]) {
		return nil, errors.New("progress target field must be numeric")
	}
	if c.TargetField == "" && (c.StaticTarget == nil || *c.StaticTarget <= 0) {
		return nil, errors.New("progress requires a positive target")
	}
	if c.LabelField != "" {
		if _, ok := fields[c.LabelField]; !ok {
			return nil, errors.New("progress label field is unavailable")
		}
	}
	c.Label = sanitizeCalendarText(c.Label, 120)
	c.CompletionText = sanitizeCalendarText(c.CompletionText, 160)
	if err := normalizeVisualConfig(&c.WidgetVisualConfig); err != nil {
		return nil, err
	}
	return c, nil
}

type timelineWidgetProvider struct{ service *Service }

func (p timelineWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c TimelineWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndTypedFields(ctx, c.DataSourceID)
	if err != nil || !p.service.dataSourceProviderAccepted("timeline", provider) {
		return nil, errors.New("timeline requires a temporal data Source")
	}
	if fields[c.DateField] != "date" && fields[c.DateField] != "datetime" {
		return nil, errors.New("timeline date field must be a date or datetime")
	}
	if c.TitleField == "" {
		return nil, errors.New("timeline title field is required")
	}
	for _, field := range []string{c.TitleField, c.BodyField, c.StatusField} {
		if field != "" {
			if _, ok := fields[field]; !ok {
				return nil, errors.New("timeline field is unavailable")
			}
		}
	}
	if c.Orientation == "" {
		c.Orientation = "vertical"
	}
	if c.Orientation != "vertical" && c.Orientation != "horizontal" {
		return nil, errors.New("timeline orientation is invalid")
	}
	if c.MaximumItems == 0 {
		c.MaximumItems = 8
	}
	if c.MaximumItems < 1 || c.MaximumItems > 20 {
		return nil, errors.New("timeline supports one to twenty items")
	}
	if err := normalizeVisualConfig(&c.WidgetVisualConfig); err != nil {
		return nil, err
	}
	return c, nil
}

func normalizeVisualConfig(c *WidgetVisualConfig) error {
	c.EmptyState = sanitizeCalendarText(c.EmptyState, 240)
	if c.EmptyState == "" {
		c.EmptyState = "No information available"
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return err
	}
	return validateWidgetSizing(c.TextScale, c.ContentPadding)
}

func isNumericField(kind string) bool {
	return kind == "number" || kind == "integer" || kind == "percent" || kind == "currency"
}

func normalizeFieldFormat(format *FieldFormat) error {
	if format.Format == "" {
		format.Format = "text"
	}
	if !map[string]bool{"text": true, "number": true, "integer": true, "percent": true, "currency": true, "date-short": true, "date-long": true}[format.Format] {
		return errors.New("field format is invalid")
	}
	if format.Precision < 0 || format.Precision > 6 {
		return errors.New("field precision is invalid")
	}
	if format.Alignment == "" {
		format.Alignment = "left"
	}
	if format.Alignment != "left" && format.Alignment != "center" && format.Alignment != "right" {
		return errors.New("field alignment is invalid")
	}
	if format.Width < 0 || format.Width > 100 {
		return errors.New("field width is invalid")
	}
	format.Prefix = sanitizeCalendarText(format.Prefix, 20)
	format.Suffix = sanitizeCalendarText(format.Suffix, 20)
	return nil
}

func validateWidgetSizing(scale, padding *int) error {
	if scale != nil && (*scale < 25 || *scale > 500) {
		return errors.New("widget text scale must be between 25 and 500 percent")
	}
	if padding != nil && (*padding < 0 || *padding > 40) {
		return errors.New("widget content padding must be between 0 and 40 percent")
	}
	return nil
}

func normalizeWidgetColors(foreground, background *string) error {
	if *foreground == "" {
		*foreground = "#F5F7FA"
	}
	if *background == "" {
		*background = "#0E141B"
	}
	if !widgetColorPattern.MatchString(*foreground) || !widgetColorPattern.MatchString(*background) {
		return errors.New("widget colors must use six-digit hexadecimal values")
	}
	return nil
}
