// Command tilecast-release-verify checks a directory of release assets with
// the code the Tilecast server uses to import a GitHub release.
//
// The coordinated release workflow runs it before a release is published, so a
// release it accepts is a release the server discovers, verifies, and offers
// to screens: every Android, Edge, and Windows manifest is read, its Ed25519
// signature checked against the trusted key, its names and channel checked
// against the version, and its artifact checked for size and SHA-256 (plus the
// APK signing certificate for Android).
//
//	tilecast-release-verify --dir assets --public-key update-public.pem \
//	    --version 0.26.0-beta.1 [--android-certificate SHA256]
//
// With --bridge it checks the Edge bridge release instead: an Edge-only release
// whose version name and code follow the legacy rule (below 0.26.0), so that a
// screen running Edge 0.2.1 or older can install it. See
// docs/release-process.md.
//
// It prints one JSON document and exits 1 when anything is rejected. Problems
// are listed beside the components that did verify, so the caller can tell a
// missing optional platform from a corrupt required one.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

type component struct {
	Family       string `json:"family"`
	Architecture string `json:"architecture"`
	Manifest     string `json:"manifest"`
	Artifact     string `json:"artifact"`
	VersionName  string `json:"versionName"`
	VersionCode  int64  `json:"versionCode"`
	Channel      string `json:"channel"`
	SizeBytes    int64  `json:"sizeBytes"`
	SHA256       string `json:"sha256"`
}

// problem is a build that did not verify. Family and Architecture name the
// component it belongs to; both are empty when the problem is not about one
// component, such as an unreadable directory.
type problem struct {
	Family       string `json:"family"`
	Architecture string `json:"architecture"`
	Message      string `json:"message"`
}

func (p problem) String() string {
	label := p.Family
	if p.Architecture != "" {
		label += " " + p.Architecture
	}
	if label == "" {
		return p.Message
	}
	return label + ": " + p.Message
}

