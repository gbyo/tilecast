package playlists

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

const (
	DataDocumentSchemaVersion = 1
	PresentationSchemaVersion = 1
	WebRuntimeVersion         = 2
)

var NativePresentationCapabilities = map[string]int{
	"layout.surface": 1, "layout.box": 1, "layout.row": 1, "layout.column": 1,
	"layout.stack": 1, "layout.grid": 1, "layout.spacer": 1, "layout.divider": 1,
	"content.text": 1, "content.icon": 2, "content.asset_image": 2, "content.badge": 1,
	"content.progress": 2, "content.qr_code": 1, "content.marquee": 1,
	"content.line_chart": 2, "content.bar_chart": 2, "content.donut_chart": 2,
	"collection.repeat": 2, "collection.conditional": 2, "collection.grouped_sections": 1,
	"binding.core": 2, "format.typed": 2, "selection.relative_date": 1,
	"selection.temporal": 1,
	"playback.auto_skip": 1,
}

type DataDocument struct {
	SchemaVersion int               `json:"schemaVersion"`
	Datasets      []DocumentDataset `json:"datasets"`
}

type DocumentDataset struct {
	ID            string                 `json:"id"`
	Kind          string                 `json:"kind"`
	Fields        []DocumentField        `json:"fields,omitempty"`
	Scalar        *DocumentValue         `json:"scalar,omitempty"`
	Records       []DocumentRecord       `json:"records,omitempty"`
	Points        []DocumentPoint        `json:"points,omitempty"`
	Value         *DocumentValue         `json:"value,omitempty"`
	Cache         DocumentCacheState     `json:"cache"`
	Attribution   string                 `json:"attribution,omitempty"`
	Timezone      string                 `json:"timezone,omitempty"`
	DateSelection *DocumentDateSelection `json:"dateSelection,omitempty"`
	Units         map[string]string      `json:"units,omitempty"`
}

type DocumentField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Unit     string `json:"unit,omitempty"`
	Currency string `json:"currency,omitempty"`
}

type DocumentRecord struct {
	ID     string                   `json:"id"`
	Values map[string]DocumentValue `json:"values"`
}

type DocumentPoint struct {
	At     string                   `json:"at"`
	Value  *DocumentValue           `json:"value,omitempty"`
	Values map[string]DocumentValue `json:"values,omitempty"`
}

type DocumentValue struct {
	Kind     string                   `json:"kind"`
	Text     *string                  `json:"text,omitempty"`
	Number   *float64                 `json:"number,omitempty"`
	Integer  *int64                   `json:"integer,omitempty"`
	Boolean  *bool                    `json:"boolean,omitempty"`
	Date     *string                  `json:"date,omitempty"`
	DateTime *string                  `json:"datetime,omitempty"`
	Duration *int64                   `json:"durationSeconds,omitempty"`
	URL      *string                  `json:"url,omitempty"`
	AssetID  *string                  `json:"assetId,omitempty"`
	List     []DocumentValue          `json:"list,omitempty"`
	Object   map[string]DocumentValue `json:"object,omitempty"`
}

type DocumentCacheState struct {
	CachedAt       *time.Time `json:"cachedAt,omitempty"`
	StaleAt        *time.Time `json:"staleAt,omitempty"`
	UsingCached    bool       `json:"usingCachedData"`
	Unavailable    bool       `json:"unavailable"`
	LastModified   string     `json:"lastModified,omitempty"`
	UpstreamExpiry *time.Time `json:"upstreamExpiry,omitempty"`
}

type DocumentDateSelection struct {
	Field           string `json:"field"`
	Timezone        string `json:"timezone"`
	Mode            string `json:"mode"`
	CustomStartDate string `json:"customStartDate,omitempty"`
	CustomEndDate   string `json:"customEndDate,omitempty"`
	ExcludePast     bool   `json:"excludePast"`
	NoMatchBehavior string `json:"noMatchBehavior,omitempty"`
	FallbackText    string `json:"fallbackText,omitempty"`
}

type WidgetPresentation struct {
	SchemaVersion        int                     `json:"schemaVersion"`
	Kind                 string                  `json:"kind"`
	RequiredCapabilities map[string]int          `json:"requiredCapabilities"`
	Native               *NativePresentation     `json:"native,omitempty"`
	Web                  *WebSandboxPresentation `json:"web,omitempty"`
}

type NativePresentation struct {
	Root PresentationNode `json:"root"`
}

type PresentationNode struct {
	ID        string                 `json:"id,omitempty"`
	Type      string                 `json:"type"`
	Props     map[string]any         `json:"props,omitempty"`
	Binding   *PresentationBinding   `json:"binding,omitempty"`
	Repeat    *PresentationRepeat    `json:"repeat,omitempty"`
	Condition *PresentationCondition `json:"condition,omitempty"`
	Children  []PresentationNode     `json:"children,omitempty"`
}

