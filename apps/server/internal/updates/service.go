package updates

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/avast/apkparser"
	"github.com/avast/apkverifier"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	ApplicationID      = "org.tilecast.player"
	SupportedMinSDK    = 23
	CurrentVersionCode = 5

	PlatformAndroid = "android"
	PlatformLinux   = "linux"

	// Player release families. The platform names the operating system; the
	// family names the player that installs the artifact. Linux has two: the
	// Electron Linux Player (an AppImage) and Tilecast Edge (a signed release
	// archive). A deployment reaches only screens of its release's family.
	FamilyAndroid       = "android"
	FamilyElectronLinux = "electron-linux"
	FamilyEdge          = "edge"

	AndroidArtifactName = "tilecast-player.apk"
	LinuxArtifactName   = "tilecast-player.AppImage"

	// EdgeProduct is the product of a Tilecast Edge update envelope
	// (apps/edge/crates/edge-release/src/envelope.rs).
	EdgeProduct = "tilecast-edge"
	// EdgeManifestName and its signature are the names of an uploaded Edge
	// envelope; a GitHub release carries one per architecture,
	// tilecast-edge-update-<arch>.json.
	EdgeManifestName       = "tilecast-edge-update.json"
	EdgeMaxArtifactBytes   = 4 << 30
	edgeMaxReleaseNotes    = 4000
	edgeGitHubManifestHead = "tilecast-edge-update-"

	// Linux releases are versioned independently of Android and there is no shipped
	// baseline yet, so any positive Linux version code is acceptable.
	LinuxBaselineVersionCode = 0
)

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// edgeVersionPattern mirrors edge_release::manifest::is_version_name.
var edgeVersionPattern = regexp.MustCompile(`^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z.]+)?$`)

// EdgeArchitectures are the architectures an Edge release is built for, in
// `uname -m` spelling.
var EdgeArchitectures = map[string]bool{"x86_64": true, "aarch64": true}

// EdgeVersionCode is the version code of an Edge version name, as the release
// build writes it: MAJOR*1000000 + MINOR*1000 + PATCH. The prerelease part
// does not count; a part of 1000 or more would collide and is invalid.
func EdgeVersionCode(name string) (int64, bool) {
	if len(name) > 64 || !edgeVersionPattern.MatchString(name) {
		return 0, false
	}
	core := strings.SplitN(name, "-", 2)[0]
	parts := strings.Split(core, ".")
	major, errMajor := strconv.ParseInt(parts[0], 10, 64)
	minor, errMinor := strconv.ParseInt(parts[1], 10, 64)
	patch, errPatch := strconv.ParseInt(parts[2], 10, 64)
	if errMajor != nil || errMinor != nil || errPatch != nil || major >= 1_000_000 || minor >= 1000 || patch >= 1000 {
		return 0, false
	}
	return major*1_000_000 + minor*1000 + patch, true
}

// EdgeArtifactName is the archive name of an Edge release.
func EdgeArtifactName(versionName, arch string) string {
	return "tilecast-edge-" + versionName + "-" + arch + ".tar.zst"
}

// Manifest describes a signed player release. Android (APK) and Linux (AppImage)
// releases share the common fields; the platform-specific fields are mutually
// exclusive and selected by Platform. Android manifests predate the platform
// field and omit it, so an empty Platform normalizes to android.
type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Product       string `json:"product"`
	Platform      string `json:"platform,omitempty"`
	VersionCode   int64  `json:"versionCode"`
	VersionName   string `json:"versionName"`
	Channel       string `json:"channel"`
	ReleaseNotes  string `json:"releaseNotes"`

	// Android (APK) fields.
	ApplicationID            string `json:"applicationId,omitempty"`
	MinimumSDK               int    `json:"minimumSdk,omitempty"`
	APKAssetName             string `json:"apkAssetName,omitempty"`
	APKSizeBytes             int64  `json:"apkSizeBytes,omitempty"`
	APKSHA256                string `json:"apkSha256,omitempty"`
	SigningCertificateSHA256 string `json:"signingCertificateSha256,omitempty"`

	// Linux (AppImage and Edge archive) fields.
	ArtifactAssetName string `json:"artifactAssetName,omitempty"`
	ArtifactSizeBytes int64  `json:"artifactSizeBytes,omitempty"`
	ArtifactSHA256    string `json:"artifactSha256,omitempty"`

	// Tilecast Edge envelope fields. PlayerFamily is "edge"; the rest bind
	// the archive to the signed release manifest inside it.
	PlayerFamily          string `json:"playerFamily,omitempty"`
	Arch                  string `json:"arch,omitempty"`
	ReleaseManifestSHA256 string `json:"releaseManifestSha256,omitempty"`
	SBOMSHA256            string `json:"sbomSha256,omitempty"`
	StateSchemaVersion    int    `json:"stateSchemaVersion,omitempty"`
}

