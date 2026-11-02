package updates

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestParseAndVerifyManifest(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(Manifest{SchemaVersion: 1, Product: "tilecast-player", ApplicationID: ApplicationID, VersionCode: 9, VersionName: "0.9.0", Channel: "stable", MinimumSDK: 23, APKAssetName: "tilecast-player.apk", APKSizeBytes: 42, APKSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SigningCertificateSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw)))
	manifest, err := ParseAndVerifyManifest(raw, signature, public)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.VersionCode != 9 {
		t.Fatalf("version code = %d", manifest.VersionCode)
	}
	raw[0] ^= 1
	if _, err := ParseAndVerifyManifest(raw, signature, public); err == nil {
		t.Fatal("tampered manifest accepted")
	}
}

func TestManifestRejectsWrongApplicationAndDowngrade(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	for _, test := range []Manifest{
		{SchemaVersion: 1, Product: "tilecast-player", ApplicationID: "other.app", VersionCode: 9, VersionName: "0.9", Channel: "stable", MinimumSDK: 23, APKAssetName: "tilecast-player.apk", APKSizeBytes: 1, APKSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SigningCertificateSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		{SchemaVersion: 1, Product: "tilecast-player", ApplicationID: ApplicationID, VersionCode: 5, VersionName: "0.5", Channel: "stable", MinimumSDK: 23, APKAssetName: "tilecast-player.apk", APKSizeBytes: 1, APKSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SigningCertificateSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
	} {
		raw, _ := json.Marshal(test)
		signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw)))
		if _, err := ParseAndVerifyManifest(raw, signature, public); err == nil {
			t.Fatal("unsafe manifest accepted")
		}
	}
}

