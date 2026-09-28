package media

// The provider registry is a closed, code-only catalogue. Each provider declares a role
// (widget or data_source) and its capabilities. Unknown providers, arbitrary configuration
// keys, scripts, HTML templates, and executable expressions are rejected by the normalizers.
//
// Plugin-owned Data Source providers are contributed at startup instead of being listed
// here; see Service.SetDataSourceProviders.

import (
	"maps"
	"slices"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

type ProviderRole string

const (
	RoleWidget     ProviderRole = "widget"
	RoleDataSource ProviderRole = "data_source"
)

// ProviderDescriptor captures the fixed capabilities of one provider.
type ProviderDescriptor struct {
	ID                          string
	Role                        ProviderRole
	Renderable                  bool
	RequiresDataSource          bool
	ProducesFields              bool
	SupportsDateSelection       bool
	RecordBased                 bool
	Temporal                    bool
	Numeric                     bool
	Weather                     bool
	AcceptedDataSourceProviders []string
}

type ProviderCatalogEntry struct {
	ID                   string            `json:"id"`
	Role                 ProviderRole      `json:"role"`
	Label                string            `json:"label"`
	Group                string            `json:"group"`
	Description          string            `json:"description"`
	PresentationKind     string            `json:"presentationKind,omitempty"`
	Capabilities         map[string]bool   `json:"capabilities"`
	RequiredCapabilities map[string]int    `json:"requiredCapabilities,omitempty"`
	UIHints              map[string]string `json:"uiHints"`
}

var dataSourceProviderRegistry = map[string]ProviderDescriptor{
	// Data Sources — provide data, never rendered directly.
	"calendar":    {ID: "calendar", Role: RoleDataSource, ProducesFields: true, RecordBased: true, Temporal: true},
	"rss":         {ID: "rss", Role: RoleDataSource, ProducesFields: true, SupportsDateSelection: true, RecordBased: true},
	"atom":        {ID: "atom", Role: RoleDataSource, ProducesFields: true, SupportsDateSelection: true, RecordBased: true},
	"feed":        {ID: "feed", Role: RoleDataSource, ProducesFields: true, SupportsDateSelection: true, RecordBased: true},
	"json":        {ID: "json", Role: RoleDataSource, ProducesFields: true, SupportsDateSelection: true, RecordBased: true, Temporal: true, Numeric: true},
	"csv":         {ID: "csv", Role: RoleDataSource, ProducesFields: true, SupportsDateSelection: true, RecordBased: true, Temporal: true, Numeric: true},
	"manual":      {ID: "manual", Role: RoleDataSource, ProducesFields: true, SupportsDateSelection: true, RecordBased: true, Temporal: true, Numeric: true},
	"weather":     {ID: "weather", Role: RoleDataSource, ProducesFields: true, RecordBased: true, Temporal: true, Numeric: true, Weather: true},
	"transit":     {ID: "transit", Role: RoleDataSource, ProducesFields: true, RecordBased: true, Temporal: true},
	"cap_alerts":  {ID: "cap_alerts", Role: RoleDataSource, ProducesFields: true, RecordBased: true, Temporal: true},
	"air_quality": {ID: "air_quality", Role: RoleDataSource, ProducesFields: true, RecordBased: true, Temporal: true, Numeric: true},
}

// Plugin-owned providers overlay the static table above. Their traits come
// from the registered contribution; core never names them here.
func contributedDescriptor(provider plugin.DataSourceProvider) ProviderDescriptor {
	traits := provider.Traits()
	return ProviderDescriptor{
		ID: provider.ProviderID(), Role: RoleDataSource,
		ProducesFields: traits.ProducesFields, SupportsDateSelection: traits.SupportsDateSelection,
		RecordBased: traits.RecordBased, Temporal: traits.Temporal, Numeric: traits.Numeric,
	}
}

var widgetProviderRegistry = map[string]ProviderDescriptor{
	// Standalone Widgets — display content without a Data Source.
	"website":   {ID: "website", Role: RoleWidget, Renderable: true},
	"youtube":   {ID: "youtube", Role: RoleWidget, Renderable: true},
	"clock":     {ID: "clock", Role: RoleWidget, Renderable: true},
	"date":      {ID: "date", Role: RoleWidget, Renderable: true},
	"qrcode":    {ID: "qrcode", Role: RoleWidget, Renderable: true},
	"countdown": {ID: "countdown", Role: RoleWidget, Renderable: true, Temporal: true},

	// Data-driven Widgets — display one compatible Data Source.
	"ticker":      {ID: "ticker", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true},
	"menu":        {ID: "menu", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true},
	"list":        {ID: "list", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true},
	"table":       {ID: "table", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true},
	"agenda":      {ID: "agenda", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true, Temporal: true},
	"metric":      {ID: "metric", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true, Numeric: true},
	"cards":       {ID: "cards", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true},
	"weather":     {ID: "weather", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true, Weather: true},
	"spotlight":   {ID: "spotlight", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true},
	"stat_grid":   {ID: "stat_grid", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true, Numeric: true},
	"chart":       {ID: "chart", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true, Numeric: true},
	"progress":    {ID: "progress", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true, Numeric: true},
	"timeline":    {ID: "timeline", Role: RoleWidget, Renderable: true, RequiresDataSource: true, RecordBased: true, Temporal: true},
	"world_clock": {ID: "world_clock", Role: RoleWidget, Renderable: true},
}

// IsStaticDataSourceProvider reports whether id is a built-in core Data
// Source provider. Plugin contributions must not reuse one: a contributed
// provider overlays the static table, so a collision would silently redefine
// core behavior. The plugin host enforces this at startup.
func IsStaticDataSourceProvider(id string) bool {
	_, ok := dataSourceProviderRegistry[id]
	return ok
}

func lookupProvider(id string) (ProviderDescriptor, bool) {
	if descriptor, ok := widgetProviderRegistry[id]; ok {
		return descriptor, true
	}
	descriptor, ok := dataSourceProviderRegistry[id]
	return descriptor, ok
}

func isWidgetProvider(id string) bool {
	_, ok := widgetProviderRegistry[id]
	return ok
}

func isDataSourceProvider(id string) bool {
	_, ok := dataSourceProviderRegistry[id]
	return ok
}

// dataSourceProviderAccepted reports whether a data-driven widget accepts a given
// Data Source provider. Plugin-owned providers match on their contributed
// traits; everything else matches on the static table.
func (s *Service) dataSourceProviderAccepted(widgetProvider, dataSourceProvider string) bool {
	widget, ok := widgetProviderRegistry[widgetProvider]
	if !ok {
		return false
	}
	source, ok := s.effectiveDataSourceDescriptor(dataSourceProvider)
	if !ok {
		return false
	}
	for _, p := range widget.AcceptedDataSourceProviders {
		if p == dataSourceProvider {
			return true
		}
	}
	if len(widget.AcceptedDataSourceProviders) > 0 {
		return false
	}
	if widget.Weather {
		return source.Weather
	}
	if widget.Numeric {
		return source.RecordBased && source.Numeric
	}
	if widget.Temporal {
		return source.RecordBased && source.Temporal
	}
	return widget.RecordBased && source.RecordBased
}

// effectiveDataSourceDescriptor resolves a provider's compatibility traits:
// a registered plugin contribution first, the static table otherwise.
func (s *Service) effectiveDataSourceDescriptor(id string) (ProviderDescriptor, bool) {
	if provider, ok := s.contributedProvider(id); ok {
		return contributedDescriptor(provider), true
	}
	descriptor, ok := dataSourceProviderRegistry[id]
	return descriptor, ok
}

// ProviderCatalog lists every Widget and Data Source provider Studio may
// offer. Plugin-owned providers append after the built-in sources in
// registration order, carrying their canonical authoring surface in the UI
// hints so generic Studio code can redirect without naming the provider.
func (s *Service) ProviderCatalog() []ProviderCatalogEntry {
	contributed := map[string]plugin.DataSourceProvider{}
	if s != nil {
		contributed = s.contributed
	}
	result := make([]ProviderCatalogEntry, 0, len(widgetProviderRegistry)+len(dataSourceProviderRegistry)+len(contributed))
	for _, id := range []string{"website", "youtube", "clock", "date", "qrcode", "countdown", "world_clock", "ticker", "menu", "list", "table", "agenda", "metric", "cards", "weather", "spotlight", "stat_grid", "chart", "progress", "timeline"} {
		descriptor := widgetProviderRegistry[id]
		label, group, description := providerCopy(id, RoleWidget)
		kind := "native"
		required := map[string]int{"presentation.schema": 1}
		if id == "website" || id == "youtube" {
			kind = "web"
			required["web.remote"] = 1
		} else {
			required["binding.core"] = 2
		}
		result = append(result, ProviderCatalogEntry{
			ID: id, Role: RoleWidget, Label: label, Group: group, Description: description,
			PresentationKind: kind, Capabilities: descriptorCapabilities(descriptor),
			RequiredCapabilities: required, UIHints: map[string]string{"editor": id, "preview": "compiled"},
		})
	}
	for _, id := range []string{"calendar", "rss", "atom", "feed", "json", "csv", "manual", "weather", "transit", "cap_alerts", "air_quality"} {
		descriptor := dataSourceProviderRegistry[id]
		label, group, description := providerCopy(id, RoleDataSource)
		result = append(result, ProviderCatalogEntry{
			ID: id, Role: RoleDataSource, Label: label, Group: group, Description: description,
			Capabilities: descriptorCapabilities(descriptor), UIHints: map[string]string{"editor": id, "preview": "records"},
		})
	}
	for _, id := range slices.Sorted(maps.Keys(contributed)) {
		provider := contributed[id]
		label, group, description := provider.Catalog()
		hints := map[string]string{"editor": id, "preview": "records"}
		if editor := provider.CanonicalEditor(); editor != "" {
			hints["canonicalEditor"] = editor
		}
		if creator := provider.CanonicalCreator(); creator != "" {
			hints["canonicalCreator"] = creator
		}
		if provider.HiddenFromGallery() {
			hints["gallery"] = "hidden"
		}
		result = append(result, ProviderCatalogEntry{
			ID: id, Role: RoleDataSource, Label: label, Group: group, Description: description,
			Capabilities: descriptorCapabilities(contributedDescriptor(provider)), UIHints: hints,
		})
	}
	return result
}

func descriptorCapabilities(d ProviderDescriptor) map[string]bool {
	return map[string]bool{
		"recordBased": d.RecordBased, "temporal": d.Temporal, "numeric": d.Numeric,
		"weather": d.Weather, "dateSelection": d.SupportsDateSelection,
	}
}

func providerCopy(id string, role ProviderRole) (string, string, string) {
	copy := map[string][3]string{
		"website":     {"Website", "Web and video", "Display an approved public webpage."},
		"youtube":     {"YouTube", "Web and video", "Play a public YouTube video or playlist."},
		"clock":       {"Clock", "Essentials", "Show live local time in a configured timezone."},
		"date":        {"Date", "Essentials", "Show a localized calendar date."},
		"qrcode":      {"QR Code", "Essentials", "Display text or a URL as a scannable code."},
		"countdown":   {"Countdown", "Essentials", "Count down to or up from a date and time."},
		"ticker":      {"Ticker", "Data-driven", "Scroll selected fields from a Data Source."},
		"menu":        {"Menu / Price Board", "Data-driven", "Display fields or label/value rows."},
		"list":        {"List", "Data-driven", "Display flexible primary and secondary rows."},
		"table":       {"Table", "Data-driven", "Display typed records in configurable columns."},
		"agenda":      {"Agenda", "Data-driven", "Group temporal records into an agenda."},
		"metric":      {"Metric", "Data-driven", "Highlight a numeric value and supporting label."},
		"cards":       {"Cards", "Data-driven", "Display records in a responsive card grid."},
		"weather":     {"Weather", "Data-driven", "Display current conditions and forecast records."},
		"spotlight":   {"Spotlight", "Data Display", "Feature one record with optional uploaded artwork."},
		"stat_grid":   {"Stat Grid", "Data Display", "Display a responsive grid of numeric values."},
		"chart":       {"Chart", "Data Display", "Plot record or time-series values as a line, bar, or area chart."},
		"progress":    {"Progress", "Data Display", "Show progress toward a numeric target."},
		"timeline":    {"Timeline", "Schedules", "Display ordered dated milestones and statuses."},
		"world_clock": {"World Clock", "Essentials", "Show live time in multiple configured timezones."},
		"calendar":    {"Calendar", "Feeds", "Project public calendar events into typed records."},
		"rss":         {"RSS", "Feeds", "Project a public RSS feed into typed records."},
		"atom":        {"Atom", "Feeds", "Project a public Atom feed into typed records."},
		"feed":        {"RSS / Atom Feed", "Feeds", "Project a public RSS or Atom feed into typed records."},
		"json":        {"JSON", "Structured", "Map public JSON into typed records."},
		"csv":         {"CSV", "Structured", "Map uploaded or public CSV into typed records."},
		"manual":      {"Manual Table", "Structured", "Maintain a bounded typed table in Studio."},
		"transit":     {"Transit", "Live Information", "Join public GTFS schedules with realtime departures and alerts."},
		"cap_alerts":  {"CAP Alerts", "Live Information", "Display active public Common Alerting Protocol warnings."},
		"air_quality": {"Air Quality", "Live Information", "Display current and forecast air-quality measurements."},
	}
	if id == "weather" && role == RoleDataSource {
		return "Weather", "External", "Fetch and normalize public MET Norway forecasts."
	}
	value := copy[id]
	return value[0], value[1], value[2]
}