// NormalizedFamily returns the release family: the signed playerFamily, or
// for manifests that predate it, the family the platform always meant.
func (m Manifest) NormalizedFamily() string {
	if m.PlayerFamily != "" {
		return m.PlayerFamily
	}
	if m.NormalizedPlatform() == PlatformLinux {
		return FamilyElectronLinux
	}
	return FamilyAndroid
}

// Architecture is the release's architecture, or "" for a family whose
// artifact is not architecture-specific.
func (m Manifest) Architecture() string {
	if m.NormalizedFamily() == FamilyEdge {
		return m.Arch
	}
	return ""
}

// NormalizedPlatform returns the platform, defaulting an empty value (legacy
// Android manifests) to android.
func (m Manifest) NormalizedPlatform() string {
	if m.Platform == "" {
		return PlatformAndroid
	}
	return m.Platform
}

// AssetName returns the release artifact filename for the manifest's platform.
func (m Manifest) AssetName() string {
	if m.NormalizedPlatform() == PlatformLinux {
		return m.ArtifactAssetName
	}
	return m.APKAssetName
}

// ArtifactSize returns the release artifact byte size for the manifest's platform.
func (m Manifest) ArtifactSize() int64 {
	if m.NormalizedPlatform() == PlatformLinux {
		return m.ArtifactSizeBytes
	}
	return m.APKSizeBytes
}

// ArtifactHash returns the lowercased artifact SHA-256 for the manifest's platform.
func (m Manifest) ArtifactHash() string {
	if m.NormalizedPlatform() == PlatformLinux {
		return strings.ToLower(m.ArtifactSHA256)
	}
	return strings.ToLower(m.APKSHA256)
}

// artifactSuffix maps a release family to the cache-file extension used on disk.
func artifactSuffix(family string) string {
	switch family {
	case FamilyEdge:
		return ".tar.zst"
	case FamilyElectronLinux:
		return ".appimage"
	default:
		return ".apk"
	}
}

// baselineVersionCode is the highest version code considered "already shipped"
// for a family; a valid release must be strictly newer than it.
func baselineVersionCode(family string) int64 {
	if family == FamilyAndroid {
		return CurrentVersionCode
	}
	return LinuxBaselineVersionCode
}

// manifestStateSchema is the Edge state schema to persist, or SQL NULL.
func manifestStateSchema(m Manifest) any {
	if m.NormalizedFamily() == FamilyEdge {
		return m.StateSchemaVersion
	}
	return nil
}

// manifestApplicationID / manifestMinimumSDK return the value to persist,
// yielding SQL NULL for Linux releases which have no APK metadata.
func manifestApplicationID(m Manifest) any {
	if m.NormalizedPlatform() == PlatformLinux {
		return nil
	}
	return m.ApplicationID
}

func manifestMinimumSDK(m Manifest) any {
	if m.NormalizedPlatform() == PlatformLinux {
		return nil
	}
	return m.MinimumSDK
}

type Config struct {
	Root                  string
	TrustedPublicKey      string
	MaxAPKBytes           int64
	GitHubClientID        string
	GitHubTokenConfigured bool
}

type Service struct {
	db       *pgxpool.Pool
	provider Provider
	root     string
	key      ed25519.PublicKey
	maxAPK   int64
	github   *githubAuthorization
}

type ImportedRelease struct {
	ID                 uuid.UUID
	Manifest           Manifest
	Source             string
	CacheStatus        string
	VerificationStatus string
	Duplicate          bool
}

func (s *Service) ManifestKeyConfigured() bool { return len(s.key) == ed25519.PublicKeySize }
func (s *Service) MaximumUploadBytes() int64   { return s.maxAPK + (256 << 10) }
func (s *Service) MaximumAPKBytes() int64      { return s.maxAPK }

func NewService(db *pgxpool.Pool, provider Provider, cfg Config) (*Service, error) {
	if err := os.MkdirAll(cfg.Root, 0o750); err != nil {
		return nil, fmt.Errorf("create update cache: %w", err)
	}
	var key ed25519.PublicKey
	if strings.TrimSpace(cfg.TrustedPublicKey) != "" {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(cfg.TrustedPublicKey))
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return nil, errors.New("TILECAST_UPDATE_MANIFEST_PUBLIC_KEY must be a base64 Ed25519 public key")
		}
		key = ed25519.PublicKey(decoded)
	}
	github, err := newGitHubAuthorization(provider, cfg.Root, cfg.GitHubClientID, cfg.GitHubTokenConfigured)
	if err != nil {
		return nil, err
	}
	return &Service{db: db, provider: provider, root: cfg.Root, key: key, maxAPK: cfg.MaxAPKBytes, github: github}, nil
}

