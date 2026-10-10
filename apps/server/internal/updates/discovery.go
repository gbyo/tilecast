package updates

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/google/uuid"
)

// Names of the original standalone player assets. The unified release carries
// the Android pair under the same names, so Android keeps one asset layout
// from the first standalone release to the coordinated one.
const (
	androidManifestName = "tilecast-player-update.json"
	linuxManifestName   = "tilecast-player-update-linux.json"
)

// releaseSpec is one player release a GitHub release may carry: a signed
// manifest, its signature, and the artifact the verified manifest names. One
// GitHub release carries several: the Android pair, an Edge envelope and a
// Windows envelope per architecture, and the legacy Electron Linux pair. Each
// is discovered, verified, and stored on its own.
type releaseSpec struct {
	family        string
	platform      string
	manifestName  string
	signatureName string
	// head is the envelope name prefix; an envelope manifest is named
	// head + architecture + ".json". Empty for the standalone layouts.
	head string
	// artifactName is the fixed artifact name of a standalone layout. An
	// envelope's artifact is the one its verified envelope names.
	artifactName string
}

// architecture is the one an envelope's asset name carries, or "" for the
// standalone layouts. A manifest that disagrees fails verification.
func (s releaseSpec) architecture() string {
	if s.head == "" {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(s.manifestName, s.head), ".json")
}

// releaseSpecs lists the player releases a GitHub release's assets name, in a
// stable order. An empty result means the release is not a player release: a
// Server, WPE, or other repository release.
func releaseSpecs(assets []Asset) []releaseSpec {
	names := make(map[string]bool, len(assets))
	for _, asset := range assets {
		names[asset.Name] = true
	}
	var specs []releaseSpec
	if names[androidManifestName] {
		specs = append(specs, releaseSpec{family: FamilyAndroid, platform: PlatformAndroid, manifestName: androidManifestName, signatureName: androidManifestName + ".sig", artifactName: AndroidArtifactName})
	}
	if names[linuxManifestName] {
		specs = append(specs, releaseSpec{family: FamilyElectronLinux, platform: PlatformLinux, manifestName: linuxManifestName, signatureName: linuxManifestName + ".sig", artifactName: LinuxArtifactName})
	}
	var envelopes []releaseSpec
	for name := range names {
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		switch {
		case strings.HasPrefix(name, edgeGitHubManifestHead):
			envelopes = append(envelopes, releaseSpec{family: FamilyEdge, platform: PlatformLinux, manifestName: name, signatureName: name + ".sig", head: edgeGitHubManifestHead})
		case strings.HasPrefix(name, windowsGitHubManifestHead):
			envelopes = append(envelopes, releaseSpec{family: FamilyWindows, platform: PlatformWindows, manifestName: name, signatureName: name + ".sig", head: windowsGitHubManifestHead})
		}
	}
	sort.Slice(envelopes, func(i, j int) bool { return envelopes[i].manifestName < envelopes[j].manifestName })
	return append(specs, envelopes...)
}

// ReleaseProblem is a player release a GitHub release names but that did not
// verify, with the family and architecture it belongs to so a caller can tell
// a corrupt required build from a missing optional one.
type ReleaseProblem struct {
	Family       string
	Architecture string
	Err          error
}

func (p ReleaseProblem) Error() string {
	label := p.Family
	if p.Architecture != "" {
		label += " " + p.Architecture
	}
	return label + ": " + p.Err.Error()
}

func (p ReleaseProblem) Unwrap() error { return p.Err }

// ReleaseCandidate is one verified player release found in a GitHub release:
// the signed manifest bytes and the artifact asset the manifest names. The
// artifact's own bytes are verified when it is cached, or by
// VerifyReleaseArtifact before a release is published.
type ReleaseCandidate struct {
	Manifest  Manifest
	Raw       []byte
	Signature []byte
	Artifact  Asset
}

