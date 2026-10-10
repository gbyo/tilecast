package updates

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

// releaseFixture builds the assets of GitHub releases the way the release
// builds do: a signed manifest or envelope, its signature, and the artifact
// it names. It signs with a throwaway key; the service under test trusts the
// matching public key.
type releaseFixture struct {
	t         *testing.T
	public    ed25519.PublicKey
	private   ed25519.PrivateKey
	assets    []Asset
	downloads map[string][]byte
	artifacts map[string][]byte
	sequence  int
}

func newReleaseFixture(t *testing.T) *releaseFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &releaseFixture{t: t, public: public, private: private, downloads: map[string][]byte{}, artifacts: map[string][]byte{}}
}

func (f *releaseFixture) publicKey() string { return base64.StdEncoding.EncodeToString(f.public) }

// reset starts the assets of the next GitHub release. Asset URLs stay unique
// across releases because every release of a fixture shares one provider.
func (f *releaseFixture) reset() { f.assets = nil }

func (f *releaseFixture) url(name string) string {
	f.sequence++
	return fmt.Sprintf("%s#%d", name, f.sequence)
}

func (f *releaseFixture) addDownload(name string, data []byte) {
	url := f.url(name)
	f.downloads[url] = data
	f.assets = append(f.assets, Asset{Name: name, URL: url, Size: int64(len(data))})
}

func (f *releaseFixture) addArtifact(name string, data []byte) {
	url := f.url(name)
	f.artifacts[url] = data
	f.assets = append(f.assets, Asset{Name: name, URL: url, Size: int64(len(data))})
}

func (f *releaseFixture) signed(name string, manifest Manifest) []byte {
	f.t.Helper()
	raw, err := json.Marshal(manifest)
	if err != nil {
		f.t.Fatal(err)
	}
	f.addDownload(name, raw)
	f.addDownload(name+".sig", []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, raw))))
	return raw
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (f *releaseFixture) android(version string, code int64, channel string) {
	apk := []byte("android package " + version)
	f.addArtifact(AndroidArtifactName, apk)
	f.signed(androidManifestName, Manifest{
		SchemaVersion: 1, Product: "tilecast-player", ApplicationID: ApplicationID, VersionCode: code, VersionName: version, Channel: channel,
		MinimumSDK: SupportedMinSDK, APKAssetName: AndroidArtifactName, APKSizeBytes: int64(len(apk)), APKSHA256: digest(apk),
		SigningCertificateSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ReleaseNotes: "Android " + version,
	})
}

func (f *releaseFixture) linux(version string, code int64) {
	appImage := []byte("appimage " + version)
	f.addArtifact(LinuxArtifactName, appImage)
	f.signed(linuxManifestName, Manifest{
		SchemaVersion: 1, Product: "tilecast-player", Platform: PlatformLinux, VersionCode: code, VersionName: version, Channel: "stable",
		ArtifactAssetName: LinuxArtifactName, ArtifactSizeBytes: int64(len(appImage)), ArtifactSHA256: digest(appImage),
	})
}

func (f *releaseFixture) edge(version, channel, arch string) {
	code, ok := VersionCode(version)
	if !ok {
		f.t.Fatalf("fixture version %q is invalid", version)
	}
	archive := []byte("edge archive " + version + " " + arch)
	name := EdgeArtifactName(version, arch)
	f.addArtifact(name, archive)
	f.signed(edgeGitHubManifestHead+arch+".json", Manifest{
		SchemaVersion: 1, Product: EdgeProduct, PlayerFamily: FamilyEdge, Platform: PlatformLinux, Arch: arch, VersionName: version, VersionCode: code, Channel: channel,
		ArtifactAssetName: name, ArtifactSizeBytes: int64(len(archive)), ArtifactSHA256: digest(archive),
		ReleaseManifestSHA256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		SBOMSHA256:            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", StateSchemaVersion: 6,
	})
}

func (f *releaseFixture) windows(version, channel, arch string) {
	code, ok := VersionCode(version)
	if !ok {
		f.t.Fatalf("fixture version %q is invalid", version)
	}
	msix := []byte("msix " + version + " " + arch)
	name := WindowsArtifactName(version, arch)
	f.addArtifact(name, msix)
	f.signed(windowsGitHubManifestHead+arch+".json", Manifest{
		SchemaVersion: 1, Product: WindowsProduct, PlayerFamily: FamilyWindows, Platform: PlatformWindows, Arch: arch, VersionName: version, VersionCode: code, Channel: channel,
		ArtifactAssetName: name, ArtifactSizeBytes: int64(len(msix)), ArtifactSHA256: digest(msix),
	})
}

// unified adds the full set of platform builds of one coordinated release.
func (f *releaseFixture) unified(version string) {
	code, ok := VersionCode(version)
	if !ok {
		f.t.Fatalf("fixture version %q is invalid", version)
	}
	channel := VersionChannel(version)
	f.android(version, code, channel)
	for _, arch := range []string{"x86_64", "aarch64"} {
		f.edge(version, channel, arch)
		f.windows(version, channel, arch)
	}
}

func (f *releaseFixture) release(id int64, tag string, prerelease bool) ProviderRelease {
	release := ProviderRelease{ID: id, Tag: tag, Prerelease: prerelease, PublishedAt: time.Now().UTC(), Assets: f.assets}
	f.assets = nil
	return release
}

func (f *releaseFixture) drop(release *ProviderRelease, name string) {
	kept := release.Assets[:0:0]
	for _, asset := range release.Assets {
		if asset.Name != name {
			kept = append(kept, asset)
		}
	}
	release.Assets = kept
}

// corruptSignature replaces a manifest's signature with one over other bytes.
func (f *releaseFixture) corruptSignature(release ProviderRelease, manifestName string) {
	for _, asset := range release.Assets {
		if asset.Name == manifestName+".sig" {
			f.downloads[asset.URL] = []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, []byte("something else"))))
		}
	}
}

func (f *releaseFixture) provider(releases ...ProviderRelease) *fixtureProvider {
	return &fixtureProvider{fixture: f, releases: releases}
}

// fixtureProvider serves a fixed release list and counts what is downloaded.
type fixtureProvider struct {
	fixture   *releaseFixture
	releases  []ProviderRelease
	mu        sync.Mutex
	downloads int
}

func (p *fixtureProvider) Releases(_ context.Context, etag string) (ProviderResult, error) {
	if etag != "" {
		return ProviderResult{NotModified: true}, nil
	}
	return ProviderResult{ETag: `"fixture"`, Releases: p.releases}, nil
}

func (p *fixtureProvider) Download(_ context.Context, rawURL string, _ int64) ([]byte, error) {
	p.mu.Lock()
	p.downloads++
	p.mu.Unlock()
	value, ok := p.fixture.downloads[rawURL]
	if !ok {
		return nil, errors.New("asset not found")
	}
	return value, nil
}

func (p *fixtureProvider) Open(_ context.Context, rawURL string) (*http.Response, error) {
	value, ok := p.fixture.artifacts[rawURL]
	if !ok {
		return nil, errors.New("asset not found")
	}
	return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(value)), Body: io.NopCloser(bytes.NewReader(value))}, nil
}