func ParseAndVerifyManifest(raw, signature []byte, key ed25519.PublicKey) (Manifest, error) {
	if len(key) != ed25519.PublicKeySize {
		return Manifest{}, errors.New("trusted update manifest public key is not configured")
	}
	decodedSignature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil || !ed25519.Verify(key, raw, decodedSignature) {
		return Manifest{}, errors.New("invalid update manifest signature")
	}
	var manifest Manifest
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, errors.New("invalid update manifest")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return Manifest{}, errors.New("update manifest must contain one JSON object")
	}
	if manifest.SchemaVersion != 1 || manifest.VersionName == "" {
		return Manifest{}, errors.New("update manifest metadata is invalid")
	}
	if manifest.Channel != "stable" && manifest.Channel != "beta" {
		return Manifest{}, errors.New("update channel is invalid")
	}
	if manifest.NormalizedFamily() == FamilyEdge {
		if err := validateEdgeManifest(manifest); err != nil {
			return Manifest{}, err
		}
		return manifest, nil
	}
	// Electron and Android manifests carry none of the Edge fields, and an
	// explicit family must agree with the platform.
	if manifest.Product != "tilecast-player" || manifest.Arch != "" || manifest.ReleaseManifestSHA256 != "" || manifest.SBOMSHA256 != "" || manifest.StateSchemaVersion != 0 {
		return Manifest{}, errors.New("update manifest metadata is invalid")
	}
	if manifest.PlayerFamily != "" && manifest.PlayerFamily != map[string]string{PlatformLinux: FamilyElectronLinux, PlatformAndroid: FamilyAndroid}[manifest.NormalizedPlatform()] {
		return Manifest{}, errors.New("update manifest player family does not match its platform")
	}
	switch manifest.NormalizedPlatform() {
	case PlatformLinux:
		// Linux manifests carry no APK-specific fields.
		if manifest.ApplicationID != "" || manifest.MinimumSDK != 0 || manifest.APKAssetName != "" || manifest.APKSizeBytes != 0 || manifest.APKSHA256 != "" || manifest.SigningCertificateSHA256 != "" {
			return Manifest{}, errors.New("linux update manifest must not carry android fields")
		}
		if manifest.ArtifactAssetName != LinuxArtifactName || manifest.ArtifactSizeBytes <= 0 || !digestPattern.MatchString(strings.ToLower(manifest.ArtifactSHA256)) || manifest.VersionCode <= LinuxBaselineVersionCode {
			return Manifest{}, errors.New("update manifest metadata is invalid or not newer than this Tilecast Player baseline")
		}
	default:
		// Android manifests carry no Linux artifact fields.
		if manifest.ArtifactAssetName != "" || manifest.ArtifactSizeBytes != 0 || manifest.ArtifactSHA256 != "" {
			return Manifest{}, errors.New("android update manifest must not carry linux fields")
		}
		if manifest.ApplicationID != ApplicationID || manifest.VersionCode <= CurrentVersionCode || manifest.APKAssetName != AndroidArtifactName || manifest.APKSizeBytes <= 0 || !digestPattern.MatchString(strings.ToLower(manifest.APKSHA256)) || !digestPattern.MatchString(strings.ToLower(manifest.SigningCertificateSHA256)) {
			return Manifest{}, errors.New("update manifest metadata is invalid or not newer than this Tilecast Player baseline")
		}
		if manifest.MinimumSDK < SupportedMinSDK || manifest.MinimumSDK > 35 {
			return Manifest{}, errors.New("update minimum SDK is unsupported")
		}
	}
	return manifest, nil
}

