// Package version exposes the Tilecast server release identity used in API
// responses and backup manifests.
//
// The server-vX.Y.Z release tag is the authoritative Stable version. Release
// builds inject it with -ldflags at image build time:
//
//	go build -ldflags="-X .../version.Version=X.Y.Z -X .../version.Channel=stable -X .../version.Commit=<sha> -X .../version.Date=<rfc3339>"
//
// The zero values below describe a local development build. No
// source-version-bump commit is needed to cut a release: tagging main is
// enough, and anything that is not a Stable release build keeps
// Development identity.
package version

import (
	"fmt"
	"regexp"
	"strings"
)

// Release channels. Tilecast Server ships exactly two: Stable for normal
// self-hosted installs and Development tracking main.
const (
	ChannelStable      = "stable"
	ChannelDevelopment = "development"
)

// DevelopmentVersion is the version reported by builds that did not receive
// a release version at build time: local builds and Development images.
const DevelopmentVersion = "0.0.0-dev"

var (
	// Version is the server version, injected at build time for Stable
	// releases. Every other build keeps the Development default.
	Version = DevelopmentVersion
	// Channel is the release channel of this build, injected at build time.
	Channel = ChannelDevelopment
	// Commit is the full git commit this build was produced from.
	Commit = "local"
	// Date is the RFC 3339 UTC timestamp of the build.
	Date = "development"
)

// Display reports the server version as shown to operators and stamped into
// backups. Stable builds report the bare release version from their tag;
// anything else is unmistakably a development build.
func Display() string {
	if Channel == ChannelStable {
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

// releaseTagPattern matches the only accepted server release tag shape:
// server-vMAJOR.MINOR.PATCH with no prerelease suffix. There is no beta
// channel for Tilecast Server.
var releaseTagPattern = regexp.MustCompile(`^server-v([0-9]+)\.([0-9]+)\.([0-9]+)$`)

// ParseReleaseTag validates a server release tag and returns its version.
// It mirrors the tag check in .github/workflows/server-release.yml; keep the
// two patterns identical.
func ParseReleaseTag(tag string) (string, error) {
	matches := releaseTagPattern.FindStringSubmatch(tag)
	if matches == nil {
		return "", fmt.Errorf("release tag must use server-v<major>.<minor>.<patch>")
	}
	return fmt.Sprintf("%s.%s.%s", matches[1], matches[2], matches[3]), nil
}
