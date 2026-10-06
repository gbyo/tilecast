package contentdefs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"sync/atomic"

	"github.com/google/uuid"
)

// External package contributions (docs/content-extension-model.md §12-13).
//
// The release catalog is immutable. Installed packages join an effective
// catalog: the release definitions plus validated external definitions
// with package sources. Snapshots stay immutable; the Provider swaps them
// atomically so readers never lock.

// nestedIDPattern mirrors the package extractor's nested identity rule: a
// dotless segment the package ID qualifies. The extractor enforces this
// at activation; decoding enforces it again so a definition can never
// enter the catalog under an identity outside its package namespace.
var nestedIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,79}$`)

// PackageSource is the source of definitions contributed by an installed
// package: the package identity, the active version, and the pinned
// artifact digest.
func PackageSource(packageID, version, digest string) ExtensionSource {
	return ExtensionSource{
		Kind: SourceKindPackage, PackageID: packageID,
		PackageVersion: version, Digest: digest,
	}
}

// DecodePackageWidget decodes one package Widget manifest into a catalog
// definition. The nested manifest carries its package-relative identity;
// the definition is qualified under the package ID. The manifest cannot
// declare its own source, and the injected source must be a package
// source for this package.
func DecodePackageWidget(packageID string, raw []byte, source ExtensionSource) (WidgetDefinition, error) {
	nestedID, err := checkPackageManifest(raw, source, packageID, "tilecast.widget.json")
	if err != nil {
		return WidgetDefinition{}, err
	}
	var widget WidgetDefinition
	if err := json.Unmarshal(raw, &widget); err != nil {
		return WidgetDefinition{}, fmt.Errorf("%s: Widget manifest: %w", packageID, err)
	}
	if widget.Component == nil || widget.Compatibility == nil {
		return WidgetDefinition{}, fmt.Errorf("%s: a Widget module must declare component and compatibility", packageID)
	}
	widget.ID = packageID + "." + nestedID
	widget.Source = source
	return widget, nil
}

// DecodePackageDataSource decodes one package Data Source manifest into a
// catalog definition, qualified under the package ID like a Widget.
func DecodePackageDataSource(packageID string, raw []byte, source ExtensionSource) (DataSourceDefinition, error) {
	nestedID, err := checkPackageManifest(raw, source, packageID, "tilecast.datasource.json")
	if err != nil {
		return DataSourceDefinition{}, err
	}
	var dataSource DataSourceDefinition
	if err := json.Unmarshal(raw, &dataSource); err != nil {
		return DataSourceDefinition{}, fmt.Errorf("%s: Data Source manifest: %w", packageID, err)
	}
	dataSource.ID = packageID + "." + nestedID
	dataSource.Source = source
	return dataSource, nil
}

// checkPackageManifest enforces the package envelope rules shared by both
// contribution kinds: API version 1, no self-declared source, a matching
// package source, and a dotless nested identity that qualifies within the
// 80-character catalog limit. It answers the nested identity.
func checkPackageManifest(raw []byte, source ExtensionSource, packageID, file string) (string, error) {
	var nested struct {
		APIVersion int             `json:"apiVersion"`
		ID         string          `json:"id"`
		Source     ExtensionSource `json:"source"`
	}
	if err := json.Unmarshal(raw, &nested); err != nil {
		return "", fmt.Errorf("%s: %s is corrupt: %w", packageID, file, err)
	}
	if nested.APIVersion != 1 {
		return "", fmt.Errorf("%s: %s uses unsupported API version %d", packageID, file, nested.APIVersion)
	}
	if nested.Source != (ExtensionSource{}) {
		return "", fmt.Errorf("%s: a package manifest must not declare its own source", packageID)
	}
	if source.Normalized().Kind != SourceKindPackage || source.PackageID != packageID {
		return "", fmt.Errorf("%s: a package manifest needs its own package source", packageID)
	}
	if !nestedIDPattern.MatchString(nested.ID) {
		return "", fmt.Errorf("%s: %s has an invalid identity", packageID, file)
	}
	if len(packageID)+1+len(nested.ID) > 80 {
		return "", fmt.Errorf("%s: %s identity exceeds 80 characters", packageID, file)
	}
	return nested.ID, nil
}

// WithExternal returns the release catalog plus validated external
// definitions. Ownership, collisions, duplicates, and the full definition
// contract check here: anything invalid fails the composition, never a
// partial catalog. The receiver is unchanged.
func (c *Catalog) WithExternal(widgets []WidgetDefinition, dataSources []DataSourceDefinition) (*Catalog, error) {
	for _, definition := range widgets {
		if definition.Source.Normalized().Kind != SourceKindPackage {
			return nil, fmt.Errorf("external Widget %q is not package-sourced", definition.ID)
		}
		if !packageOwnsType(definition.Source.PackageID, definition.ID) {
			return nil, fmt.Errorf("external Widget %q falls outside its package namespace", definition.ID)
		}
	}
	for _, definition := range dataSources {
		if definition.Source.Normalized().Kind != SourceKindPackage {
			return nil, fmt.Errorf("external Data Source %q is not package-sourced", definition.ID)
		}
		if !packageOwnsType(definition.Source.PackageID, definition.ID) {
			return nil, fmt.Errorf("external Data Source %q falls outside its package namespace", definition.ID)
		}
	}
	composed := &Catalog{
		CompilerVersion: c.CompilerVersion,
		Widgets:         append(append([]WidgetDefinition{}, c.Widgets...), widgets...),
		DataSources:     append(append([]DataSourceDefinition{}, c.DataSources...), dataSources...),
		widgetsByID:     map[string]WidgetDefinition{},
		dataSourcesByID: map[string]DataSourceDefinition{},
	}
	for index := range composed.Widgets {
		composed.Widgets[index].Source = composed.Widgets[index].Source.Normalized()
	}
	for index := range composed.DataSources {
		composed.DataSources[index].Source = composed.DataSources[index].Source.Normalized()
	}
	if err := inheritPresentationBases(composed.Widgets); err != nil {
		return nil, err
	}
	if err := composed.validate(); err != nil {
		return nil, err
	}
	composed.Fingerprint = externalFingerprint(c.Fingerprint, widgets, dataSources)
	composed.Revision = composed.Fingerprint[:16]
	return composed, nil
}

// externalFingerprint chains the release fingerprint with the sorted
// external identities, versions, and digests, so any activation change
// moves the catalog revision that player manifests reconcile against.
func externalFingerprint(release string, widgets []WidgetDefinition, dataSources []DataSourceDefinition) string {
	entries := make([]string, 0, len(widgets)+len(dataSources))
	for _, definition := range widgets {
		entries = append(entries, "widget\x00"+definition.ID+"\x00"+definition.Source.FingerprintString())
	}
	for _, definition := range dataSources {
		entries = append(entries, "data-source\x00"+definition.ID+"\x00"+definition.Source.FingerprintString())
	}
	sort.Strings(entries)
	hasher := sha256.New()
	hasher.Write([]byte(release))
	for _, entry := range entries {
		hasher.Write([]byte(entry))
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

// PackageWidgetProviders reports the Widget IDs one installed package
// contributes, in sorted order.
func (c *Catalog) PackageWidgetProviders(packageID string) []string {
	providers := []string{}
	for _, definition := range c.Widgets {
		source := definition.Source.Normalized()
		if source.Kind == SourceKindPackage && source.PackageID == packageID {
			providers = append(providers, definition.ID)
		}
	}
	sort.Strings(providers)
	return providers
}

// PackageDataSourceProviders reports the Data Source IDs one installed
// package contributes, in sorted order.
func (c *Catalog) PackageDataSourceProviders(packageID string) []string {
	providers := []string{}
	for _, definition := range c.DataSources {
		source := definition.Source.Normalized()
		if source.Kind == SourceKindPackage && source.PackageID == packageID {
			providers = append(providers, definition.ID)
		}
	}
	sort.Strings(providers)
	return providers
}

// Catalogs is the read surface services use: the release catalog and the
// effective provider both satisfy it, so call sites never know whether
// external definitions joined. Snapshot returns the immutable catalog for
// whole-catalog consumers such as Studio gallery serving.
type Catalogs interface {
	Widget(id string) (WidgetDefinition, bool)
	DataSource(id string) (DataSourceDefinition, bool)
	WidgetDataSourceIDs(provider string, raw json.RawMessage) []uuid.UUID
	CatalogFingerprint() string
	PluginWidgetProviders(pluginID string) []string
	PluginDataSourceProviders(pluginID string) []string
	StaticWidgetContributors() []string
	StaticDataSourceContributors() []string
	PackageWidgetProviders(packageID string) []string
	PackageDataSourceProviders(packageID string) []string
	Snapshot() *Catalog
}

var (
	_ Catalogs = (*Catalog)(nil)
	_ Catalogs = (*Provider)(nil)
)

// CatalogFingerprint reports the fingerprint through the Catalogs
// interface. The field stays for direct release-catalog reads.
func (c *Catalog) CatalogFingerprint() string { return c.Fingerprint }

// Snapshot returns the receiver: a release catalog is its own snapshot.
func (c *Catalog) Snapshot() *Catalog { return c }

// Provider serves the effective catalog: the release catalog plus
// installed package contributions. Snapshots are immutable and swap
// atomically; readers never lock and never see a partial composition.
type Provider struct {
	current atomic.Pointer[Catalog]
}

// NewProvider serves the release catalog until external definitions
// replace it.
func NewProvider(release *Catalog) *Provider {
	provider := &Provider{}
	provider.current.Store(release)
	return provider
}

// Replace swaps the effective snapshot. Compositions come from
// WithExternal; a nil catalog is rejected.
func (p *Provider) Replace(next *Catalog) {
	if next == nil {
		return
	}
	p.current.Store(next)
}

// Snapshot returns the current immutable catalog.
func (p *Provider) Snapshot() *Catalog { return p.current.Load() }

func (p *Provider) Widget(id string) (WidgetDefinition, bool) {
	return p.current.Load().Widget(id)
}

func (p *Provider) DataSource(id string) (DataSourceDefinition, bool) {
	return p.current.Load().DataSource(id)
}

func (p *Provider) WidgetDataSourceIDs(provider string, raw json.RawMessage) []uuid.UUID {
	return p.current.Load().WidgetDataSourceIDs(provider, raw)
}

func (p *Provider) CatalogFingerprint() string {
	return p.current.Load().Fingerprint
}

func (p *Provider) PluginWidgetProviders(pluginID string) []string {
	return p.current.Load().PluginWidgetProviders(pluginID)
}

func (p *Provider) PluginDataSourceProviders(pluginID string) []string {
	return p.current.Load().PluginDataSourceProviders(pluginID)
}

func (p *Provider) StaticWidgetContributors() []string {
	return p.current.Load().StaticWidgetContributors()
}

func (p *Provider) StaticDataSourceContributors() []string {
	return p.current.Load().StaticDataSourceContributors()
}

func (p *Provider) PackageWidgetProviders(packageID string) []string {
	return p.current.Load().PackageWidgetProviders(packageID)
}

func (p *Provider) PackageDataSourceProviders(packageID string) []string {
	return p.current.Load().PackageDataSourceProviders(packageID)
}
