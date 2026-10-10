package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

type releaseDir struct {
	t       *testing.T
	dir     string
	private ed25519.PrivateKey
	keyPath string
}

func newReleaseDir(t *testing.T) *releaseDir {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	keyPath := filepath.Join(root, "update-public.pem")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "assets")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return &releaseDir{t: t, dir: dir, private: private, keyPath: keyPath}
}

func (r *releaseDir) write(name string, data []byte) {
	r.t.Helper()
	if err := os.WriteFile(filepath.Join(r.dir, name), data, 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func (r *releaseDir) envelope(family, version, channel, arch string) {
	r.t.Helper()
	code, ok := updates.VersionCode(version)
	if !ok {
		r.t.Fatalf("bad version %s", version)
	}
	payload := []byte(family + " " + version + " " + arch)
	sum := sha256.Sum256(payload)
	manifest := updates.Manifest{SchemaVersion: 1, Arch: arch, VersionName: version, VersionCode: code, Channel: channel, ArtifactSizeBytes: int64(len(payload)), ArtifactSHA256: hex.EncodeToString(sum[:])}
	head := "tilecast-edge-update-"
	switch family {
	case "edge":
		manifest.Product, manifest.PlayerFamily, manifest.Platform = updates.EdgeProduct, updates.FamilyEdge, updates.PlatformLinux
		manifest.ArtifactAssetName = updates.EdgeArtifactName(version, arch)
		manifest.ReleaseManifestSHA256 = strings.Repeat("d", 64)
		manifest.SBOMSHA256 = strings.Repeat("e", 64)
		manifest.StateSchemaVersion = 6
	case "windows":
		head = "tilecast-windows-update-"
		manifest.Product, manifest.PlayerFamily, manifest.Platform = updates.WindowsProduct, updates.FamilyWindows, updates.PlatformWindows
		manifest.ArtifactAssetName = updates.WindowsArtifactName(version, arch)
	}
	raw, _ := json.Marshal(manifest)
	r.write(manifest.ArtifactAssetName, payload)
	r.write(head+arch+".json", raw)
	r.write(head+arch+".json.sig", []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(r.private, raw))))
}

func (r *releaseDir) all(version, channel string) {
	for _, arch := range []string{"x86_64", "aarch64"} {
		r.envelope("edge", version, channel, arch)
		r.envelope("windows", version, channel, arch)
	}
}

func (r *releaseDir) verify(version string, extra ...string) (report, int, string) {
	r.t.Helper()
	var stdout, stderr bytes.Buffer
	args := append([]string{"--dir", r.dir, "--public-key", r.keyPath, "--version", version}, extra...)
	code := run(args, &stdout, &stderr)
	var result report
	if stdout.Len() > 0 {
		if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
			r.t.Fatalf("output is not JSON: %v\n%s", err, stdout.String())
		}
	}
	return result, code, stderr.String()
}

func TestAcceptsACompleteSetOfBuilds(t *testing.T) {
	r := newReleaseDir(t)
	r.all("0.26.0-beta.1", "beta")
	result, code, stderr := r.verify("0.26.0-beta.1")
	if code != 0 || len(result.Problems) != 0 || len(result.Components) != 4 {
		t.Fatalf("code=%d problems=%v components=%d stderr=%s", code, result.Problems, len(result.Components), stderr)
	}
	if result.Channel != "beta" || result.Components[0].Family != "edge" || result.Components[0].Architecture != "aarch64" || result.Components[3].Manifest != "tilecast-windows-update-x86_64.json" {
		t.Fatalf("unexpected report: %+v", result)
	}
}

func TestRejectsACorruptArtifactAndStillListsTheRest(t *testing.T) {
	r := newReleaseDir(t)
	r.all("0.26.0", "stable")
	r.write(updates.WindowsArtifactName("0.26.0", "aarch64"), []byte("tampered"))
	result, code, _ := r.verify("0.26.0")
	if code != 1 || len(result.Components) != 3 || len(result.Problems) != 1 || result.Problems[0].Family != "windows" || result.Problems[0].Architecture != "aarch64" {
		t.Fatalf("code=%d components=%d problems=%v", code, len(result.Components), result.Problems)
	}
}

func TestRejectsAForgedSignature(t *testing.T) {
	r := newReleaseDir(t)
	r.all("0.26.0", "stable")
	r.write("tilecast-edge-update-x86_64.json.sig", []byte(base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))))
	result, code, _ := r.verify("0.26.0")
	if code != 1 || len(result.Components) != 3 || !strings.Contains(result.Problems[0].Message, "signature") || result.Problems[0].Family != "edge" {
		t.Fatalf("code=%d components=%d problems=%v", code, len(result.Components), result.Problems)
	}
}