type report struct {
	Version    string      `json:"version"`
	Channel    string      `json:"channel"`
	Components []component `json:"components"`
	Problems   []problem   `json:"problems"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("tilecast-release-verify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	dir := flags.String("dir", "", "directory holding the release assets")
	keyPath := flags.String("public-key", "", "trusted update public key: PEM or base64 raw Ed25519")
	version := flags.String("version", "", "release version, for example 0.26.0-beta.1")
	androidCertificate := flags.String("android-certificate", "", "pinned Android signing certificate SHA-256 (optional)")
	bridge := flags.Bool("bridge", false, "verify an Edge bridge release: a legacy version below 0.26.0, Edge assets only")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *dir == "" || *keyPath == "" || *version == "" {
		fmt.Fprintln(stderr, "--dir, --public-key, and --version are required")
		return 2
	}
	key, err := readPublicKey(*keyPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	result, err := verifyDirectory(context.Background(), *dir, key, *version, strings.ToLower(*androidCertificate), *bridge)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	fmt.Fprintln(stdout, string(encoded))
	if len(result.Problems) > 0 {
		return 1
	}
	return 0
}

func readPublicKey(path string) (ed25519.PublicKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read public key: %w", err)
	}
	if block, _ := pem.Decode(raw); block != nil {
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		key, ok := parsed.(ed25519.PublicKey)
		if err != nil || !ok {
			return nil, errors.New("public key is not an Ed25519 key")
		}
		return key, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return nil, errors.New("public key must be PEM or a base64 raw Ed25519 key")
	}
	return ed25519.PublicKey(decoded), nil
}

// dirProvider serves a directory as the assets of one GitHub release. An
// asset's URL is its path, so the importer's Download and Open read files.
type dirProvider struct{}

func (dirProvider) Releases(context.Context, string) (updates.ProviderResult, error) {
	return updates.ProviderResult{}, errors.New("not a release listing")
}

func (dirProvider) Download(_ context.Context, path string, maximum int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > maximum {
		return nil, errors.New("asset is missing or larger than the allowed size")
	}
	return os.ReadFile(path)
}

func (dirProvider) Open(context.Context, string) (*http.Response, error) {
	return nil, errors.New("artifacts are verified from the directory")
}

func verifyDirectory(ctx context.Context, dir string, key ed25519.PublicKey, version, androidCertificate string, bridge bool) (report, error) {
	channel := updates.VersionChannel(version)
	if bridge {
		// An Edge preview was always a GitHub pre-release on the Beta channel.
		channel = "beta"
		if _, ok := updates.VersionCode(version); !ok || updates.IsUnifiedVersion(version) {
			return report{}, fmt.Errorf("%q is not a bridge version: it must be a valid version below 0.26.0, which an Edge 0.2.1 screen accepts", version)
		}
	} else if _, ok := updates.VersionCode(version); !ok || !updates.IsUnifiedVersion(version) || channel == "" {
		return report{}, fmt.Errorf("%q is not a unified release version: use X.Y.Z or X.Y.Z-beta.N from 0.26.0 on", version)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return report{}, err
	}
	release := updates.ProviderRelease{Tag: "v" + version, Prerelease: channel == "beta"}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		release.Assets = append(release.Assets, updates.Asset{Name: entry.Name(), URL: filepath.Join(dir, entry.Name()), Size: info.Size()})
	}
	result := report{Version: version, Channel: channel, Components: []component{}, Problems: []problem{}}
	candidates, problems := updates.DiscoverRelease(ctx, dirProvider{}, key, release)
	for _, found := range problems {
		result.Problems = append(result.Problems, problem{found.Family, found.Architecture, found.Err.Error()})
	}
	for _, candidate := range candidates {
		manifest := candidate.Manifest
		reject := func(message string) {
			result.Problems = append(result.Problems, problem{manifest.NormalizedFamily(), manifest.Architecture(), message})
		}
		switch {
		case bridge && manifest.NormalizedFamily() != updates.FamilyEdge:
			reject("a bridge release carries Tilecast Edge only")
			continue
		case manifest.NormalizedFamily() == updates.FamilyElectronLinux:
			reject("the legacy Electron Linux Player is not part of a coordinated release")
			continue
		case manifest.VersionName != version:
			reject(fmt.Sprintf("manifest is version %s, not %s", manifest.VersionName, version))
			continue
		}
		// The maximum is generous: the server applies its configured limit
		// when it imports, and an Edge archive can exceed a gigabyte.
		if err := updates.CheckCandidate(release, candidate, 8<<30); err != nil {
			reject(err.Error())
			continue
		}
		if err := updates.VerifyReleaseArtifact(candidate.Artifact.URL, manifest); err != nil {
			reject(err.Error())
			continue
		}
		if androidCertificate != "" && manifest.NormalizedFamily() == updates.FamilyAndroid && strings.ToLower(manifest.SigningCertificateSHA256) != androidCertificate {
			reject("the APK is not signed with the pinned Android certificate")
			continue
		}
		result.Components = append(result.Components, component{
			Family: manifest.NormalizedFamily(), Architecture: manifest.Architecture(),
			Manifest: manifestAssetName(candidate.Manifest), Artifact: manifest.AssetName(),
			VersionName: manifest.VersionName, VersionCode: manifest.VersionCode, Channel: manifest.Channel,
			SizeBytes: manifest.ArtifactSize(), SHA256: manifest.ArtifactHash(),
		})
	}
	sort.Slice(result.Components, func(i, j int) bool {
		a, b := result.Components[i], result.Components[j]
		return a.Family+"/"+a.Architecture < b.Family+"/"+b.Architecture
	})
	sort.Slice(result.Problems, func(i, j int) bool { return result.Problems[i].String() < result.Problems[j].String() })
	return result, nil
}

// manifestAssetName is the asset name of the manifest a release came from,
// recovered from the signed content: the Android pair keeps its standalone
// name; an envelope is named by family and architecture.
func manifestAssetName(manifest updates.Manifest) string {
	switch manifest.NormalizedFamily() {
	case updates.FamilyEdge:
		return "tilecast-edge-update-" + manifest.Arch + ".json"
	case updates.FamilyWindows:
		return "tilecast-windows-update-" + manifest.Arch + ".json"
	default:
		return "tilecast-player-update.json"
	}
}
