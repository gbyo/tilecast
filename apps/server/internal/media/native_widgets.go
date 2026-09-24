package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

var widgetColorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

type clockWidgetProvider struct{}

func (clockWidgetProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c ClockWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	if c.Timezone != "" {
		if _, err := time.LoadLocation(c.Timezone); err != nil {
			return nil, errors.New("clock timezone is invalid")
		}
	}
	if c.Format == "" {
		c.Format = "locale"
	}
	if c.Format != "locale" && c.Format != "12" && c.Format != "24" {
		return nil, errors.New("clock format is invalid")
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type dateWidgetProvider struct{}

func (dateWidgetProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c DateWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	if c.Timezone != "" {
		if _, err := time.LoadLocation(c.Timezone); err != nil {
			return nil, errors.New("date timezone is invalid")
		}
	}
	if c.Format == "" {
		c.Format = "locale"
	}
	if c.Format != "locale" && c.Format != "full" && c.Format != "long" && c.Format != "medium" && c.Format != "short" {
		return nil, errors.New("date format is invalid")
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type qrCodeWidgetProvider struct{}

func (qrCodeWidgetProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c QRCodeWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	c.Value = strings.TrimSpace(c.Value)
	c.Label = sanitizeCalendarText(c.Label, 120)
	if c.Value == "" || len(c.Value) > 2048 {
		return nil, errors.New("QR Code value must be between 1 and 2048 characters")
	}
	if strings.ContainsAny(c.Value, "\x00\r\n") {
		return nil, errors.New("QR Code value contains unsupported control characters")
	}
	if c.ErrorCorrection == "" {
		c.ErrorCorrection = "medium"
	}
	if c.ErrorCorrection != "low" && c.ErrorCorrection != "medium" && c.ErrorCorrection != "quartile" && c.ErrorCorrection != "high" {
		return nil, errors.New("QR Code error correction is invalid")
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type countdownWidgetProvider struct{}

func (countdownWidgetProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c CountdownWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	c.Label = sanitizeCalendarText(c.Label, 120)
	c.CompletionText = sanitizeCalendarText(c.CompletionText, 240)
	if c.Timezone == "" {
		c.Timezone = "UTC"
	}
	location, err := time.LoadLocation(c.Timezone)
	if err != nil {
		return nil, errors.New("countdown timezone is invalid")
	}
	if _, err = time.ParseInLocation("2006-01-02T15:04", c.Target, location); err != nil {
		if _, err = time.Parse(time.RFC3339, c.Target); err != nil {
			return nil, errors.New("countdown target is invalid")
		}
	}
	if c.Mode == "" {
		c.Mode = "countdown"
	}
	if c.Mode != "countdown" && c.Mode != "count_up" {
		return nil, errors.New("countdown mode is invalid")
	}
	if c.Recurrence == "" {
		c.Recurrence = "none"
	}
	if c.Recurrence != "none" && c.Recurrence != "daily" && c.Recurrence != "weekly" && c.Recurrence != "monthly" && c.Recurrence != "yearly" {
		return nil, errors.New("countdown recurrence is invalid")
	}
	if c.Mode != "countdown" && c.Recurrence != "none" {
		return nil, errors.New("recurring countdowns must count down")
	}
	if c.Layout == "" {
		c.Layout = "stacked"
	}
	if c.Layout != "stacked" && c.Layout != "horizontal" && c.Layout != "countdown_only" {
		return nil, errors.New("countdown layout is invalid")
	}
	if c.CompletionAction == "" {
		c.CompletionAction = "completed_text"
	}
	if c.CompletionAction != "completed_text" && c.CompletionAction != "hide" && c.CompletionAction != "count_up" {
		return nil, errors.New("countdown completion action is invalid")
	}
	if !c.ShowDays && !c.ShowHours && !c.ShowMinutes && !c.ShowSeconds {
		c.ShowDays, c.ShowHours, c.ShowMinutes = true, true, true
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type tickerWidgetProvider struct{ service *Service }

func (p tickerWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c TickerWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndFields(ctx, c.DataSourceID)
	if err != nil {
		return nil, errors.New("ticker data Source was not found")
	}
	if !dataSourceProviderAccepted("ticker", provider) {
		return nil, errors.New("ticker requires a record-based data Source")
	}
	if len(c.Fields) == 0 && c.Field != "" {
		c.Fields = []string{c.Field}
	}
	if len(c.Fields) == 0 {
		c.Fields = []string{"title"}
	}
	if len(c.Fields) > 3 {
		return nil, errors.New("ticker supports up to three fields")
	}
	for index := range c.Fields {
		c.Fields[index] = sanitizeCalendarText(c.Fields[index], 80)
		if c.Fields[index] == "" || (len(fields) > 0 && !fields[c.Fields[index]]) {
			return nil, errors.New("ticker field is not provided by the selected data Source")
		}
	}
	c.Field = c.Fields[0]
	c.Separator = sanitizeCalendarText(c.Separator, 10)
	if c.Separator == "" {
		c.Separator = " • "
	}
	c.FieldSeparator = sanitizeCalendarText(c.FieldSeparator, 10)
	if c.FieldSeparator == "" {
		c.FieldSeparator = " — "
	}
	if c.Speed == "" {
		c.Speed = "normal"
	}
	if c.Speed != "slow" && c.Speed != "normal" && c.Speed != "fast" {
		return nil, errors.New("ticker speed is invalid")
	}
	if c.Direction == "" {
		c.Direction = "left"
	}
	if c.Direction != "left" && c.Direction != "right" {
		return nil, errors.New("ticker direction is invalid")
	}
	c.EmptyState = sanitizeCalendarText(c.EmptyState, 240)
	if c.EmptyState == "" {
		c.EmptyState = "No items available"
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type displayWidgetProvider struct {
	service      *Service
	presentation string
}

func (p displayWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c DisplayWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndFields(ctx, c.DataSourceID)
	if err != nil {
		return nil, errors.New("data Source was not found")
	}
	if !dataSourceProviderAccepted(p.presentation, provider) {
		return nil, errors.New(p.presentation + " widget is not compatible with the selected data Source")
	}
	if c.MaximumItems == 0 {
		c.MaximumItems = 20
	}
	if c.MaximumItems < 1 || c.MaximumItems > 100 {
		return nil, errors.New("maximum items must be between 1 and 100")
	}
	normalizedFields, err := normalizeDisplayWidgetFields(p.presentation, c.Fields, fields)
	if err != nil {
		return nil, err
	}
	c.Fields = normalizedFields
	c.EmptyState = sanitizeCalendarText(c.EmptyState, 240)
	if c.EmptyState == "" {
		c.EmptyState = "No items available"
	}
	if c.RowSpacing == "" {
		c.RowSpacing = "comfortable"
	}
	if c.RowSpacing != "compact" && c.RowSpacing != "comfortable" {
		return nil, errors.New("row spacing is invalid")
	}
	if c.Mode == "" {
		if p.presentation == "menu" {
			c.Mode = "single_record"
		} else {
			c.Mode = "records"
		}
	}
	if c.Mode != "single_record" && c.Mode != "records" {
		return nil, errors.New("display mode is invalid")
	}
	for _, field := range []string{c.PrimaryField, c.SecondaryField, c.LeadingField, c.TrailingField, c.LabelField, c.ValueField, c.DateField, c.TimeField, c.TitleField, c.LocationField, c.DescriptionField} {
		if field != "" && !fields[field] {
			return nil, fmt.Errorf("field %q is not provided by the selected data Source", field)
		}
	}
	if len(c.Columns) > 8 {
		return nil, errors.New("table columns are limited to eight")
	}
	for index := range c.Columns {
		column := &c.Columns[index]
		column.Field = sanitizeCalendarText(column.Field, 80)
		column.Label = sanitizeCalendarText(column.Label, 80)
		if !fields[column.Field] {
			return nil, fmt.Errorf("field %q is not provided by the selected data Source", column.Field)
		}
		if err := normalizeFieldFormat(column); err != nil {
			return nil, err
		}
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type metricWidgetProvider struct{ service *Service }

func (p metricWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c MetricWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndTypedFields(ctx, c.DataSourceID)
	if err != nil || !dataSourceProviderAccepted("metric", provider) {
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

type cardsWidgetProvider struct{ service *Service }

func (p cardsWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c CardsWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, fields, err := p.service.dataSourceProviderAndFields(ctx, c.DataSourceID)
	if err != nil || !dataSourceProviderAccepted("cards", provider) {
		return nil, errors.New("cards require a record-based data Source")
	}
	if c.TitleField == "" || !fields[c.TitleField] {
		return nil, errors.New("cards title field is invalid")
	}
	for _, field := range []string{c.SubtitleField, c.BodyField, c.BadgeField} {
		if field != "" && !fields[field] {
			return nil, errors.New("cards field is not provided by the selected data Source")
		}
	}
	if c.Columns == 0 {
		c.Columns = 2
	}
	if c.Columns < 1 || c.Columns > 4 || c.MaximumItems < 1 || c.MaximumItems > 12 {
		return nil, errors.New("cards columns or item count is invalid")
	}
	if c.Density == "" {
		c.Density = "comfortable"
	}
	if c.Density != "compact" && c.Density != "comfortable" {
		return nil, errors.New("cards density is invalid")
	}
	c.EmptyState = sanitizeCalendarText(c.EmptyState, 240)
	if c.EmptyState == "" {
		c.EmptyState = "No items available"
	}
	if err := normalizeWidgetColors(&c.ForegroundColor, &c.BackgroundColor); err != nil {
		return nil, err
	}
	if err := validateWidgetSizing(c.TextScale, c.ContentPadding); err != nil {
		return nil, err
	}
	return c, nil
}

type weatherWidgetProvider struct{ service *Service }

func (p weatherWidgetProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c WeatherWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	provider, _, err := p.service.dataSourceProviderAndFields(ctx, c.DataSourceID)
	if err != nil || !dataSourceProviderAccepted("weather", provider) {
		return nil, errors.New("weather Widget requires a Weather Data Source")
	}
	if !c.ShowLocation && !c.ShowCurrent && !c.ShowHumidity && !c.ShowWind && !c.ShowPrecipitation {
		c.ShowLocation, c.ShowCurrent = true, true
	}
	if c.ForecastDays < 0 || c.ForecastDays > 7 {
		return nil, errors.New("weather forecast days must be between zero and seven")
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
	if err != nil || !dataSourceProviderAccepted("spotlight", provider) {
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
	if err != nil || !dataSourceProviderAccepted("stat_grid", provider) {
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
	if err != nil || !dataSourceProviderAccepted("chart", provider) {
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
	if err != nil || !dataSourceProviderAccepted("progress", provider) || !isNumericField(fields[c.ValueField]) {
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
	if err != nil || !dataSourceProviderAccepted("timeline", provider) {
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

type worldClockWidgetProvider struct{}

func (worldClockWidgetProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c WorldClockWidgetConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	if len(c.Zones) < 1 || len(c.Zones) > 8 {
		return nil, errors.New("world clock supports one to eight timezones")
	}
	seen := map[string]bool{}
	for index := range c.Zones {
		zone := &c.Zones[index]
		zone.Label = sanitizeCalendarText(zone.Label, 80)
		if zone.Label == "" || seen[zone.Label] {
			return nil, errors.New("world clock labels must be unique")
		}
		if zone.Timezone != "" {
			if _, err := time.LoadLocation(zone.Timezone); err != nil {
				return nil, errors.New("world clock timezone is invalid")
			}
		}
		seen[zone.Label] = true
	}
	if c.Format == "" {
		c.Format = "locale"
	}
	if c.Format != "locale" && c.Format != "12" && c.Format != "24" {
		return nil, errors.New("world clock format is invalid")
	}
	if c.Columns == 0 {
		c.Columns = min(4, len(c.Zones))
	}
	if c.Columns < 1 || c.Columns > 4 {
		return nil, errors.New("world clock columns are invalid")
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

func normalizeDisplayWidgetFields(presentation string, selected []string, available map[string]bool) ([]string, error) {
	if len(selected) > 12 {
		return nil, errors.New("a widget must select between 1 and 12 fields")
	}

	normalized := make([]string, 0, len(selected))
	seen := map[string]bool{}
	for _, rawField := range selected {
		field := sanitizeCalendarText(rawField, 80)
		if field == "" || seen[field] {
			return nil, errors.New("widget fields must be unique and non-empty")
		}
		if len(available) == 0 || available[field] {
			seen[field] = true
			normalized = append(normalized, field)
			continue
		}
		// The Studio historically initialized Menu Widgets with title/subtitle.
		// When a custom CSV or JSON Source does not expose those fields, discard
		// only those stale implicit defaults while preserving real user choices.
		if presentation == "menu" && (field == "title" || field == "subtitle") {
			continue
		}
		return nil, fmt.Errorf("field %q is not provided by the selected data Source", field)
	}

	if presentation == "menu" && len(normalized) == 0 && len(available) > 0 {
		preferred := []string{
			"option_1",
			"option_2",
			"entree",
			"entrée",
			"primary",
			"primary_option",
			"alternative",
			"secondary",
			"secondary_option",
			"title",
			"subtitle",
		}
		for _, field := range preferred {
			if available[field] && !seen[field] {
				normalized = append(normalized, field)
				seen[field] = true
			}
			if len(normalized) == 2 {
				break
			}
		}
		if len(normalized) == 0 {
			fallback := make([]string, 0, len(available))
			for field := range available {
				switch field {
				case "date", "imageUrl", "link":
					continue
				}
				fallback = append(fallback, field)
			}
			sort.Strings(fallback)
			if len(fallback) > 2 {
				fallback = fallback[:2]
			}
			normalized = append(normalized, fallback...)
		}
	}

	if len(normalized) == 0 {
		return nil, errors.New("a widget must select between 1 and 12 fields")
	}
	return normalized, nil
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
