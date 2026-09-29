// Package version exposes the Tilecast server release identity used in API
// responses and backup manifests.
//
// Version is the release line in source. A Stable release tag server-vX.Y.Z
// must match it exactly; the server release workflow enforces that before it
// publishes anything. Channel, Commit, and Date are build metadata injected
// with -ldflags at image build time:
//
//	go build -ldflags="-X .../version.Channel=stable -X .../version.Commit=<sha> -X .../version.Date=<rfc3339>"
//
// The zero values below describe a local development build. Development
// builds always report Version with a -dev suffix so they can never present
// themselves as exactly the same version as a published Stable release.
package version

import (
	"fmt"
	"regexp"
)

// Version is the Tilecast server release line. Bump it in the change that
// prepares a Stable release so the release tag and the source agree.
const Version = "0.10.0"

// Release channels. Tilecast Server ships exactly two: Stable for normal
// self-hosted installs and Development tracking main.
const (
	ChannelStable      = "stable"
	ChannelDevelopment = "development"
)

var (
	// Channel is the release channel of this build, injected at build time.
	Channel = ChannelDevelopment
	// Commit is the full git commit this build was produced from.
	Commit = "local"
	// Date is the RFC 3339 UTC timestamp of the build.
	Date = "development"
)

// Display reports the server version as shown to operators and stamped into
// backups. Stable builds report the bare release version; anything else is
// unmistakably a development build.
func Display() string {
	if Channel == ChannelStable {
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