// validateEdgeManifest applies the Tilecast Edge envelope rules, the same ones
// the screen and its update helper apply (edge_release::envelope).
func validateEdgeManifest(m Manifest) error {
	if m.Product != EdgeProduct || m.NormalizedPlatform() != PlatformLinux {
		return errors.New("edge update envelope is not a Tilecast Edge update")
	}
	if m.ApplicationID != "" || m.MinimumSDK != 0 || m.APKAssetName != "" || m.APKSizeBytes != 0 || m.APKSHA256 != "" || m.SigningCertificateSHA256 != "" {
		return errors.New("edge update envelope must not carry android fields")
	}
	if !EdgeArchitectures[m.Arch] {
		return errors.New("edge update envelope architecture is invalid")
	}
	code, ok := EdgeVersionCode(m.VersionName)
	if !ok || code != m.VersionCode || m.VersionCode <= LinuxBaselineVersionCode {
		return errors.New("edge update envelope version is invalid")
	}
	if len(m.ReleaseNotes) > edgeMaxReleaseNotes {
		return errors.New("edge update envelope release notes are too long")
	}
	if m.ArtifactAssetName != EdgeArtifactName(m.VersionName, m.Arch) || m.ArtifactSizeBytes <= 0 || m.ArtifactSizeBytes > EdgeMaxArtifactBytes {
		return errors.New("edge update envelope artifact is invalid")
	}
	if !digestPattern.MatchString(m.ArtifactSHA256) || !digestPattern.MatchString(m.ReleaseManifestSHA256) || !digestPattern.MatchString(m.SBOMSHA256) {
		return errors.New("edge update envelope digests are invalid")
	}
	if m.StateSchemaVersion <= 0 {
		return errors.New("edge update envelope state schema version is invalid")
	}
	return nil
}

// ImportUpload verifies a locally uploaded release with the same manifest and
// artifact checks used for GitHub releases (plus APK package/signing-certificate
// checks for Android). The caller owns artifactPath and may remove it after this
// method returns.
func (s *Service) ImportUpload(ctx context.Context, artifactPath, artifactName string, raw, signature []byte, importedBy *uuid.UUID) (ImportedRelease, error) {
	manifest, err := ParseAndVerifyManifest(raw, signature, s.key)
	if err != nil {
		return ImportedRelease{}, err
	}
	if artifactName != manifest.AssetName() {
		return ImportedRelease{}, errors.New("the uploaded artifact is not the one the signed manifest names")
	}
	platform := manifest.NormalizedPlatform()
	family := manifest.NormalizedFamily()
	architecture := manifest.Architecture()
	artifactSize := manifest.ArtifactSize()
	artifactHash := manifest.ArtifactHash()
	if artifactSize > s.maxAPK {
		return ImportedRelease{}, errors.New("release artifact exceeds the configured player update size limit")
	}
	info, err := os.Stat(artifactPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() != artifactSize {
		return ImportedRelease{}, errors.New("release artifact size does not match the signed manifest")
	}

	id := uuid.New()
	suffix := artifactSuffix(family)
	part := filepath.Join(s.root, id.String()+suffix+".part")
	final := filepath.Join(s.root, id.String()+suffix)
	input, err := os.Open(artifactPath)
	if err != nil {
		return ImportedRelease{}, errors.New("uploaded release artifact could not be read")
	}
	output, err := os.OpenFile(part, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		input.Close()
		return ImportedRelease{}, err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, s.maxAPK+1))
	inputErr := input.Close()
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil || inputErr != nil || syncErr != nil || closeErr != nil || written != artifactSize || hex.EncodeToString(hash.Sum(nil)) != artifactHash {
		_ = os.Remove(part)
		return ImportedRelease{}, errors.New("release artifact size or SHA-256 verification failed")
	}
	if platform == PlatformAndroid {
		if err := verifyAPK(part, manifest); err != nil {
			_ = os.Remove(part)
			return ImportedRelease{}, err
		}
	}

	var existingID uuid.UUID
	var existingHash, existingCert, existingVerification, existingCache, existingSource string
	err = s.db.QueryRow(ctx, `SELECT id,apk_sha256,signing_certificate_sha256,verification_status,cache_status,source FROM player_releases WHERE player_family=$1 AND architecture=$2 AND version_code=$3`, family, architecture, manifest.VersionCode).Scan(&existingID, &existingHash, &existingCert, &existingVerification, &existingCache, &existingSource)
	if err == nil {
		_ = os.Remove(part)
		if existingHash == artifactHash && existingCert == strings.ToLower(manifest.SigningCertificateSHA256) && existingVerification == "verified" && existingCache == "cached" {
			return ImportedRelease{ID: existingID, Manifest: manifest, Source: existingSource, CacheStatus: existingCache, VerificationStatus: existingVerification, Duplicate: true}, nil
		}
		return ImportedRelease{}, errors.New("this version code already exists with different or invalid release data")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		_ = os.Remove(part)
		return ImportedRelease{}, err
	}
	var latestVersion int64
	if err := s.db.QueryRow(ctx, `SELECT COALESCE(max(version_code),$1) FROM player_releases WHERE player_family=$2 AND architecture=$3`, baselineVersionCode(family), family, architecture).Scan(&latestVersion); err != nil {
		_ = os.Remove(part)
		return ImportedRelease{}, err
	}
	if manifest.VersionCode <= latestVersion {
		_ = os.Remove(part)
		return ImportedRelease{}, errors.New("player release version code must be newer than every imported release")
	}
	if err := os.Rename(part, final); err != nil {
		_ = os.Remove(part)
		return ImportedRelease{}, err
	}
	_, err = s.db.Exec(ctx, `INSERT INTO player_releases(id,platform,player_family,architecture,channel,version_code,version_name,application_id,minimum_sdk,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_bytes,manifest_signature,state_schema_version,cache_status,verification_status,source,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,$14,$15::jsonb,$16,$17,$18,'cached','verified','upload',$19)`, id, platform, family, architecture, manifest.Channel, manifest.VersionCode, manifest.VersionName, manifestApplicationID(manifest), manifestMinimumSDK(manifest), manifest.ReleaseNotes, manifest.AssetName(), artifactSize, artifactHash, strings.ToLower(manifest.SigningCertificateSHA256), string(raw), raw, strings.TrimSpace(string(signature)), manifestStateSchema(manifest), importedBy)
	if err != nil {
		_ = os.Remove(final)
		return ImportedRelease{}, err
	}
	return ImportedRelease{ID: id, Manifest: manifest, Source: "upload", CacheStatus: "cached", VerificationStatus: "verified"}, nil
}