// DiscoverRelease finds and verifies every player release in one GitHub
// release. Each family and architecture stands alone: a missing, invalid, or
// unsigned one is reported as a problem and never hides the others. A release
// with no player assets returns neither candidates nor problems. The server
// importer and the release publication check both run this function, so a
// release the check accepts is a release the server imports.
func DiscoverRelease(ctx context.Context, provider Provider, key ed25519.PublicKey, release ProviderRelease) ([]ReleaseCandidate, []ReleaseProblem) {
	specs := releaseSpecs(release.Assets)
	assets := make(map[string]Asset, len(release.Assets))
	for _, asset := range release.Assets {
		assets[asset.Name] = asset
	}
	var candidates []ReleaseCandidate
	var problems []ReleaseProblem
	for _, spec := range specs {
		candidate, err := discoverSpec(ctx, provider, key, assets, spec)
		if err != nil {
			problems = append(problems, ReleaseProblem{Family: spec.family, Architecture: spec.architecture(), Err: err})
			continue
		}
		candidates = append(candidates, candidate)
	}
	return candidates, problems
}

func discoverSpec(ctx context.Context, provider Provider, key ed25519.PublicKey, assets map[string]Asset, spec releaseSpec) (ReleaseCandidate, error) {
	manifestAsset, signatureAsset := assets[spec.manifestName], assets[spec.signatureName]
	if signatureAsset.Name == "" {
		return ReleaseCandidate{}, errors.New("release is missing the manifest signature")
	}
	if spec.artifactName != "" && assets[spec.artifactName].Name == "" {
		return ReleaseCandidate{}, errors.New("release is missing the artifact")
	}
	manifestLimit := int64(16 << 10)
	if spec.head == "" {
		manifestLimit = 128 << 10
	}
	raw, err := provider.Download(ctx, manifestAsset.URL, manifestLimit)
	if err != nil {
		return ReleaseCandidate{}, err
	}
	signature, err := provider.Download(ctx, signatureAsset.URL, 4<<10)
	if err != nil {
		return ReleaseCandidate{}, err
	}
	manifest, err := ParseAndVerifyManifest(raw, signature, key)
	if err != nil {
		return ReleaseCandidate{}, err
	}
	if manifest.NormalizedFamily() != spec.family || manifest.NormalizedPlatform() != spec.platform {
		return ReleaseCandidate{}, errors.New("release asset names do not match the signed manifest")
	}
	artifactName := spec.artifactName
	if spec.head != "" {
		if spec.manifestName != spec.head+manifest.Arch+".json" {
			return ReleaseCandidate{}, errors.New("release asset names do not match the signed envelope")
		}
		artifactName = manifest.ArtifactAssetName
	}
	artifact, ok := assets[artifactName]
	if !ok {
		return ReleaseCandidate{}, errors.New("release is missing the artifact its manifest names")
	}
	return ReleaseCandidate{Manifest: manifest, Raw: raw, Signature: signature, Artifact: artifact}, nil
}

// CheckCandidate applies the checks a GitHub release must pass before its
// candidate is stored: the signed channel must be the one the GitHub release
// kind implies (a prerelease is Beta, anything else is Stable), the artifact
// asset must have the size the manifest signs, and it must fit the update
// size limit.
func CheckCandidate(release ProviderRelease, candidate ReleaseCandidate, maximumBytes int64) error {
	expected := "stable"
	if release.Prerelease {
		expected = "beta"
	}
	manifest := candidate.Manifest
	if manifest.Channel != expected || manifest.ArtifactSize() != candidate.Artifact.Size || manifest.ArtifactSize() > maximumBytes {
		return errors.New("GitHub asset metadata does not match the signed update manifest")
	}
	return nil
}

// recordID is the deterministic id of a stored release. A GitHub release can
// hold several player releases, so the family and architecture join the
// GitHub release id. The Android id keeps its original form, so a release
// imported before the coordinated release keeps its id.
func recordID(githubReleaseID int64, family, architecture string) uuid.UUID {
	name := fmt.Sprintf("github:%d", githubReleaseID)
	if family != FamilyAndroid {
		name = fmt.Sprintf("github:%d:%s:%s", githubReleaseID, family, architecture)
	}
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(name))
}