type PresentationBinding struct {
	Source     string   `json:"source"`
	Dataset    string   `json:"dataset,omitempty"`
	Path       string   `json:"path,omitempty"`
	Selector   string   `json:"selector,omitempty"`
	StartField string   `json:"startField,omitempty"`
	EndField   string   `json:"endField,omitempty"`
	Value      string   `json:"value,omitempty"`
	Fields     []string `json:"fields,omitempty"`
	Format     string   `json:"format,omitempty"`
	Precision  *int     `json:"precision,omitempty"`
	Prefix     string   `json:"prefix,omitempty"`
	Suffix     string   `json:"suffix,omitempty"`
	Fallback   string   `json:"fallback,omitempty"`
	Separator  string   `json:"separator,omitempty"`
}

type PresentationRepeat struct {
	Dataset    string `json:"dataset"`
	Limit      int    `json:"limit"`
	Selector   string `json:"selector,omitempty"`
	StartField string `json:"startField,omitempty"`
	EndField   string `json:"endField,omitempty"`
	// Offset skips leading records, so one Widget can feature the current record and a
	// second region can list the ones that follow it. Zero keeps the existing behavior.
	Offset int `json:"offset,omitempty"`
}

type PresentationCondition struct {
	Binding PresentationBinding `json:"binding"`
	Op      string              `json:"op"`
	Value   string              `json:"value,omitempty"`
}

type WebSandboxPresentation struct {
	Mode                  string     `json:"mode"`
	URL                   string     `json:"url,omitempty"`
	BundleID              string     `json:"bundleId,omitempty"`
	EntryPoint            string     `json:"entryPoint,omitempty"`
	IntegritySHA256       string     `json:"integritySha256,omitempty"`
	PackageSize           int64      `json:"packageSize,omitempty"`
	DownloadPath          string     `json:"downloadPath,omitempty"`
	AllowedHosts          []string   `json:"allowedHosts"`
	ExternalNetworkAccess bool       `json:"externalNetworkAccess"`
	OnlineOnly            bool       `json:"onlineOnly"`
	FallbackBehavior      string     `json:"fallbackBehavior"`
	LoadTimeoutSeconds    int        `json:"loadTimeoutSeconds"`
	Lifecycle             string     `json:"lifecycle"`
	WarmSeconds           int        `json:"warmSeconds"`
	Reload                *WebReload `json:"reload,omitempty"`
}

type WebReload struct {
	Mode            string `json:"mode"`
	IntervalSeconds int    `json:"intervalSeconds"`
}

type typedRecordProjection struct {
	Fields []struct {
		Key      string `json:"key"`
		Label    string `json:"label"`
		Type     string `json:"type"`
		Currency string `json:"currency,omitempty"`
	} `json:"fields"`
	Records []struct {
		ID     string            `json:"id"`
		Values map[string]string `json:"values"`
	} `json:"records"`
	CachedAt      *time.Time `json:"cachedAt"`
	StaleAt       *time.Time `json:"staleAt"`
	UsingCached   bool       `json:"usingCachedData"`
	Unavailable   bool       `json:"unavailable"`
	DateSelection *struct {
		Timezone        string `json:"timezone"`
		Mode            string `json:"mode"`
		CustomStartDate string `json:"customStartDate"`
		CustomEndDate   string `json:"customEndDate"`
		ExcludePast     bool   `json:"excludePast"`
		NoMatchBehavior string `json:"noMatchBehavior"`
		FallbackText    string `json:"fallbackText"`
	} `json:"dateSelection"`
	DateField   string `json:"dateField"`
	Attribution string `json:"attribution"`
}

