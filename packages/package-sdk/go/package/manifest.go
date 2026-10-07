// Package manifests the Tilecast package manifest
// (`tilecast.package.json`): distribution, version, provenance, and
// contribution metadata for independently distributed extension packages.
//
// A package is a distribution container, not a fourth extension API. The
// TypeScript validator in `../src/manifest.ts` is the authoring-time check;
// this parser is the server-authoritative one. The fixtures in
// `../testdata/manifests/` run through both, so the two cannot drift apart
// silently.
//
// A manifest is data. It declares no capabilities, no source, and no code
// to download: unknown fields are rejected, contribution paths point inside
// the package, and the host decides what an extension class may do.
package packagemanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// APIVersion is the package manifest version this SDK implements.
const APIVersion = 1

// SupportedAPIVersions lists the manifest versions this release can load.
var SupportedAPIVersions = []int{1}

var (
	packageIDPattern     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
	publisherIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	digestPattern        = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	semverPattern        = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`)
	tilecastRangePattern = regexp.MustCompile(`^(?:>=|<=|>|<|=)?\d{1,5}(?:\.\d{1,5}){0,2}(?: (?:>=|<=|>|<|=)?\d{1,5}(?:\.\d{1,5}){0,2})*$`)
	ociReferencePattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*(:[0-9]{1,5})?(\/[a-z0-9_][a-z0-9._-]{0,63})+$`)
	httpsURLPattern      = regexp.MustCompile(`^https:\/\/[^\/\s]+\/[^\/\s].{0,180}$`)
	packagePathPattern   = regexp.MustCompile(`^\.(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$`)
	rangeClausePattern   = regexp.MustCompile(`^(>=|<=|>|<|=)?(\d{1,5}(?:\.\d{1,5}){0,2})$`)
	versionPattern       = regexp.MustCompile(`^(\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?$`)
)

// Contribution types name the existing extension contract the nested
// manifest uses.
const (
	ContributionPlugin     = "plugin"
	ContributionWidget     = "widget"
	ContributionDataSource = "dataSource"
)

// Contribution is one bundled extension: its contract and the directory
// inside the package holding its manifest.
type Contribution struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

// Publisher identifies who publishes the package. The package ID starts
// with the publisher namespace.
type Publisher struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Manifest is a validated `tilecast.package.json`.
type Manifest struct {
	APIVersion     APIVersionNum  `json:"apiVersion"`
	PackageID      string         `json:"packageId"`
	PackageVersion string         `json:"packageVersion"`
	Name           string         `json:"name"`
	Description    string         `json:"description"`
	Publisher      Publisher      `json:"publisher"`
	Repository     string         `json:"repository"`
	License        string         `json:"license"`
	Tilecast       TilecastCompat `json:"tilecast"`
	Distribution   Distribution   `json:"distribution"`
	Contributions  []Contribution `json:"contributions"`
	Documentation  string         `json:"documentation,omitempty"`
	Issues         string         `json:"issues,omitempty"`
}

// TilecastCompat carries the supported Tilecast version range.
type TilecastCompat struct {
	Version string `json:"version"`
}

// Distribution names where the installer fetches package bytes.
type Distribution struct {
	OCI string `json:"oci"`
}

// APIVersionNum decodes leniently on purpose: JSON has no integer type, so
// 1 and 1.0 are the same document, and the TypeScript validator accepts
// both. Anything that is not exactly the number 1 is rejected.
type APIVersionNum int

// UnmarshalJSON implements json.Unmarshaler.
func (v *APIVersionNum) UnmarshalJSON(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	number, ok := value.(float64)
	if !ok || number != APIVersion {
		return fmt.Errorf("apiVersion must be %d", APIVersion)
	}
	*v = APIVersionNum(APIVersion)
	return nil
}