func TestParseAndVerifyManifestLinux(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	sign := func(m Manifest) []byte {
		raw, _ := json.Marshal(m)
		return raw
	}
	sig := func(raw []byte) []byte {
		return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw)))
	}

	good := Manifest{SchemaVersion: 1, Product: "tilecast-player", Platform: PlatformLinux, VersionCode: 1000, VersionName: "0.1.0", Channel: "stable", ArtifactAssetName: LinuxArtifactName, ArtifactSizeBytes: 4096, ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
	raw := sign(good)
	manifest, err := ParseAndVerifyManifest(raw, sig(raw), public)
	if err != nil {
		t.Fatalf("valid linux manifest rejected: %v", err)
	}
	if manifest.NormalizedPlatform() != PlatformLinux || manifest.AssetName() != LinuxArtifactName || manifest.ArtifactSize() != 4096 {
		t.Fatalf("linux manifest accessors wrong: %+v", manifest)
	}

	for name, bad := range map[string]Manifest{
		"android fields present": {SchemaVersion: 1, Product: "tilecast-player", Platform: PlatformLinux, VersionCode: 1000, VersionName: "0.1.0", Channel: "stable", ArtifactAssetName: LinuxArtifactName, ArtifactSizeBytes: 1, ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", ApplicationID: ApplicationID},
		"wrong artifact name":    {SchemaVersion: 1, Product: "tilecast-player", Platform: PlatformLinux, VersionCode: 1000, VersionName: "0.1.0", Channel: "stable", ArtifactAssetName: "tilecast-player.deb", ArtifactSizeBytes: 1, ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
		"zero size":              {SchemaVersion: 1, Product: "tilecast-player", Platform: PlatformLinux, VersionCode: 1000, VersionName: "0.1.0", Channel: "stable", ArtifactAssetName: LinuxArtifactName, ArtifactSizeBytes: 0, ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
	} {
		raw := sign(bad)
		if _, err := ParseAndVerifyManifest(raw, sig(raw), public); err == nil {
			t.Fatalf("invalid linux manifest accepted: %s", name)
		}
	}

	// An Android manifest must not carry Linux artifact fields.
	mixed := Manifest{SchemaVersion: 1, Product: "tilecast-player", ApplicationID: ApplicationID, VersionCode: 9, VersionName: "0.9.0", Channel: "stable", MinimumSDK: 23, APKAssetName: AndroidArtifactName, APKSizeBytes: 42, APKSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SigningCertificateSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ArtifactAssetName: LinuxArtifactName}
	rawMixed := sign(mixed)
	if _, err := ParseAndVerifyManifest(rawMixed, sig(rawMixed), public); err == nil {
		t.Fatal("android manifest carrying linux fields accepted")
	}
}

func TestManifestRejectsTrailingJSON(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	raw, _ := json.Marshal(Manifest{SchemaVersion: 1, Product: "tilecast-player", ApplicationID: ApplicationID, VersionCode: 9, VersionName: "0.9.0", Channel: "stable", MinimumSDK: 23, APKAssetName: "tilecast-player.apk", APKSizeBytes: 42, APKSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SigningCertificateSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	raw = append(raw, []byte(` {}`)...)
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw)))
	if _, err := ParseAndVerifyManifest(raw, signature, public); err == nil {
		t.Fatal("multiple JSON values were accepted")
	}
}

func edgeEnvelope() Manifest {
	return Manifest{SchemaVersion: 1, Product: EdgeProduct, PlayerFamily: FamilyEdge, Platform: PlatformLinux, Arch: "x86_64", VersionCode: 2000, VersionName: "0.2.0", Channel: "stable", ArtifactAssetName: "tilecast-edge-0.2.0-x86_64.tar.zst", ArtifactSizeBytes: 4096, ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", ReleaseManifestSHA256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", SBOMSHA256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", StateSchemaVersion: 6}
}

func TestParseAndVerifyManifestEdge(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	sign := func(m Manifest) ([]byte, []byte) {
		raw, _ := json.Marshal(m)
		return raw, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw)))
	}
	raw, signature := sign(edgeEnvelope())
	manifest, err := ParseAndVerifyManifest(raw, signature, public)
	if err != nil {
		t.Fatalf("valid edge envelope rejected: %v", err)
	}
	if manifest.NormalizedFamily() != FamilyEdge || manifest.Architecture() != "x86_64" || manifest.AssetName() != "tilecast-edge-0.2.0-x86_64.tar.zst" || manifest.ArtifactSize() != 4096 {
		t.Fatalf("edge accessors wrong: %+v", manifest)
	}

	for name, change := range map[string]func(*Manifest){
		"electron product":        func(m *Manifest) { m.Product = "tilecast-player" },
		"android platform":        func(m *Manifest) { m.Platform = PlatformAndroid },
		"unknown architecture":    func(m *Manifest) { m.Arch = "riscv64" },
		"code not from name":      func(m *Manifest) { m.VersionCode = 2001 },
		"artifact name":           func(m *Manifest) { m.ArtifactAssetName = LinuxArtifactName },
		"artifact for other arch": func(m *Manifest) { m.ArtifactAssetName = "tilecast-edge-0.2.0-aarch64.tar.zst" },
		"uppercase digest": func(m *Manifest) {
			m.ArtifactSHA256 = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
		},
		"missing manifest digest": func(m *Manifest) { m.ReleaseManifestSHA256 = "" },
		"missing state schema":    func(m *Manifest) { m.StateSchemaVersion = 0 },
		"android fields":          func(m *Manifest) { m.ApplicationID = ApplicationID },
		"too large":               func(m *Manifest) { m.ArtifactSizeBytes = EdgeMaxArtifactBytes + 1 },
	} {
		bad := edgeEnvelope()
		change(&bad)
		raw, signature := sign(bad)
		if _, err := ParseAndVerifyManifest(raw, signature, public); err == nil {
			t.Fatalf("invalid edge envelope accepted: %s", name)
		}
	}

	// An Electron manifest that claims the edge family, or carries edge
	// fields, is refused: a family never changes by adding a field.
	electron := Manifest{SchemaVersion: 1, Product: "tilecast-player", Platform: PlatformLinux, VersionCode: 1000, VersionName: "0.1.0", Channel: "stable", ArtifactAssetName: LinuxArtifactName, ArtifactSizeBytes: 4096, ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
	for name, change := range map[string]func(*Manifest){
		"android family on linux": func(m *Manifest) { m.PlayerFamily = FamilyAndroid },
		"edge field":              func(m *Manifest) { m.StateSchemaVersion = 3 },
	} {
		bad := electron
		change(&bad)
		raw, signature := sign(bad)
		if _, err := ParseAndVerifyManifest(raw, signature, public); err == nil {
			t.Fatalf("electron manifest accepted: %s", name)
		}
	}
	electron.PlayerFamily = FamilyElectronLinux
	raw, signature = sign(electron)
	if manifest, err := ParseAndVerifyManifest(raw, signature, public); err != nil || manifest.NormalizedFamily() != FamilyElectronLinux {
		t.Fatalf("explicit electron-linux family rejected: %v", err)
	}
}

func windowsEnvelope() Manifest {
	return Manifest{SchemaVersion: 1, Product: WindowsProduct, PlayerFamily: FamilyWindows, Platform: PlatformWindows, Arch: "aarch64", VersionCode: 2000, VersionName: "0.2.0", Channel: "stable", ArtifactAssetName: "tilecast-windows-0.2.0-aarch64.msix", ArtifactSizeBytes: 4096, ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
}

func TestParseAndVerifyManifestWindows(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	sign := func(m Manifest) ([]byte, []byte) {
		raw, _ := json.Marshal(m)
		return raw, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw)))
	}
	raw, signature := sign(windowsEnvelope())
	manifest, err := ParseAndVerifyManifest(raw, signature, public)
	if err != nil {
		t.Fatalf("valid windows envelope rejected: %v", err)
	}
	if manifest.NormalizedFamily() != FamilyWindows || manifest.Architecture() != "aarch64" || manifest.AssetName() != "tilecast-windows-0.2.0-aarch64.msix" || manifest.ArtifactSize() != 4096 {
		t.Fatalf("windows accessors wrong: %+v", manifest)
	}
	if manifestApplicationID(manifest) != nil || manifestMinimumSDK(manifest) != nil {
		t.Fatalf("windows manifest carries android metadata: %+v", manifest)
	}

	for name, change := range map[string]func(*Manifest){
		"edge product":            func(m *Manifest) { m.Product = EdgeProduct },
		"electron product":        func(m *Manifest) { m.Product = "tilecast-player" },
		"linux platform":          func(m *Manifest) { m.Platform = PlatformLinux },
		"unknown architecture":    func(m *Manifest) { m.Arch = "riscv64" },
		"code not from name":      func(m *Manifest) { m.VersionCode = 2001 },
		"artifact name":           func(m *Manifest) { m.ArtifactAssetName = LinuxArtifactName },
		"artifact for other arch": func(m *Manifest) { m.ArtifactAssetName = "tilecast-windows-0.2.0-x86_64.msix" },
		"uppercase digest": func(m *Manifest) {
			m.ArtifactSHA256 = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
		},
		"edge manifest digest": func(m *Manifest) {
			m.ReleaseManifestSHA256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
		},
		"edge sbom digest": func(m *Manifest) {
			m.SBOMSHA256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
		},
		"edge state schema": func(m *Manifest) { m.StateSchemaVersion = 6 },
		"android fields":    func(m *Manifest) { m.ApplicationID = ApplicationID },
		"too large":         func(m *Manifest) { m.ArtifactSizeBytes = WindowsMaxArtifactBytes + 1 },
	} {
		bad := windowsEnvelope()
		change(&bad)
		raw, signature := sign(bad)
		if _, err := ParseAndVerifyManifest(raw, signature, public); err == nil {
			t.Fatalf("invalid windows envelope accepted: %s", name)
		}
	}

	// A Windows platform without the Windows family never validates as a
	// legacy manifest: Windows releases are always envelopes.
	legacy := windowsEnvelope()
	legacy.PlayerFamily = ""
	legacy.Product = "tilecast-player"
	raw, signature = sign(legacy)
	if _, err := ParseAndVerifyManifest(raw, signature, public); err == nil {
		t.Fatal("windows platform without windows family accepted")
	}
}