func projectDataDocument(raw json.RawMessage) (*DataDocument, error) {
	var multiple struct {
		Datasets []struct {
			ID     string `json:"id"`
			Kind   string `json:"kind"`
			Fields []struct {
				Key      string `json:"key"`
				Label    string `json:"label"`
				Type     string `json:"type"`
				Currency string `json:"currency,omitempty"`
			} `json:"fields"`
			Records []struct {
				ID     string            `json:"id"`
				Values map[string]string `json:"values"`
			} `json:"records"`
			Points []struct {
				At     time.Time         `json:"at"`
				Values map[string]string `json:"values"`
			} `json:"points"`
			Values          map[string]string `json:"values"`
			CachedAt        *time.Time        `json:"cachedAt"`
			StaleAt         *time.Time        `json:"staleAt"`
			UsingCachedData bool              `json:"usingCachedData"`
			Unavailable     bool              `json:"unavailable"`
			Attribution     string            `json:"attribution"`
			Timezone        string            `json:"timezone"`
			Units           map[string]string `json:"units"`
		} `json:"datasets"`
	}
	if json.Unmarshal(raw, &multiple) == nil && len(multiple.Datasets) > 0 {
		if len(multiple.Datasets) > 16 {
			return nil, errors.New("projected data exceeds dataset bounds")
		}
		document := &DataDocument{SchemaVersion: DataDocumentSchemaVersion, Datasets: make([]DocumentDataset, 0, len(multiple.Datasets))}
		for _, source := range multiple.Datasets {
			if source.ID == "" || len(source.ID) > 80 || (source.Kind != "records" && source.Kind != "time_series" && source.Kind != "object") || len(source.Fields) > 16 || len(source.Records) > 2000 || len(source.Points) > 5000 {
				return nil, errors.New("projected dataset is invalid")
			}
			dataset := DocumentDataset{ID: source.ID, Kind: source.Kind, Cache: DocumentCacheState{CachedAt: source.CachedAt, StaleAt: source.StaleAt, UsingCached: source.UsingCachedData, Unavailable: source.Unavailable}, Attribution: source.Attribution, Timezone: source.Timezone, Units: source.Units}
			fieldTypes := map[string]string{}
			for _, field := range source.Fields {
				if !validScalarKind(field.Type) || field.Key == "" {
					return nil, errors.New("projected dataset field is invalid")
				}
				fieldTypes[field.Key] = field.Type
				dataset.Fields = append(dataset.Fields, DocumentField{Key: field.Key, Label: field.Label, Type: field.Type, Unit: source.Units[field.Key], Currency: field.Currency})
			}
			for _, record := range source.Records {
				values := map[string]DocumentValue{}
				for key, value := range record.Values {
					values[key] = coerceDocumentValue(fieldTypes[key], value)
				}
				dataset.Records = append(dataset.Records, DocumentRecord{ID: record.ID, Values: values})
			}
			for _, point := range source.Points {
				values := map[string]DocumentValue{}
				for key, value := range point.Values {
					values[key] = coerceDocumentValue(fieldTypes[key], value)
				}
				dataset.Points = append(dataset.Points, DocumentPoint{At: point.At.UTC().Format(time.RFC3339), Values: values})
			}
			if source.Kind == "object" {
				object := map[string]DocumentValue{}
				for key, value := range source.Values {
					object[key] = coerceDocumentValue(fieldTypes[key], value)
				}
				dataset.Value = &DocumentValue{Kind: "object", Object: object}
			}
			document.Datasets = append(document.Datasets, dataset)
		}
		return document, nil
	}
	var projected typedRecordProjection
	if err := json.Unmarshal(raw, &projected); err != nil {
		return nil, fmt.Errorf("decode projected data: %w", err)
	}
	if len(projected.Fields) > 16 || len(projected.Records) > 2000 {
		return nil, errors.New("projected data exceeds v13 bounds")
	}
	dataset := DocumentDataset{
		ID: "records", Kind: "records", Fields: make([]DocumentField, 0, len(projected.Fields)),
		Records:     make([]DocumentRecord, 0, len(projected.Records)),
		Cache:       DocumentCacheState{CachedAt: projected.CachedAt, StaleAt: projected.StaleAt, UsingCached: projected.UsingCached, Unavailable: projected.Unavailable},
		Attribution: projected.Attribution,
	}
	fieldTypes := map[string]string{}
	for _, field := range projected.Fields {
		if !validScalarKind(field.Type) || field.Key == "" || len(field.Key) > 80 {
			return nil, errors.New("projected field is invalid")
		}
		fieldTypes[field.Key] = field.Type
		dataset.Fields = append(dataset.Fields, DocumentField{Key: field.Key, Label: field.Label, Type: field.Type, Currency: field.Currency})
	}
	for _, record := range projected.Records {
		if record.ID == "" || len(record.ID) > 80 || len(record.Values) > 16 {
			return nil, errors.New("projected record is invalid")
		}
		values := make(map[string]DocumentValue, len(record.Values))
		for key, rawValue := range record.Values {
			if len(rawValue) > 4096 {
				return nil, errors.New("projected value is too long")
			}
			values[key] = coerceDocumentValue(fieldTypes[key], rawValue)
		}
		dataset.Records = append(dataset.Records, DocumentRecord{ID: record.ID, Values: values})
	}
	if projected.DateSelection != nil && projected.DateField != "" {
		dataset.Timezone = projected.DateSelection.Timezone
		dataset.DateSelection = &DocumentDateSelection{
			Field: projected.DateField, Timezone: projected.DateSelection.Timezone, Mode: projected.DateSelection.Mode,
			CustomStartDate: projected.DateSelection.CustomStartDate, CustomEndDate: projected.DateSelection.CustomEndDate,
			ExcludePast: projected.DateSelection.ExcludePast, NoMatchBehavior: projected.DateSelection.NoMatchBehavior,
			FallbackText: projected.DateSelection.FallbackText,
		}
	}
	return &DataDocument{SchemaVersion: DataDocumentSchemaVersion, Datasets: []DocumentDataset{dataset}}, nil
}

func validScalarKind(kind string) bool {
	switch kind {
	case "text", "number", "integer", "percent", "currency", "boolean", "date", "datetime", "duration", "url", "asset", "null":
		return true
	default:
		return false
	}
}