func (s *Service) Check(ctx context.Context) error {
	var etag string
	var previousFailed bool
	_ = s.db.QueryRow(ctx, `SELECT COALESCE(etag,''),safe_error IS NOT NULL FROM update_provider_state WHERE provider='github'`).Scan(&etag, &previousFailed)
	if previousFailed {
		etag = ""
	}
	result, err := s.provider.Releases(ctx, etag)
	if err != nil {
		_, _ = s.db.Exec(ctx, `INSERT INTO update_provider_state(provider,last_checked_at,safe_error,updated_at)VALUES('github',now(),$1,now()) ON CONFLICT(provider) DO UPDATE SET last_checked_at=now(),safe_error=$1,updated_at=now()`, safeError(err))
		return err
	}
	if result.NotModified {
		_, _ = s.db.Exec(ctx, `UPDATE update_provider_state SET last_checked_at=now(),safe_error=NULL,updated_at=now() WHERE provider='github'`)
		return nil
	}
	encoded, err := json.Marshal(result.Releases)
	if err != nil {
		return fmt.Errorf("encode GitHub release response: %w", err)
	}
	if _, err = s.db.Exec(ctx, `INSERT INTO update_provider_state(provider,etag,last_checked_at,rate_limit_reset_at,response,safe_error,updated_at)VALUES('github',$1,now(),$2,$3::jsonb,NULL,now()) ON CONFLICT(provider) DO UPDATE SET etag=$1,last_checked_at=now(),rate_limit_reset_at=$2,response=$3::jsonb,safe_error=NULL,updated_at=now()`, result.ETag, result.RateReset, string(encoded)); err != nil {
		return fmt.Errorf("store GitHub release response: %w", err)
	}
	var imported int
	var firstImportError error
	for _, release := range result.Releases {
		if importErr := s.importRelease(ctx, release); importErr != nil {
			if firstImportError == nil {
				firstImportError = importErr
			}
		} else {
			imported++
		}
	}
	if imported == 0 && firstImportError != nil {
		_, _ = s.db.Exec(ctx, `UPDATE update_provider_state SET safe_error=$1,updated_at=now() WHERE provider='github'`, safeError(firstImportError))
		return firstImportError
	}
	return nil
}

func (s *Service) importRelease(ctx context.Context, release ProviderRelease) error {
	assets := map[string]Asset{}
	for _, asset := range release.Assets {
		assets[asset.Name] = asset
	}
	// A Tilecast Edge release carries one signed envelope per architecture.
	var edgeManifests []string
	for name := range assets {
		if strings.HasPrefix(name, edgeGitHubManifestHead) && strings.HasSuffix(name, ".json") {
			edgeManifests = append(edgeManifests, name)
		}
	}
	if len(edgeManifests) > 0 {
		sort.Strings(edgeManifests)
		var firstError error
		imported := 0
		for _, name := range edgeManifests {
			if err := s.importEdgeRelease(ctx, release, assets, name); err != nil {
				if firstError == nil {
					firstError = err
				}
				continue
			}
			imported++
		}
		if imported == 0 {
			return firstError
		}
		return nil
	}
	// A Linux release is identified by its distinct manifest asset name; anything
	// else is treated as the original Android APK release layout.
	platform := PlatformAndroid
	manifestName, signatureName, artifactName := "tilecast-player-update.json", "tilecast-player-update.json.sig", AndroidArtifactName
	if _, ok := assets["tilecast-player-update-linux.json"]; ok {
		platform = PlatformLinux
		manifestName, signatureName, artifactName = "tilecast-player-update-linux.json", "tilecast-player-update-linux.json.sig", LinuxArtifactName
	}
	manifestAsset, manifestOK := assets[manifestName]
	signatureAsset, signatureOK := assets[signatureName]
	artifactAsset, artifactOK := assets[artifactName]
	if !manifestOK || !signatureOK || !artifactOK {
		return errors.New("release is missing required Tilecast Player assets")
	}
	raw, err := s.provider.Download(ctx, manifestAsset.URL, 128<<10)
	if err != nil {
		return err
	}
	signature, err := s.provider.Download(ctx, signatureAsset.URL, 4<<10)
	if err != nil {
		return err
	}
	manifest, err := ParseAndVerifyManifest(raw, signature, s.key)
	if err != nil {
		return err
	}
	if manifest.NormalizedPlatform() != platform || manifest.NormalizedFamily() == FamilyEdge {
		return errors.New("release asset set does not match the signed manifest platform")
	}
	id := uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("github:%d", release.ID)))
	return s.storeGitHubRelease(ctx, id, release, manifest, raw, signature, artifactAsset)
}