func TestRejectsABuildOfAnotherVersionOrChannel(t *testing.T) {
	r := newReleaseDir(t)
	r.envelope("edge", "0.26.0-beta.2", "beta", "x86_64")
	r.envelope("edge", "0.26.0", "stable", "aarch64")
	result, code, _ := r.verify("0.26.0")
	// Beta 2 names the wrong version. The Stable one is right.
	if code != 1 || len(result.Components) != 1 || result.Components[0].Architecture != "aarch64" || len(result.Problems) != 1 {
		t.Fatalf("code=%d components=%+v problems=%v", code, result.Components, result.Problems)
	}
	// A Beta release must not carry a Stable-channel build.
	other := newReleaseDir(t)
	other.envelope("edge", "0.26.0", "stable", "x86_64")
	result, code, _ = other.verify("0.26.0-beta.1")
	if code != 1 || len(result.Components) != 0 {
		t.Fatalf("code=%d components=%+v problems=%v", code, result.Components, result.Problems)
	}
}

func TestRejectsAFakeAndroidPackage(t *testing.T) {
	r := newReleaseDir(t)
	r.all("0.26.0", "stable")
	apk := []byte("not an apk")
	sum := sha256.Sum256(apk)
	manifest := updates.Manifest{SchemaVersion: 1, Product: "tilecast-player", ApplicationID: updates.ApplicationID, VersionCode: 2600099, VersionName: "0.26.0", Channel: "stable", MinimumSDK: 23, APKAssetName: updates.AndroidArtifactName, APKSizeBytes: int64(len(apk)), APKSHA256: hex.EncodeToString(sum[:]), SigningCertificateSHA256: strings.Repeat("b", 64)}
	raw, _ := json.Marshal(manifest)
	r.write(updates.AndroidArtifactName, apk)
	r.write("tilecast-player-update.json", raw)
	r.write("tilecast-player-update.json.sig", []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(r.private, raw))))
	result, code, _ := r.verify("0.26.0")
	if code != 1 || len(result.Components) != 4 || len(result.Problems) != 1 || result.Problems[0].Family != "android" {
		t.Fatalf("code=%d components=%d problems=%v", code, len(result.Components), result.Problems)
	}
}

func TestRefusesALegacyElectronLinuxPlayerAndAnInvalidVersion(t *testing.T) {
	r := newReleaseDir(t)
	if _, code, stderr := r.verify("0.25.0"); code != 2 || !strings.Contains(stderr, "not a unified release version") {
		t.Fatalf("legacy version: code=%d stderr=%s", code, stderr)
	}
	if _, code, _ := r.verify("1.2.3-rc.1"); code != 2 {
		t.Fatalf("rc version accepted: code=%d", code)
	}
	appImage := []byte("appimage")
	sum := sha256.Sum256(appImage)
	manifest := updates.Manifest{SchemaVersion: 1, Product: "tilecast-player", Platform: updates.PlatformLinux, VersionCode: 17000, VersionName: "0.17.0", Channel: "stable", ArtifactAssetName: updates.LinuxArtifactName, ArtifactSizeBytes: int64(len(appImage)), ArtifactSHA256: hex.EncodeToString(sum[:])}
	raw, _ := json.Marshal(manifest)
	r.write(updates.LinuxArtifactName, appImage)
	r.write("tilecast-player-update-linux.json", raw)
	r.write("tilecast-player-update-linux.json.sig", []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(r.private, raw))))
	result, code, _ := r.verify("0.26.0")
	if code != 1 || len(result.Components) != 0 || len(result.Problems) != 1 {
		t.Fatalf("code=%d components=%+v problems=%v", code, result.Components, result.Problems)
	}
}

func TestReadsABase64RawKeyAndRejectsAnotherSigner(t *testing.T) {
	r := newReleaseDir(t)
	r.all("0.26.0", "stable")
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	rawKey := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(rawKey, []byte(base64.StdEncoding.EncodeToString(other)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r.keyPath = rawKey
	result, code, _ := r.verify("0.26.0")
	if code != 1 || len(result.Components) != 0 || len(result.Problems) != 4 {
		t.Fatalf("a release signed by another key verified: code=%d components=%d problems=%d", code, len(result.Components), len(result.Problems))
	}
}