func coerceDocumentValue(kind, raw string) DocumentValue {
	if raw == "" {
		return DocumentValue{Kind: "null"}
	}
	switch kind {
	case "number", "percent", "currency":
		if value, err := strconv.ParseFloat(raw, 64); err == nil {
			return DocumentValue{Kind: kind, Number: &value}
		}
	case "integer":
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return DocumentValue{Kind: kind, Integer: &value}
		}
	case "boolean":
		if value, err := strconv.ParseBool(raw); err == nil {
			return DocumentValue{Kind: kind, Boolean: &value}
		}
	case "date":
		if _, err := time.Parse("2006-01-02", raw); err == nil {
			return DocumentValue{Kind: kind, Date: &raw}
		}
	case "datetime":
		if _, err := time.Parse(time.RFC3339, raw); err == nil {
			return DocumentValue{Kind: kind, DateTime: &raw}
		}
	case "url":
		if parsed, err := url.Parse(raw); err == nil && parsed.Scheme != "" && parsed.Host != "" {
			return DocumentValue{Kind: kind, URL: &raw}
		}
	}
	return DocumentValue{Kind: "text", Text: &raw}
}

func (s *Service) compileWidgetPresentation(provider string, raw json.RawMessage) (*WidgetPresentation, error) {
	if definition, ok := s.definitions.Widget(provider); ok && !definition.LegacyEditor {
		return compileDefinitionPresentation(definition, raw)
	}
	switch provider {
	case "website", "youtube", "clock", "date", "qrcode", "countdown", "ticker", "menu", "list", "table", "agenda", "metric", "cards", "weather", "spotlight", "stat_grid", "chart", "progress", "timeline", "world_clock":
	default:
		return nil, errors.New("widget provider is not supported")
	}
	var c map[string]any
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	if provider == "website" || provider == "youtube" {
		return compileWebPresentation(provider, c)
	}
	root, capabilities, err := compileNativeRoot(provider, c)
	if err != nil {
		return nil, err
	}
	return &WidgetPresentation{
		SchemaVersion: PresentationSchemaVersion, Kind: "native", RequiredCapabilities: capabilities,
		Native: &NativePresentation{Root: root},
	}, nil
}

func compileDefinitionPresentation(definition contentdefs.WidgetDefinition, raw json.RawMessage) (*WidgetPresentation, error) {
	var configuration map[string]any
	if err := json.Unmarshal(raw, &configuration); err != nil {
		return nil, err
	}
	if definition.Runtime == "web" {
		return compileDefinitionWebPresentation(definition, configuration)
	}
	var template any
	if err := json.Unmarshal(definition.PresentationTemplate, &template); err != nil {
		return nil, err
	}
	resolved, included, err := resolveDefinitionTemplate(template, configuration)
	if err != nil {
		return nil, err
	}
	if !included {
		return nil, errors.New("presentation template resolved to no content")
	}
	encoded, err := json.Marshal(resolved)
	if err != nil {
		return nil, err
	}
	var root PresentationNode
	if err = json.Unmarshal(encoded, &root); err != nil {
		return nil, fmt.Errorf("decode resolved presentation: %w", err)
	}
	if root.Type == "" {
		return nil, errors.New("resolved presentation has no root node")
	}
	capabilities := make(map[string]int, len(definition.RequiredCapabilities)+1)
	for capability, version := range definition.RequiredCapabilities {
		capabilities[capability] = version
	}
	if enabled, _ := root.Props["autoSkipWhenEmpty"].(bool); enabled {
		conditionValue, ok := root.Props["emptyCondition"].(map[string]any)
		if !ok {
			return nil, errors.New("auto-skip presentation is missing its empty condition")
		}
		conditionJSON, marshalErr := json.Marshal(conditionValue)
		if marshalErr != nil {
			return nil, errors.New("auto-skip presentation has an invalid empty condition")
		}
		var condition PresentationCondition
		if json.Unmarshal(conditionJSON, &condition) != nil || condition.Op != "empty" || condition.Binding.Source == "" {
			return nil, errors.New("auto-skip presentation has an invalid empty condition")
		}
		capabilities["playback.auto_skip"] = 1
	}
	return &WidgetPresentation{
		SchemaVersion:        definition.PresentationSchemaVersion,
		Kind:                 "native",
		RequiredCapabilities: capabilities,
		Native:               &NativePresentation{Root: root},
	}, nil
}

func compileDefinitionWebPresentation(definition contentdefs.WidgetDefinition, configuration map[string]any) (*WidgetPresentation, error) {
	webURL, hosts, err := contentdefs.WebPresentationURL(definition, configuration)
	if err != nil {
		return nil, err
	}
	spec := definition.WebIntegration
	timeout := spec.LoadTimeoutSeconds
	if timeout == 0 {
		timeout = 20
	}
	lifecycle := spec.Lifecycle
	if lifecycle == "" {
		lifecycle = "destroy_on_hide"
	}
	fallback := spec.FallbackBehavior
	if fallback == "" {
		fallback = "placeholder"
	}
	descriptor := &WebSandboxPresentation{
		Mode: "remote", URL: webURL, AllowedHosts: hosts, ExternalNetworkAccess: true,
		OnlineOnly: true, FallbackBehavior: fallback, LoadTimeoutSeconds: timeout,
		Lifecycle: lifecycle, WarmSeconds: spec.WarmSeconds,
	}
	if spec.ReloadIntervalField != "" {
		interval := intValue(configuration[spec.ReloadIntervalField], 0)
		if interval >= 30 && interval <= 86400 {
			descriptor.Reload = &WebReload{Mode: "periodic", IntervalSeconds: interval}
		}
	}
	return &WidgetPresentation{
		SchemaVersion: definition.PresentationSchemaVersion, Kind: "web",
		RequiredCapabilities: definition.RequiredCapabilities, Web: descriptor,
	}, nil
}