// Parse decodes and validates one package manifest document. Unknown fields
// are rejected, so a manifest cannot smuggle in capabilities, sources, or
// executable references the contract does not define.
func Parse(data []byte) (Manifest, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("package manifest: %w", err)
	}
	if err := Validate(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// Validate checks every manifest rule the TypeScript schema enforces.
func Validate(m Manifest) error {
	if m.APIVersion != APIVersion {
		return fmt.Errorf("package manifest: apiVersion must be %d", APIVersion)
	}
	if utf8.RuneCountInString(m.PackageID) > 128 || !packageIDPattern.MatchString(m.PackageID) {
		return fmt.Errorf("package manifest: packageId must be a qualified identity such as acme.athletics")
	}
	if strings.Split(m.PackageID, ".")[0] == "tilecast" {
		return fmt.Errorf("package manifest: the tilecast namespace is reserved for the release")
	}
	if utf8.RuneCountInString(m.PackageVersion) > 64 || !semverPattern.MatchString(m.PackageVersion) {
		return fmt.Errorf("package manifest: packageVersion must be SemVer such as 2.4.1")
	}
	if !boundedText(m.Name, 80) {
		return fmt.Errorf("package manifest: name must be 1 to 80 characters")
	}
	if !boundedText(m.Description, 500) {
		return fmt.Errorf("package manifest: description must be 1 to 500 characters")
	}
	if !publisherIDPattern.MatchString(m.Publisher.ID) {
		return fmt.Errorf("package manifest: publisher id must be one namespace segment")
	}
	if !boundedText(m.Publisher.Name, 80) {
		return fmt.Errorf("package manifest: publisher name must be 1 to 80 characters")
	}
	if m.PackageID != m.Publisher.ID && !strings.HasPrefix(m.PackageID, m.Publisher.ID+".") {
		return fmt.Errorf("package manifest: packageId must start with the publisher namespace")
	}
	if !ValidHTTPSURL(m.Repository) {
		return fmt.Errorf("package manifest: repository must be an https URL with a host and path")
	}
	if !boundedText(m.License, 32) {
		return fmt.Errorf("package manifest: license must be 1 to 32 characters")
	}
	if utf8.RuneCountInString(m.Tilecast.Version) > 128 || !tilecastRangePattern.MatchString(m.Tilecast.Version) {
		return fmt.Errorf("package manifest: tilecast version must be space-separated clauses such as >=1.2.0 <2.0.0")
	}
	if utf8.RuneCountInString(m.Distribution.OCI) > 255 || !ociReferencePattern.MatchString(m.Distribution.OCI) {
		return fmt.Errorf("package manifest: distribution oci must be an OCI registry/repository without tag or digest")
	}
	if len(m.Contributions) < 1 || len(m.Contributions) > 64 {
		return fmt.Errorf("package manifest: contributions must hold 1 to 64 entries")
	}
	seen := make(map[string]bool, len(m.Contributions))
	for _, contribution := range m.Contributions {
		switch contribution.Type {
		case ContributionPlugin, ContributionWidget, ContributionDataSource:
		default:
			return fmt.Errorf("package manifest: contribution type must be plugin, widget, or dataSource")
		}
		if !packagePathPattern.MatchString(contribution.Path) {
			return fmt.Errorf("package manifest: contribution path must be a ./relative path inside the package")
		}
		key := contribution.Path
		if seen[key] {
			return fmt.Errorf("package manifest: contribution paths must be unique")
		}
		seen[key] = true
	}
	if m.Documentation != "" && !ValidHTTPSURL(m.Documentation) {
		return fmt.Errorf("package manifest: documentation must be an https URL with a host and path")
	}
	if m.Issues != "" && !ValidHTTPSURL(m.Issues) {
		return fmt.Errorf("package manifest: issues must be an https URL with a host and path")
	}
	return nil
}

func boundedText(value string, max int) bool {
	count := utf8.RuneCountInString(value)
	return count >= 1 && count <= max
}

// ValidPackageID reports whether id is a loadable external package identity:
// qualified, bounded, and outside the reserved tilecast namespace.
func ValidPackageID(id string) bool {
	return utf8.RuneCountInString(id) <= 128 && packageIDPattern.MatchString(id) &&
		strings.Split(id, ".")[0] != "tilecast"
}

// ValidSemVer reports whether version is strict SemVer.
func ValidSemVer(version string) bool {
	return utf8.RuneCountInString(version) <= 64 && semverPattern.MatchString(version)
}

// ValidOCIReference reports whether ref is a tagless, digestless OCI
// registry/repository the installer may resolve.
func ValidOCIReference(ref string) bool {
	return utf8.RuneCountInString(ref) <= 255 && ociReferencePattern.MatchString(ref)
}

// ValidDigest reports whether digest is a pinned sha256 content address.
func ValidDigest(digest string) bool {
	return digestPattern.MatchString(digest)
}

// ValidPublisherID reports whether id is one namespace segment.
func ValidPublisherID(id string) bool {
	return publisherIDPattern.MatchString(id)
}

// ValidHTTPSURL reports whether value is an https URL with a host and path,
// the shape repository, documentation, and issue links take in manifests
// and marketplace listings alike.
func ValidHTTPSURL(value string) bool {
	return utf8.RuneCountInString(value) <= 200 && httpsURLPattern.MatchString(value)
}

// ValidTilecastRange reports whether version is a space-separated set of
// Tilecast compatibility clauses.
func ValidTilecastRange(version string) bool {
	return utf8.RuneCountInString(version) <= 128 && tilecastRangePattern.MatchString(version)
}

// InNamespace reports whether the contribution ID equals the package ID or
// lives beneath it.
func InNamespace(contributionID, packageID string) bool {
	return contributionID == packageID || strings.HasPrefix(contributionID, packageID+".")
}

// SatisfiesTilecastRange reports whether a Tilecast version satisfies a
// manifest compatibility range. Every space-separated clause must hold.
// Unknown input fails closed.
func SatisfiesTilecastRange(versionRange, version string) bool {
	current, ok := parseTilecastVersion(version)
	if !ok {
		return false
	}
	clauses := strings.Fields(versionRange)
	if len(clauses) == 0 {
		return false
	}
	for _, clause := range clauses {
		parts := rangeClausePattern.FindStringSubmatch(clause)
		if parts == nil {
			return false
		}
		wanted, ok := parseTilecastVersion(parts[2])
		if !ok {
			return false
		}
		order := compareVersions(current, wanted)
		switch parts[1] {
		case ">":
			if order <= 0 {
				return false
			}
		case ">=":
			if order < 0 {
				return false
			}
		case "<":
			if order >= 0 {
				return false
			}
		case "<=":
			if order > 0 {
				return false
			}
		default:
			if order != 0 {
				return false
			}
		}
	}
	return true
}

type tilecastVersion [3]int

func parseTilecastVersion(value string) (tilecastVersion, bool) {
	parts := versionPattern.FindStringSubmatch(strings.TrimSpace(value))
	if parts == nil {
		return tilecastVersion{}, false
	}
	var version tilecastVersion
	for i := 1; i <= 3; i++ {
		if parts[i] == "" {
			continue
		}
		var n int
		for _, digit := range parts[i] {
			n = n*10 + int(digit-'0')
		}
		version[i-1] = n
	}
	return version, true
}

func compareVersions(left, right tilecastVersion) int {
	for i := 0; i < 3; i++ {
		if left[i] != right[i] {
			if left[i] < right[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// semverParts splits a validated SemVer into its core triple, prerelease
// identifiers, and build metadata (which never affects precedence).
type semverParts struct {
	core       [3]int
	prerelease []string
}

// CompareSemver orders two SemVer versions by semver.org precedence: core
// triples numerically, a version without prerelease above one with it, and
// prerelease identifiers numerically when both are numeric, lexically
// otherwise. Build metadata is ignored. Either version malformed fails
// closed as unordered.
func CompareSemver(left, right string) (int, bool) {
	l, ok := parseSemver(left)
	if !ok {
		return 0, false
	}
	r, ok := parseSemver(right)
	if !ok {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if l.core[i] != r.core[i] {
			if l.core[i] < r.core[i] {
				return -1, true
			}
			return 1, true
		}
	}
	if len(l.prerelease) == 0 && len(r.prerelease) == 0 {
		return 0, true
	}
	if len(l.prerelease) == 0 {
		return 1, true
	}
	if len(r.prerelease) == 0 {
		return -1, true
	}
	for i := 0; i < len(l.prerelease) && i < len(r.prerelease); i++ {
		order, done := comparePrereleaseID(l.prerelease[i], r.prerelease[i])
		if done {
			return order, true
		}
	}
	switch {
	case len(l.prerelease) < len(r.prerelease):
		return -1, true
	case len(l.prerelease) > len(r.prerelease):
		return 1, true
	default:
		return 0, true
	}
}

func parseSemver(version string) (semverParts, bool) {
	var out semverParts
	core, rest, hasPre := strings.Cut(version, "-")
	if hasPre {
		rest, _, _ = strings.Cut(rest, "+")
		if rest == "" {
			return out, false
		}
	} else if i := strings.Index(core, "+"); i >= 0 {
		core = core[:i]
	}
	nums := strings.Split(core, ".")
	if len(nums) != 3 {
		return out, false
	}
	for i, num := range nums {
		if num == "" || (len(num) > 1 && num[0] == '0') {
			return out, false
		}
		n := 0
		for _, digit := range num {
			if digit < '0' || digit > '9' {
				return out, false
			}
			n = n*10 + int(digit-'0')
		}
		out.core[i] = n
	}
	if rest != "" {
		out.prerelease = strings.Split(rest, ".")
		for _, id := range out.prerelease {
			if id == "" {
				return out, false
			}
			for _, r := range id {
				if r != '-' && (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
					return out, false
				}
			}
			if len(id) > 1 && id[0] == '0' && isNumeric(id) {
				return out, false
			}
		}
	}
	return out, true
}

func isNumeric(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}

func comparePrereleaseID(left, right string) (int, bool) {
	if left == right {
		return 0, false
	}
	leftNum, rightNum := isNumeric(left), isNumeric(right)
	switch {
	case leftNum && rightNum:
		// No leading zeros, so length orders first.
		if len(left) != len(right) {
			if len(left) < len(right) {
				return -1, true
			}
			return 1, true
		}
		if left < right {
			return -1, true
		}
		return 1, true
	case leftNum:
		return -1, true
	case rightNum:
		return 1, true
	default:
		if left < right {
			return -1, true
		}
		return 1, true
	}
}