// importEdgeRelease imports the Edge release of one architecture from a GitHub
// release: tilecast-edge-update-<arch>.json, its signature, and the archive
// that the verified envelope names.
func (s *Service) importEdgeRelease(ctx context.Context, release ProviderRelease, assets map[string]Asset, manifestName string) error {
	signatureAsset, ok := assets[manifestName+".sig"]
	if !ok {
		return errors.New("edge release is missing its envelope signature")
	}
	raw, err := s.provider.Download(ctx, assets[manifestName].URL, 16<<10)
	if err != nil {
		return err
	}
	signature, err := s.provider.Download(ctx, signatureAsset.URL, 4<<10)
	if err != nil {
		return err
	}
	manifest, err := ParseAndVerifyManifest(raw, signature, s.key)
	if err != nil {
		return err
	}
	if manifest.NormalizedFamily() != FamilyEdge || manifestName != edgeGitHubManifestHead+manifest.Arch+".json" {
		return errors.New("edge release asset names do not match the signed envelope")
	}
	artifactAsset, ok := assets[manifest.ArtifactAssetName]
	if !ok {
		return errors.New("edge release is missing the archive its envelope names")
	}
	id := uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("github:%d:edge:%s", release.ID, manifest.Arch)))
	return s.storeGitHubRelease(ctx, id, release, manifest, raw, signature, artifactAsset)
}

func (s *Service) storeGitHubRelease(ctx context.Context, id uuid.UUID, release ProviderRelease, manifest Manifest, raw, signature []byte, artifactAsset Asset) error {
	expectedChannel := "stable"
	if release.Prerelease {
		expectedChannel = "beta"
	}
	if manifest.Channel != expectedChannel || manifest.ArtifactSize() != artifactAsset.Size || manifest.ArtifactSize() > s.maxAPK {
		return errors.New("GitHub asset metadata does not match the signed update manifest")
	}
	_, err := s.db.Exec(ctx, `INSERT INTO player_releases(id,github_release_id,github_tag,platform,player_family,architecture,channel,version_code,version_name,application_id,minimum_sdk,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_bytes,manifest_signature,state_schema_version,apk_download_url,verification_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,'verified_manifest') ON CONFLICT(github_release_id,player_family,architecture) DO UPDATE SET manifest=EXCLUDED.manifest,manifest_bytes=EXCLUDED.manifest_bytes,manifest_signature=EXCLUDED.manifest_signature,updated_at=now()`, id, release.ID, release.Tag, manifest.NormalizedPlatform(), manifest.NormalizedFamily(), manifest.Architecture(), manifest.Channel, manifest.VersionCode, manifest.VersionName, manifestApplicationID(manifest), manifestMinimumSDK(manifest), manifest.ReleaseNotes, release.PublishedAt, manifest.AssetName(), manifest.ArtifactSize(), manifest.ArtifactHash(), strings.ToLower(manifest.SigningCertificateSHA256), string(raw), raw, strings.TrimSpace(string(signature)), manifestStateSchema(manifest), artifactAsset.URL)
	return err
}

