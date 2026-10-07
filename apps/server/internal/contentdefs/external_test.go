package contentdefs

import (
	"encoding/json"
	"testing"
)

// packageTestSource is the provenance an installed package contributes
// under: identity, active version, and pinned digest.
func packageTestSource() ExtensionSource {
	return PackageSource(
		"acme.kiosk",
		"1.2.0",
		"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	)
}

// nestedManifestJSON renders a release definition as a package nested
// manifest: the package-relative identity, manifest API version 1, and no
// source, as the bytes on disk carry them.
func nestedManifestJSON(t *testing.T, definition any, nestedID string) []byte {
	t.Helper()
	encoded, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["id"] = nestedID
	manifest["apiVersion"] = 1
	delete(manifest, "source")
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// packageWidgetJSON renders the template as a package-owned Widget
// manifest: its component type and tag move into the package namespace,
// since release component identities stay reserved.
func packageWidgetJSON(t *testing.T, template WidgetDefinition, nestedID string) []byte {
	t.Helper()
	raw := nestedManifestJSON(t, template, nestedID)
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	component, _ := manifest["component"].(map[string]any)
	if component == nil {
		t.Fatal("template Widget has no component")
	}
	component["type"] = "acme.kiosk." + nestedID
	component["tagName"] = "acme-kiosk-" + nestedID
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func widgetModuleTemplate(t *testing.T) WidgetDefinition {
	t.Helper()
	release := MustLoad()
	for _, definition := range release.Widgets {
		if definition.Component != nil {
			return definition
		}
	}
	t.Fatal("release catalog has no component Widget module")
	return WidgetDefinition{}
}

func dataSourceModuleTemplate(t *testing.T) DataSourceDefinition {
	t.Helper()
	release := MustLoad()
	if len(release.DataSources) == 0 {
		t.Fatal("release catalog has no Data Source definitions")
	}
	return release.DataSources[0]
}

func TestDecodePackageWidget(t *testing.T) {
	template := widgetModuleTemplate(t)
	raw := nestedManifestJSON(t, template, "lobby")
	definition, err := DecodePackageWidget("acme.kiosk", raw, packageTestSource())
	if err != nil {
		t.Fatal(err)
	}
	if definition.ID != "acme.kiosk.lobby" {
		t.Fatalf("definition ID = %q", definition.ID)
	}
	if definition.Source != packageTestSource() {
		t.Fatalf("definition source = %+v", definition.Source)
	}
	if definition.Component == nil {
		t.Fatal("decoded Widget lost its component")
	}
}

func TestDecodePackageWidgetRejects(t *testing.T) {
	template := widgetModuleTemplate(t)
	good := nestedManifestJSON(t, template, "lobby")
	cases := map[string]func() []byte{
		"corrupt": func() []byte { return []byte("{") },
		"dotted nested ID": func() []byte {
			return nestedManifestJSON(t, template, "acme.other")
		},
		"self-declared source": func() []byte {
			var manifest map[string]any
			if err := json.Unmarshal(good, &manifest); err != nil {
				t.Fatal(err)
			}
			manifest["source"] = map[string]any{"kind": "core"}
			raw, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			return raw
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodePackageWidget("acme.kiosk", mutate(), packageTestSource()); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
	if _, err := DecodePackageWidget("acme.kiosk", good, CoreSource()); err == nil {
		t.Fatal("expected a core source to be rejected")
	}
	if _, err := DecodePackageWidget("acme.kiosk", good, PackageSource("acme.other", "1.0.0", "sha256:abc")); err == nil {
		t.Fatal("expected another package's source to be rejected")
	}
}

func TestDecodePackageDataSource(t *testing.T) {
	template := dataSourceModuleTemplate(t)
	raw := nestedManifestJSON(t, template, "schedule")
	definition, err := DecodePackageDataSource("acme.kiosk", raw, packageTestSource())
	if err != nil {
		t.Fatal(err)
	}
	if definition.ID != "acme.kiosk.schedule" {
		t.Fatalf("definition ID = %q", definition.ID)
	}
	if definition.Source != packageTestSource() {
		t.Fatalf("definition source = %+v", definition.Source)
	}
	if _, err := DecodePackageDataSource("acme.kiosk", []byte("{"), packageTestSource()); err == nil {
		t.Fatal("expected corrupt JSON to be rejected")
	}
}

func TestWithExternal(t *testing.T) {
	release := MustLoad()
	widgetRaw := packageWidgetJSON(t, widgetModuleTemplate(t), "lobby")
	widget, err := DecodePackageWidget("acme.kiosk", widgetRaw, packageTestSource())
	if err != nil {
		t.Fatal(err)
	}
	sourceRaw := nestedManifestJSON(t, dataSourceModuleTemplate(t), "schedule")
	dataSource, err := DecodePackageDataSource("acme.kiosk", sourceRaw, packageTestSource())
	if err != nil {
		t.Fatal(err)
	}
	composed, err := release.WithExternal([]WidgetDefinition{widget}, []DataSourceDefinition{dataSource})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := composed.Widget("acme.kiosk.lobby"); !ok {
		t.Fatal("composed catalog lacks the external Widget")
	}
	if _, ok := composed.DataSource("acme.kiosk.schedule"); !ok {
		t.Fatal("composed catalog lacks the external Data Source")
	}
	if composed.Fingerprint == release.Fingerprint {
		t.Fatal("composed fingerprint matches the release")
	}
	if _, ok := release.Widget("acme.kiosk.lobby"); ok {
		t.Fatal("WithExternal mutated the release catalog")
	}
	if providers := composed.PackageWidgetProviders("acme.kiosk"); len(providers) != 1 || providers[0] != "acme.kiosk.lobby" {
		t.Fatalf("Widget providers = %v", providers)
	}
	if providers := composed.PackageDataSourceProviders("acme.kiosk"); len(providers) != 1 || providers[0] != "acme.kiosk.schedule" {
		t.Fatalf("Data Source providers = %v", providers)
	}
	if providers := composed.PackageWidgetProviders("acme.other"); len(providers) != 0 {
		t.Fatalf("other package providers = %v", providers)
	}
}

func TestWithExternalRejects(t *testing.T) {
	release := MustLoad()
	widgetRaw := packageWidgetJSON(t, widgetModuleTemplate(t), "lobby")
	widget, err := DecodePackageWidget("acme.kiosk", widgetRaw, packageTestSource())
	if err != nil {
		t.Fatal(err)
	}
	// A collision with a release identity fails the composition.
	clash := widget
	clash.ID = release.Widgets[0].ID
	if _, err := release.WithExternal([]WidgetDefinition{clash}, nil); err == nil {
		t.Fatal("expected a release collision to fail")
	}
	// A duplicate within the overlay fails the composition.
	if _, err := release.WithExternal([]WidgetDefinition{widget, widget}, nil); err == nil {
		t.Fatal("expected an overlay duplicate to fail")
	}
	// A non-package source fails the composition.
	core := widget
	core.Source = CoreSource()
	if _, err := release.WithExternal([]WidgetDefinition{core}, nil); err == nil {
		t.Fatal("expected a non-package source to fail")
	}
	// An identity outside the package namespace fails the composition.
	escape := widget
	escape.ID = "acme.other.lobby"
	if _, err := release.WithExternal([]WidgetDefinition{escape}, nil); err == nil {
		t.Fatal("expected a namespace escape to fail")
	}
	// An invalid definition fails the composition.
	broken := widget
	broken.Runtime = "quantum"
	if _, err := release.WithExternal([]WidgetDefinition{broken}, nil); err == nil {
		t.Fatal("expected an invalid definition to fail")
	}
}

func TestProvider(t *testing.T) {
	release := MustLoad()
	provider := NewProvider(release)
	if provider.Snapshot() != release {
		t.Fatal("provider does not serve the release catalog")
	}
	if _, ok := provider.Widget("no.such.widget"); ok {
		t.Fatal("provider reports an unknown Widget")
	}
	widgetRaw := packageWidgetJSON(t, widgetModuleTemplate(t), "lobby")
	widget, err := DecodePackageWidget("acme.kiosk", widgetRaw, packageTestSource())
	if err != nil {
		t.Fatal(err)
	}
	composed, err := release.WithExternal([]WidgetDefinition{widget}, nil)
	if err != nil {
		t.Fatal(err)
	}
	provider.Replace(composed)
	if provider.Snapshot() != composed {
		t.Fatal("provider did not swap the snapshot")
	}
	if _, ok := provider.Widget("acme.kiosk.lobby"); !ok {
		t.Fatal("provider lacks the external Widget after Replace")
	}
	if provider.CatalogFingerprint() != composed.Fingerprint {
		t.Fatal("provider fingerprint does not follow the snapshot")
	}
	provider.Replace(nil)
	if provider.Snapshot() != composed {
		t.Fatal("a nil Replace swapped the snapshot")
	}
}