func resolveDefinitionTemplate(value any, configuration map[string]any) (any, bool, error) {
	switch typed := value.(type) {
	case []any:
		result := make([]any, 0, len(typed))
		for _, item := range typed {
			resolved, included, err := resolveDefinitionTemplate(item, configuration)
			if err != nil {
				return nil, false, err
			}
			if included {
				result = append(result, resolved)
			}
		}
		return result, true, nil
	case map[string]any:
		if key, ok := typed["$config"].(string); ok {
			resolved, exists := configuration[key]
			if !exists {
				// Server-derived keys are produced during manifest projection. A Widget whose
				// author left the optional selection empty simply has no derived value, so the
				// reference resolves to an empty value rather than failing the compile.
				if !contentdefs.DerivedConfigurationKeys[key] {
					return nil, false, fmt.Errorf("presentation template references missing configuration %q", key)
				}
				resolved = ""
			}
			if suffix, ok := typed["suffix"].(string); ok {
				text, textOK := resolved.(string)
				if !textOK {
					return nil, false, fmt.Errorf("presentation template suffix requires text configuration %q", key)
				}
				resolved = text + suffix
			}
			return resolved, true, nil
		}
		if key, ok := typed["$ifConfig"].(string); ok {
			enabled, _ := configuration[key].(bool)
			if !enabled {
				return nil, false, nil
			}
		}
		if condition, ok := typed["$ifConfigEquals"].(map[string]any); ok {
			key, _ := condition["key"].(string)
			wanted, _ := condition["value"].(string)
			actual, _ := configuration[key].(string)
			if key == "" || actual != wanted {
				return nil, false, nil
			}
		}
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			if key == "$ifConfig" || key == "$ifConfigEquals" {
				continue
			}
			resolved, included, err := resolveDefinitionTemplate(item, configuration)
			if err != nil {
				return nil, false, err
			}
			if included {
				result[key] = resolved
			}
		}
		return result, true, nil
	default:
		return value, true, nil
	}
}

func (s *Service) compileWidgetPresentationForPreset(provider string, presetID *string, raw json.RawMessage) (*WidgetPresentation, error) {
	presentation, err := s.compileWidgetPresentation(provider, raw)
	if err != nil || presetID == nil || presentation.Native == nil {
		return presentation, err
	}
	switch *presetID {
	case "leaderboard", "queue_board":
		prependRepeatIndex(&presentation.Native.Root)
		presentation.RequiredCapabilities["binding.core"] = 2
		presentation.RequiredCapabilities["collection.repeat"] = 2
	case "status_board":
		promoteLastTextToBadge(&presentation.Native.Root)
		presentation.RequiredCapabilities["content.badge"] = 1
	}
	return presentation, nil
}

func prependRepeatIndex(node *PresentationNode) bool {
	if node.Type == "repeat" && len(node.Children) > 0 {
		template := &node.Children[0]
		template.Children = append([]PresentationNode{{Type: "text", Props: map[string]any{"role": "label"}, Binding: &PresentationBinding{Source: "repeat_index", Format: "integer", Suffix: "."}}}, template.Children...)
		return true
	}
	for index := range node.Children {
		if prependRepeatIndex(&node.Children[index]) {
			return true
		}
	}
	return false
}

func promoteLastTextToBadge(node *PresentationNode) bool {
	for index := len(node.Children) - 1; index >= 0; index-- {
		if node.Children[index].Type == "text" {
			node.Children[index].Type = "badge"
			return true
		}
		if promoteLastTextToBadge(&node.Children[index]) {
			return true
		}
	}
	return false
}

func (s *Service) CompileWidgetPresentation(provider string, raw json.RawMessage) (*WidgetPresentation, error) {
	return s.compileWidgetPresentation(provider, raw)
}

func compileWebPresentation(provider string, c map[string]any) (*WidgetPresentation, error) {
	rawURL, _ := c["url"].(string)
	if provider == "youtube" {
		videoID := stringValue(c, "videoId", "")
		playlistID := stringValue(c, "playlistId", "")
		if videoID != "" {
			rawURL = "https://www.youtube.com/embed/" + videoID + "?autoplay=1&playsinline=1"
		} else if playlistID != "" {
			rawURL = "https://www.youtube.com/embed/videoseries?autoplay=1&list=" + url.QueryEscape(playlistID)
		}
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return nil, errors.New("web presentation URL is invalid")
	}
	hosts := stringSlice(c["allowedHosts"])
	if len(hosts) == 0 {
		hosts = []string{strings.ToLower(parsed.Hostname())}
	}
	if provider == "youtube" {
		hosts = []string{"www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com", "i.ytimg.com", "googlevideo.com"}
	}
	timeout := intValue(c["loadTimeoutSeconds"], 20)
	lifecycle, _ := c["lifecycle"].(string)
	if lifecycle != "keep_warm" {
		lifecycle = "destroy_on_hide"
	}
	return &WidgetPresentation{
		SchemaVersion: PresentationSchemaVersion, Kind: "web",
		RequiredCapabilities: map[string]int{"web.remote": 1},
		Web: &WebSandboxPresentation{
			Mode: "remote", URL: rawURL, AllowedHosts: hosts, ExternalNetworkAccess: true, OnlineOnly: true,
			FallbackBehavior: stringValue(c, "failureBehavior", "placeholder"), LoadTimeoutSeconds: timeout,
			Lifecycle: lifecycle, WarmSeconds: min(intValue(c["warmSeconds"], 0), 300),
		},
	}, nil
}