func (s *Service) Cache(ctx context.Context, releaseID uuid.UUID) error {
	var platform, family, assetURL, expectedHash, expectedCert string
	var expectedSize int64
	if err := s.db.QueryRow(ctx, `SELECT platform,player_family,apk_download_url,apk_size,apk_sha256,signing_certificate_sha256 FROM player_releases WHERE id=$1 AND verification_status<>'failed'`, releaseID).Scan(&platform, &family, &assetURL, &expectedSize, &expectedHash, &expectedCert); err != nil {
		return errors.New("verified player release was not found")
	}
	response, err := s.provider.Open(ctx, assetURL)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.ContentLength > s.maxAPK {
		return errors.New("release artifact download was rejected")
	}
	suffix := artifactSuffix(family)
	part := filepath.Join(s.root, releaseID.String()+suffix+".part")
	final := filepath.Join(s.root, releaseID.String()+suffix)
	file, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	hash := sha256.New()
	progress := &cacheProgressWriter{
		ctx:      ctx,
		db:       s.db,
		release:  releaseID,
		lastSave: time.Now(),
	}
	written, copyErr := io.Copy(io.MultiWriter(file, hash, progress), io.LimitReader(response.Body, s.maxAPK+1))
	progress.flush()
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || written != expectedSize || hex.EncodeToString(hash.Sum(nil)) != expectedHash {
		_ = os.Remove(part)
		return errors.New("release artifact size or SHA-256 verification failed")
	}
	if platform == PlatformAndroid {
		var expectedApplication string
		var expectedVersion int64
		var expectedMinSDK int
		_ = s.db.QueryRow(ctx, `SELECT application_id,version_code,minimum_sdk FROM player_releases WHERE id=$1`, releaseID).Scan(&expectedApplication, &expectedVersion, &expectedMinSDK)
		if err := verifyAPK(part, Manifest{ApplicationID: expectedApplication, VersionCode: expectedVersion, MinimumSDK: expectedMinSDK, SigningCertificateSHA256: expectedCert}); err != nil {
			_ = os.Remove(part)
			return err
		}
	}
	if err := os.Rename(part, final); err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `UPDATE player_releases SET cache_status='cached',cache_downloaded_bytes=$2,verification_status='verified',verification_error=NULL,updated_at=now() WHERE id=$1`, releaseID, written)
	return err
}

// cacheProgressWriter records coarse download progress so the dashboard can
// show movement without making the download depend on a database write for
// every network read.
type cacheProgressWriter struct {
	ctx        context.Context
	db         *pgxpool.Pool
	release    uuid.UUID
	downloaded int64
	lastSaved  int64
	lastSave   time.Time
}

func (w *cacheProgressWriter) Write(p []byte) (int, error) {
	w.downloaded += int64(len(p))
	if w.downloaded-w.lastSaved >= 256<<10 || time.Since(w.lastSave) >= 250*time.Millisecond {
		w.flush()
	}
	return len(p), nil
}

func (w *cacheProgressWriter) flush() {
	if w.downloaded == w.lastSaved {
		return
	}
	_, _ = w.db.Exec(w.ctx, `UPDATE player_releases SET cache_downloaded_bytes=$2,updated_at=now() WHERE id=$1 AND cache_status='downloading'`, w.release, w.downloaded)
	w.lastSaved = w.downloaded
	w.lastSave = time.Now()
}

func verifyAPK(path string, manifest Manifest) error {
	verification, err := apkverifier.Verify(path, nil)
	if err != nil {
		return errors.New("APK signing verification failed")
	}
	cert, _ := apkverifier.PickBestApkCert(verification.SignerCerts)
	if cert == nil || strings.ToLower(strings.ReplaceAll(cert.Sha256, ":", "")) != strings.ToLower(manifest.SigningCertificateSHA256) {
		return errors.New("APK signing certificate does not match the signed manifest")
	}
	application, version, minimumSDK, metadataErr := apkMetadata(path)
	if metadataErr != nil || application != manifest.ApplicationID || version != manifest.VersionCode || minimumSDK != manifest.MinimumSDK {
		return errors.New("APK package metadata does not match the signed manifest")
	}
	return nil
}

func apkMetadata(path string) (string, int64, int, error) {
	var output bytes.Buffer
	zipErr, _, manifestErr := apkparser.ParseApk(path, xml.NewEncoder(&output))
	if zipErr != nil || manifestErr != nil {
		return "", 0, 0, errors.New("APK manifest could not be parsed")
	}
	decoder := xml.NewDecoder(bytes.NewReader(output.Bytes()))
	var application string
	var version int64
	var minimumSDK int
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", 0, 0, err
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		for _, attribute := range start.Attr {
			if start.Name.Local == "manifest" && attribute.Name.Local == "package" {
				application = attribute.Value
			}
			if start.Name.Local == "manifest" && attribute.Name.Local == "versionCode" {
				version, _ = strconv.ParseInt(attribute.Value, 10, 64)
			}
			if start.Name.Local == "uses-sdk" && attribute.Name.Local == "minSdkVersion" {
				minimumSDK, _ = strconv.Atoi(attribute.Value)
			}
		}
	}
	if application == "" || version <= 0 || minimumSDK <= 0 {
		return "", 0, 0, errors.New("APK manifest metadata is incomplete")
	}
	return application, version, minimumSDK, nil
}

