package updates

import (
	"regexp"
	"strconv"
	"strings"
)

const (
	// UnifiedCutoverCoreCode is the legacy code of 0.26.0, the first
	// coordinated Tilecast release. Every version shipped before the cutover
	// is below it, so every unified code is above every shipped code.
	UnifiedCutoverCoreCode = 26000
	// MaximumVersionCode is the largest update version code. It keeps every
	// code inside the Android versionCode range.
	MaximumVersionCode = 2_100_000_000

	betaSlotMaximum = 98
	stableSlot      = 99
)

var betaSuffixPattern = regexp.MustCompile(`^beta\.([1-9][0-9]?)$`)

// VersionCode is the update version code of a release version name. It is the
// one ordering the server, Tilecast Edge, the Windows Player, the Android
// build, and the release scripts share; packages/player-contracts/fixtures/
// release-versions.json is the corpus each of them runs.
//
// A name below the cutover keeps its legacy code, MAJOR*1000000 +
// MINOR*1000 + PATCH, and ignores any prerelease suffix, so every version
// that shipped before the unified release keeps its code. From the cutover
// on, a name is X.Y.Z (Stable) or X.Y.Z-beta.N (Beta, N from 1 to 98), and
// the code is that core code times 100 plus a slot: N for a Beta, 99 for
// Stable. A Beta therefore sorts below its own Stable and above the previous
// release, and a Beta can update to the next Beta or to Stable.
func VersionCode(name string) (int64, bool) {
	code, _, ok := parseVersion(name)
	return code, ok
}

// VersionChannel is the channel a version name implies: "stable" for X.Y.Z and
// "beta" for X.Y.Z-beta.N from the cutover on. Names below the cutover imply
// no channel.
func VersionChannel(name string) string {
	_, channel, ok := parseVersion(name)
	if !ok {
		return ""
	}
	return channel
}

// IsUnifiedVersion reports whether a name is at or above the cutover, where
// the unified naming rule applies.
func IsUnifiedVersion(name string) bool {
	core, ok := legacyCoreCode(name)
	return ok && core >= UnifiedCutoverCoreCode
}

func legacyCoreCode(name string) (int64, bool) {
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

func parseVersion(name string) (code int64, channel string, ok bool) {
	core, ok := legacyCoreCode(name)
	if !ok {
		return 0, "", false
	}
	if core < UnifiedCutoverCoreCode {
		return core, "", true
	}
	slot, channel := int64(stableSlot), "stable"
	if _, suffix, found := strings.Cut(name, "-"); found {
		match := betaSuffixPattern.FindStringSubmatch(suffix)
		if match == nil {
			return 0, "", false
		}
		number, _ := strconv.ParseInt(match[1], 10, 64)
		if number < 1 || number > betaSlotMaximum {
			return 0, "", false
		}
		slot, channel = number, "beta"
	}
	code = core*100 + slot
	if code > MaximumVersionCode {
		return 0, "", false
	}
	return code, channel, true
}

// validateVersionIdentity applies the unified naming rule to a signed
// manifest: from the cutover on, the version name must be a Stable or Beta
// name, its code must be the one VersionCode derives, and its channel must
// be the one the name implies. Names below the cutover are not constrained
// here; each family keeps its own historical rule for them.
func validateVersionIdentity(m Manifest) bool {
	if !IsUnifiedVersion(m.VersionName) {
		return true
	}
	code, channel, ok := parseVersion(m.VersionName)
	return ok && code == m.VersionCode && channel == m.Channel
}