func TestScreenMatchesRelease(t *testing.T) {
	families := []string{FamilyAndroid, FamilyElectronLinux, FamilyEdge, FamilyWindows}
	arches := []string{"", "x86_64", "aarch64"}
	for _, releaseFamily := range families {
		for _, releaseArch := range arches {
			if ArchitectureRequired(releaseFamily) == (releaseArch == "") {
				continue
			}
			for _, screenFamily := range families {
				for _, screenArch := range arches {
					got := ScreenMatchesRelease(releaseFamily, releaseArch, screenFamily, screenArch)
					want := releaseFamily == screenFamily && (!ArchitectureRequired(releaseFamily) || screenArch == releaseArch)
					if got != want {
						t.Fatalf("ScreenMatchesRelease(%q,%q,%q,%q) = %v, want %v", releaseFamily, releaseArch, screenFamily, screenArch, got, want)
					}
				}
			}
		}
	}
}

func TestArchitectureRequired(t *testing.T) {
	if ArchitectureRequired(FamilyAndroid) || ArchitectureRequired(FamilyElectronLinux) {
		t.Fatal("android and electron-linux must stay architecture-neutral")
	}
	if !ArchitectureRequired(FamilyEdge) || !ArchitectureRequired(FamilyWindows) {
		t.Fatal("edge and windows must require an architecture")
	}
}

func TestEdgeVersionCodeMatchesTheReleaseBuild(t *testing.T) {
	for name, want := range map[string]int64{"0.1.0": 1000, "0.2.1-preview.1": 2001, "0.26.0-beta.1": 2600001, "0.26.0": 2600099} {
		if got, ok := EdgeVersionCode(name); !ok || got != want {
			t.Fatalf("%s: got %d %v", name, got, ok)
		}
	}
	for _, bad := range []string{"1.2", "v1.2.3", "1.2000.0", "1.2.3-", "1.2.3-rc_1", "1.2.3-rc.1"} {
		if _, ok := EdgeVersionCode(bad); ok {
			t.Fatalf("%s accepted", bad)
		}
	}
}

// The contract with the release build and the players: an envelope that
// apps/edge/release/envelope.py wrote and OpenSSL signed is accepted here,
// as edge_release::envelope accepts it.
func TestEdgeEnvelopeFromTheReleaseBuild(t *testing.T) {
	dir := "../../../../packages/edge-protocol/fixtures/update-envelope/"
	raw, err := os.ReadFile(dir + "envelope.json")
	if err != nil {
		t.Fatal(err)
	}
	signature, _ := os.ReadFile(dir + "envelope.json.sig")
	encodedKey, _ := os.ReadFile(dir + "public-key")
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encodedKey)))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ParseAndVerifyManifest(raw, signature, ed25519.PublicKey(key))
	if err != nil {
		t.Fatalf("release-build envelope rejected: %v", err)
	}
	if manifest.NormalizedFamily() != FamilyEdge || manifest.Architecture() != "x86_64" || manifest.StateSchemaVersion != 6 {
		t.Fatalf("unexpected envelope: %+v", manifest)
	}
}