// importRelease stores every player release a GitHub release verifies, each
// independently, and returns how many are now present (stored now or stored
// by an earlier check) with a problem for each that is not. A release that is
// complete in the database is not downloaded again; releases are immutable.
func (s *Service) importRelease(ctx context.Context, release ProviderRelease) (int, []error) {
	specs := releaseSpecs(release.Assets)
	if len(specs) == 0 {
		return 0, nil
	}
	if present, err := s.storedSpecs(ctx, release.ID); err == nil {
		missing := false
		for _, spec := range specs {
			if !present[specKey(spec)] {
				missing = true
				break
			}
		}
		if !missing {
			return len(specs), nil
		}
	}
	candidates, discovered := DiscoverRelease(ctx, s.provider, s.key, release)
	var problems []error
	for _, problem := range discovered {
		problems = append(problems, problem)
	}
	imported := 0
	for _, candidate := range candidates {
		problem := ReleaseProblem{Family: candidate.Manifest.NormalizedFamily(), Architecture: candidate.Manifest.Architecture()}
		if problem.Err = CheckCandidate(release, candidate, s.maxAPK); problem.Err != nil {
			problems = append(problems, problem)
			continue
		}
		if problem.Err = s.storeCandidate(ctx, release, candidate); problem.Err != nil {
			problems = append(problems, problem)
			continue
		}
		imported++
	}
	return imported, problems
}

// specKey names a stored release by the family and architecture the database
// keys it on.
func specKey(spec releaseSpec) string {
	return spec.family + "/" + spec.architecture()
}

func (s *Service) storedSpecs(ctx context.Context, githubReleaseID int64) (map[string]bool, error) {
	rows, err := s.db.Query(ctx, `SELECT player_family,architecture FROM player_releases WHERE github_release_id=$1`, githubReleaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	present := map[string]bool{}
	for rows.Next() {
		var family, architecture string
		if err := rows.Scan(&family, &architecture); err != nil {
			return nil, err
		}
		present[family+"/"+architecture] = true
	}
	return present, rows.Err()
}

func (s *Service) storeCandidate(ctx context.Context, release ProviderRelease, candidate ReleaseCandidate) error {
	manifest := candidate.Manifest
	id := recordID(release.ID, manifest.NormalizedFamily(), manifest.Architecture())
	_, err := s.db.Exec(ctx, `INSERT INTO player_releases(id,github_release_id,github_tag,platform,player_family,architecture,channel,version_code,version_name,application_id,minimum_sdk,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_bytes,manifest_signature,state_schema_version,apk_download_url,verification_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,'verified_manifest') ON CONFLICT(github_release_id,player_family,architecture) DO UPDATE SET manifest=EXCLUDED.manifest,manifest_bytes=EXCLUDED.manifest_bytes,manifest_signature=EXCLUDED.manifest_signature,updated_at=now()`, id, release.ID, release.Tag, manifest.NormalizedPlatform(), manifest.NormalizedFamily(), manifest.Architecture(), manifest.Channel, manifest.VersionCode, manifest.VersionName, manifestApplicationID(manifest), manifestMinimumSDK(manifest), manifest.ReleaseNotes, release.PublishedAt, manifest.AssetName(), manifest.ArtifactSize(), manifest.ArtifactHash(), strings.ToLower(manifest.SigningCertificateSHA256), string(candidate.Raw), candidate.Raw, strings.TrimSpace(string(candidate.Signature)), manifestStateSchema(manifest), candidate.Artifact.URL)
	return err
}

// VerifyReleaseArtifact checks the bytes of a release artifact against the
// signed manifest that names it: the size, the SHA-256, and for Android the
// APK signing certificate and package metadata. The server runs the same
// checks when it caches an artifact; the release publication check runs them
// before the release exists.
func VerifyReleaseArtifact(path string, manifest Manifest) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != manifest.ArtifactSize() {
		return errors.New("release artifact size does not match the signed manifest")
	}
	file, err := os.Open(path)
	if err != nil {
		return errors.New("release artifact could not be read")
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil || hex.EncodeToString(hash.Sum(nil)) != manifest.ArtifactHash() {
		return errors.New("release artifact SHA-256 does not match the signed manifest")
	}
	if manifest.NormalizedPlatform() == PlatformAndroid {
		return verifyAPK(path, manifest)
	}
	return nil
}