func compileNativeRoot(provider string, c map[string]any) (PresentationNode, map[string]int, error) {
	background := stringValue(c, "backgroundColor", "#0E141B")
	foreground := stringValue(c, "foregroundColor", "#F5F7FA")
	// contentPadding and textScale are author percentages, not absolute units:
	// padding is a fraction of each edge (10 gives the content the center 80
	// percent) and textScale multiplies provider typography. "padding" stays on
	// the node for players that predate the percentage props; renderers that
	// understand "paddingPercent"/"textScale" must prefer those.
	paddingPercent := clampInt(intValue(c["contentPadding"], 10), 0, 40)
	textScale := clampInt(intValue(c["textScale"], 100), 25, 500)
	surface := PresentationNode{Type: "surface", Props: map[string]any{
		"backgroundColor": background,
		"padding":         paddingPercent,
		"paddingPercent":  paddingPercent,
		"textScale":       textScale,
	}}
	caps := map[string]int{"layout.surface": 1, "content.text": 1, "binding.core": 1, "format.typed": 1}
	text := func(binding PresentationBinding, role string) PresentationNode {
		return PresentationNode{Type: "text", Props: map[string]any{"color": foreground, "role": role}, Binding: &binding}
	}
	switch provider {
	case "clock":
		surface.Children = []PresentationNode{text(PresentationBinding{Source: "environment", Path: "currentTime", Format: "time:" + stringValue(c, "format", "locale") + ":" + strconv.FormatBool(boolValue(c["showSeconds"])) + ":" + stringValue(c, "timezone", "")}, "metric")}
		caps["environment.time"] = 1
	case "date":
		surface.Children = []PresentationNode{text(PresentationBinding{Source: "environment", Path: "currentTime", Format: "date:" + stringValue(c, "format", "locale") + ":" + stringValue(c, "timezone", "")}, "metric")}
		caps["environment.time"] = 1
	case "countdown":
		flags := ""
		for _, key := range []string{"showDays", "showHours", "showMinutes", "showSeconds"} {
			if boolValue(c[key]) {
				flags += "1"
			} else {
				flags += "0"
			}
		}
		countdown := text(PresentationBinding{Source: "environment", Path: "currentTime", Format: strings.Join([]string{
			"countdown", "v2", url.QueryEscape(stringValue(c, "target", "")), url.QueryEscape(stringValue(c, "timezone", "UTC")),
			stringValue(c, "mode", "countdown"), stringValue(c, "recurrence", "none"), stringValue(c, "completionAction", "completed_text"), flags,
			url.QueryEscape(stringValue(c, "completionText", "Complete")),
		}, ":")}, "metric")
		label := text(PresentationBinding{Source: "literal", Value: stringValue(c, "label", "")}, "label")
		switch stringValue(c, "layout", "stacked") {
		case "countdown_only":
			surface.Children = []PresentationNode{countdown}
		case "horizontal":
			surface.Children = []PresentationNode{{Type: "row", Props: map[string]any{"gap": 20, "justify": "center"}, Children: []PresentationNode{label, countdown}}}
			caps["layout.row"] = 1
		default:
			surface.Children = []PresentationNode{{Type: "column", Props: map[string]any{"gap": 8, "align": "center", "fill": false}, Children: []PresentationNode{label, countdown}}}
			caps["layout.column"] = 1
		}
		caps["format.typed"] = 2
		caps["environment.time"] = 1
	case "qrcode":
		surface.Children = []PresentationNode{{Type: "qr_code", Props: map[string]any{"errorCorrection": stringValue(c, "errorCorrection", "medium")}, Binding: &PresentationBinding{Source: "literal", Value: stringValue(c, "value", "")}}, text(PresentationBinding{Source: "literal", Value: stringValue(c, "label", "")}, "label")}
		caps["content.qr_code"] = 1
	case "world_clock":
		zones, _ := c["zones"].([]any)
		children := make([]PresentationNode, 0, len(zones))
		for _, rawZone := range zones {
			zone, _ := rawZone.(map[string]any)
			timeNode := text(PresentationBinding{Source: "environment", Path: "currentTime", Format: "time:" + stringValue(c, "format", "locale") + ":" + strconv.FormatBool(boolValue(c["showSeconds"])) + ":" + stringValue(zone, "timezone", "")}, "metric")
			zoneChildren := []PresentationNode{text(PresentationBinding{Source: "literal", Value: stringValue(zone, "label", "")}, "label"), timeNode}
			if boolValue(c["showDate"]) {
				zoneChildren = append(zoneChildren, text(PresentationBinding{Source: "environment", Path: "currentTime", Format: "date:medium:" + stringValue(zone, "timezone", "")}, "body"))
			}
			children = append(children, PresentationNode{Type: "column", Props: map[string]any{"card": true}, Children: zoneChildren})
		}
		surface.Children = []PresentationNode{{Type: "grid", Props: map[string]any{"columns": intValue(c["columns"], 2)}, Children: children}}
		caps["layout.grid"] = 1
		caps["environment.time"] = 1
	case "ticker":
		fields := stringSlice(c["fields"])
		if len(fields) == 0 {
			fields = []string{stringValue(c, "field", "title")}
		}
		surface.Children = []PresentationNode{{Type: "marquee", Props: map[string]any{"color": foreground, "speed": stringValue(c, "speed", "normal"), "direction": stringValue(c, "direction", "left")}, Binding: &PresentationBinding{Source: "dataset", Dataset: stringValue(c, "dataSourceId", "") + ":records", Fields: fields, Separator: stringValue(c, "separator", " • "), Fallback: stringValue(c, "emptyState", "")}}}
		caps["content.marquee"] = 1
	case "spotlight":
		data := stringValue(c, "dataSourceId", "") + ":records"
		children := []PresentationNode{}
		if variant := stringValue(c, "imageVariantId", ""); variant != "" {
			children = append(children, PresentationNode{Type: "asset_image", Props: map[string]any{"variantId": variant, "fit": "cover"}})
			caps["content.asset_image"] = 2
		}
		if field := stringValue(c, "badgeField", ""); field != "" {
			children = append(children, PresentationNode{Type: "badge", Binding: &PresentationBinding{Source: "dataset", Dataset: data, Path: field}})
			caps["content.badge"] = 1
		}
		for _, roleField := range [][2]string{{"title", stringValue(c, "titleField", "")}, {"subtitle", stringValue(c, "subtitleField", "")}, {"body", stringValue(c, "bodyField", "")}, {"label", stringValue(c, "dateField", "")}} {
			if roleField[1] != "" {
				children = append(children, text(PresentationBinding{Source: "dataset", Dataset: data, Path: roleField[1], Fallback: stringValue(c, "emptyState", "")}, roleField[0]))
			}
		}
		surface.Children = []PresentationNode{{Type: "column", Children: children}}
		caps["layout.column"] = 1
	case "stat_grid":
		data := stringValue(c, "dataSourceId", "") + ":records"
		metrics, _ := c["metrics"].([]any)
		children := make([]PresentationNode, 0, len(metrics))
		for _, rawMetric := range metrics {
			metric, _ := rawMetric.(map[string]any)
			labelBinding := PresentationBinding{Source: "literal", Value: stringValue(metric, "label", "")}
			if field := stringValue(metric, "labelField", ""); field != "" {
				labelBinding = PresentationBinding{Source: "dataset", Dataset: data, Path: field}
			}
			children = append(children, PresentationNode{Type: "column", Props: map[string]any{"card": true}, Children: []PresentationNode{
				text(labelBinding, "label"),
				text(PresentationBinding{Source: "dataset", Dataset: data, Path: stringValue(metric, "valueField", ""), Format: stringValue(metric, "format", "number"), Prefix: stringValue(metric, "prefix", ""), Suffix: stringValue(metric, "suffix", ""), Fallback: stringValue(c, "emptyState", "")}, "metric"),
			}})
		}
		surface.Children = []PresentationNode{{Type: "grid", Props: map[string]any{"columns": intValue(c["columns"], 2)}, Children: children}}
		caps["layout.grid"] = 1
	case "chart":
		series, _ := c["series"].([]any)
		fields, labels, colors := []string{}, []string{}, []string{}
		for _, rawSeries := range series {
			value, _ := rawSeries.(map[string]any)
			fields = append(fields, stringValue(value, "field", ""))
			labels = append(labels, stringValue(value, "label", stringValue(value, "field", "")))
			colors = append(colors, stringValue(value, "color", ""))
		}
		nodeType := stringValue(c, "chartType", "line") + "_chart"
		dataset := stringValue(c, "dataSourceId", "") + ":" + stringValue(c, "dataset", "records")
		surface.Children = []PresentationNode{{Type: nodeType, Props: map[string]any{"seriesLabels": labels, "seriesColors": colors, "categoryField": stringValue(c, "categoryField", ""), "timeField": stringValue(c, "timeField", ""), "showLegend": boolValue(c["showLegend"]), "showAxes": boolValue(c["showAxes"]), "minimum": c["minimum"], "maximum": c["maximum"]}, Binding: &PresentationBinding{Source: "dataset", Dataset: dataset, Fields: fields}}}
		caps["content."+nodeType] = 2
	case "progress":
		data := stringValue(c, "dataSourceId", "") + ":records"
		label := PresentationBinding{Source: "literal", Value: stringValue(c, "label", "")}
		if field := stringValue(c, "labelField", ""); field != "" {
			label = PresentationBinding{Source: "dataset", Dataset: data, Path: field}
		}
		target := c["staticTarget"]
		if field := stringValue(c, "targetField", ""); field != "" {
			target = field
		}
		surface.Children = []PresentationNode{
			text(label, "title"),
			{Type: "progress", Props: map[string]any{"target": target, "targetIsField": stringValue(c, "targetField", "") != "", "showPercent": boolValue(c["showPercent"]), "completionText": stringValue(c, "completionText", "")}, Binding: &PresentationBinding{Source: "dataset", Dataset: data, Path: stringValue(c, "valueField", "")}},
		}
		caps["content.progress"] = 2
	case "timeline":
		data := stringValue(c, "dataSourceId", "") + ":records"
		children := []PresentationNode{text(PresentationBinding{Source: "repeat", Path: stringValue(c, "dateField", "")}, "label"), text(PresentationBinding{Source: "repeat", Path: stringValue(c, "titleField", "")}, "title")}
		if field := stringValue(c, "bodyField", ""); field != "" {
			children = append(children, text(PresentationBinding{Source: "repeat", Path: field}, "body"))
		}
		if field := stringValue(c, "statusField", ""); field != "" {
			children = append(children, PresentationNode{Type: "badge", Binding: &PresentationBinding{Source: "repeat", Path: field}})
		}
		repeat := PresentationNode{Type: "repeat", Repeat: &PresentationRepeat{Dataset: data, Limit: intValue(c["maximumItems"], 8)}, Children: []PresentationNode{{Type: "row", Children: children}}}
		container := "column"
		if stringValue(c, "orientation", "vertical") == "horizontal" {
			container = "row"
		}
		surface.Children = []PresentationNode{{Type: container, Children: []PresentationNode{repeat}}}
		caps["collection.repeat"] = 2
		caps["layout."+container] = 1
	default:
		dataSourceID := stringValue(c, "dataSourceId", "")
		limit := intValue(c["maximumItems"], 20)
		fields := presentationFields(provider, c)
		if dataSourceID == "" || len(fields) == 0 {
			return PresentationNode{}, nil, errors.New("data-driven presentation is incomplete")
		}
		columns := make([]PresentationNode, 0, len(fields))
		for index, field := range fields {
			role := "body"
			if index == 0 {
				role = "title"
			}
			columns = append(columns, text(PresentationBinding{Source: "repeat", Path: field, Format: fieldFormat(c, field), Fallback: ""}, role))
		}
		itemType := "row"
		if provider == "cards" {
			itemType = "column"
		}
		repeat := PresentationNode{Type: "repeat", Repeat: &PresentationRepeat{Dataset: dataSourceID + ":records", Limit: limit}, Children: []PresentationNode{{Type: itemType, Children: columns}}}
		if provider == "cards" {
			surface.Children = []PresentationNode{{Type: "grid", Props: map[string]any{"columns": intValue(c["columns"], 1)}, Children: []PresentationNode{repeat}}}
			caps["layout.grid"] = 1
		} else {
			surface.Children = []PresentationNode{{Type: "column", Children: []PresentationNode{repeat}}}
			caps["layout.column"] = 1
			caps["layout.row"] = 1
		}
		caps["collection.repeat"] = 1
	}
	return surface, caps, nil
}

