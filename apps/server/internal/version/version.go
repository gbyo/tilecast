// Package version exposes the Tilecast server release identity used in API
// responses and backup manifests.
//
// The coordinated release tag, vX.Y.Z for Stable or vX.Y.Z-beta.N for Beta, is
// the authoritative version. Release builds inject it with -ldflags at image
// build time:
//
//	go build -ldflags="-X .../version.Version=X.Y.Z -X .../version.Channel=stable -X .../version.Commit=<sha> -X .../version.Date=<rfc3339>"
//
// The zero values below describe a local development build. No
// source-version-bump commit is needed to cut a release, and anything that is
// not a Stable or Beta release build keeps Development identity.
package version

import (
	"fmt"
	"regexp"
	"strings"
)

// Release channels. Tilecast Server has three: Stable for normal self-hosted
// installs, Beta for early access to the next Stable, and Development
// tracking main.
const (
	ChannelStable      = "stable"
	ChannelBeta        = "beta"
	ChannelDevelopment = "development"
)

// DevelopmentVersion is the version reported by builds that did not receive
// a release version at build time: local builds and Development images.
const DevelopmentVersion = "0.0.0-dev"

var (
	// Version is the server version, injected at build time for Stable and
	// Beta releases. Every other build keeps the Development default.
	Version = DevelopmentVersion
	// Channel is the release channel of this build, injected at build time.
	Channel = ChannelDevelopment
	// Commit is the full git commit this build was produced from.
	Commit = "local"
	// Date is the RFC 3339 UTC timestamp of the build.
	Date = "development"
)

// IsRelease reports whether this build is a Stable or Beta release rather than
// a development build.
func IsRelease() bool {
	return Channel == ChannelStable || Channel == ChannelBeta
}

// Display reports the server version as shown to operators and stamped into
// backups. Stable and Beta builds report the bare release version from their
// tag; anything else is unmistakably a development build.
func Display() string {
	if IsRelease() {
		return Version
	}
	if strings.HasSuffix(Version, "-dev") {
		return Version
	}
	return Version + "-dev"
}

// Build describes the running server build for backup manifests and support
// diagnostics.
type Build struct {
	Version string
	Channel string
	Commit  string
	Date    string
}

// CurrentBuild captures the identity of the running binary.
func CurrentBuild() Build {
	return Build{Version: Display(), Channel: Channel, Commit: Commit, Date: Date}
}

// releaseTagPattern matches the only accepted release tag shape: vX.Y.Z for
// Stable and vX.Y.Z-beta.N for Beta. packages/player-contracts/fixtures/
// release-versions.json is the corpus for which versions the unified release
// accepts; scripts/release/release_version.py applies the same rule.
var releaseTagPattern = regexp.MustCompile(`^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-beta\.([1-9][0-9]?))?$`)

// ParseReleaseTag validates a coordinated release tag and returns its version
// and channel. Keep it in step with the tag check in
// .github/workflows/release.yml.
func ParseReleaseTag(tag string) (versionName, channel string, err error) {
	matches := releaseTagPattern.FindStringSubmatch(tag)
	if matches == nil {
		return "", "", fmt.Errorf("release tag must use v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-beta.<n>")
	}
	versionName = fmt.Sprintf("%s.%s.%s", matches[1], matches[2], matches[3])
	if matches[4] == "" {
		return versionName, ChannelStable, nil
	}
	return versionName + "-beta." + matches[4], ChannelBeta, nil
}