// ArtifactPath resolves the cached, verified release artifact on disk, returning
// its path, byte size, SHA-256, and release family.
func (s *Service) ArtifactPath(ctx context.Context, releaseID uuid.UUID) (string, int64, string, string, error) {
	var size int64
	var hash, status, family string
	if err := s.db.QueryRow(ctx, `SELECT player_family,apk_size,apk_sha256,verification_status FROM player_releases WHERE id=$1`, releaseID).Scan(&family, &size, &hash, &status); err != nil || status != "verified" {
		return "", 0, "", "", errors.New("verified cached release was not found")
	}
	return filepath.Join(s.root, releaseID.String()+artifactSuffix(family)), size, hash, family, nil
}

// Purge frees a release's cached artifacts from disk. The release record itself
// is deleted only when no deployment references it; deployment history keeps a
// foreign key on the release, so a deployed release instead drops back to an
// uncached state that a later download can restore. The returned flag reports
// whether the record was removed.
func (s *Service) Purge(ctx context.Context, releaseID uuid.UUID) (bool, error) {
	var referenced bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM update_deployments WHERE release_id=$1)`, releaseID).Scan(&referenced); err != nil {
		return false, err
	}
	if referenced {
		// A cached artifact is what makes verification complete, so a release
		// that loses its file falls back to the manifest-only verification it
		// held before the download.
		if _, err := s.db.Exec(ctx, `UPDATE player_releases SET cache_status='missing',verification_status=CASE WHEN verification_status='verified' THEN 'verified_manifest' ELSE verification_status END,verification_error=NULL,updated_at=now() WHERE id=$1`, releaseID); err != nil {
			return false, err
		}
	} else if _, err := s.db.Exec(ctx, `DELETE FROM player_releases WHERE id=$1`, releaseID); err != nil {
		return false, err
	}
	s.removeArtifacts(releaseID)
	return !referenced, nil
}

func (s *Service) Cleanup(ctx context.Context, retentionDays int) {
	rows, err := s.db.Query(ctx, `DELETE FROM player_releases pr WHERE pr.updated_at<now()-make_interval(days=>$1) AND NOT EXISTS(SELECT 1 FROM update_deployments d WHERE d.release_id=pr.id) RETURNING id`, retentionDays)
	if err != nil {
		return
	}
	purged := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			purged = append(purged, id)
		}
	}
	rows.Close()
	for _, id := range purged {
		s.removeArtifacts(id)
	}
}

// removeArtifacts deletes every cached and partial artifact a release can own.
// The platform is not consulted: the release row may already be gone, and the
// unused suffixes simply do not exist.
func (s *Service) removeArtifacts(releaseID uuid.UUID) {
	for _, suffix := range []string{".apk", ".apk.part", ".appimage", ".appimage.part", ".tar.zst", ".tar.zst.part"} {
		_ = os.Remove(filepath.Join(s.root, releaseID.String()+suffix))
	}
}

func safeError(err error) string {
	message := err.Error()
	if len(message) > 240 {
		message = message[:240]
	}
	return message
}

// InstallableRelease is the newest Linux build an unpaired machine can be
// provisioned with: verified, and already cached on this server so the install
// never depends on the signage network reaching GitHub.
type InstallableRelease struct {
	ID          uuid.UUID
	VersionName string
	VersionCode int64
	SizeBytes   int64
	SHA256      string
	Path        string
}

// LatestInstallableLinux returns the newest stable, verified, cached Linux
// release. Stable only: a provisioning run is not the place to hand a new
// signage box a beta. It reports an error when the operator has not cached one
// yet, which the installer surfaces as an instruction rather than a failure.
func (s *Service) LatestInstallableLinux(ctx context.Context) (InstallableRelease, error) {
	var release InstallableRelease
	err := s.db.QueryRow(ctx, `SELECT id,version_name,version_code,apk_size,apk_sha256 FROM player_releases
		WHERE player_family=$1 AND channel='stable' AND verification_status='verified' AND cache_status='cached'
		ORDER BY version_code DESC LIMIT 1`, FamilyElectronLinux).
		Scan(&release.ID, &release.VersionName, &release.VersionCode, &release.SizeBytes, &release.SHA256)
	if err != nil {
		return InstallableRelease{}, errors.New("no cached, verified Linux release is available")
	}
	release.Path = filepath.Join(s.root, release.ID.String()+artifactSuffix(FamilyElectronLinux))
	return release, nil
}