func presentationFields(provider string, c map[string]any) []string {
	switch provider {
	case "metric":
		return nonEmptyStrings(stringValue(c, "labelField", ""), stringValue(c, "valueField", ""), stringValue(c, "secondaryField", ""))
	case "cards":
		return nonEmptyStrings(stringValue(c, "badgeField", ""), stringValue(c, "titleField", ""), stringValue(c, "subtitleField", ""), stringValue(c, "bodyField", ""))
	case "weather":
		return []string{"date", "location", "temperature", "condition", "humidity", "windSpeed", "precipitation", "high", "low", "attribution"}
	case "agenda":
		return nonEmptyStrings(stringValue(c, "dateField", "date"), stringValue(c, "timeField", "startTime"), stringValue(c, "titleField", "title"), stringValue(c, "locationField", "location"), stringValue(c, "descriptionField", "description"))
	default:
		fields := stringSlice(c["fields"])
		if len(fields) == 0 {
			fields = nonEmptyStrings(stringValue(c, "leadingField", ""), stringValue(c, "primaryField", "title"), stringValue(c, "secondaryField", ""), stringValue(c, "trailingField", ""))
		}
		return fields
	}
}

func fieldFormat(c map[string]any, field string) string {
	if stringValue(c, "valueField", "") == field {
		return stringValue(c, "format", "")
	}
	return ""
}

func stringValue(values map[string]any, key, fallback string) string {
	if value, ok := values[key].(string); ok {
		return value
	}
	return fallback
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if value, ok := item.(string); ok && value != "" {
			result = append(result, value)
		}
	}
	return result
}

func nonEmptyStrings(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func intValue(value any, fallback int) int {
	if number, ok := value.(float64); ok {
		return int(number)
	}
	return fallback
}

func clampInt(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
