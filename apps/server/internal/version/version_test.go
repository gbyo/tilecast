package version

import (
	"strings"
	"testing"
)

func TestDefaultBuildIsUnmistakablyDevelopment(t *testing.T) {
	t.Cleanup(func() {
		Version = DevelopmentVersion
		Channel = ChannelDevelopment
	})
	Version = DevelopmentVersion
	Channel = ChannelDevelopment
	if Display() != DevelopmentVersion {
		t.Fatalf("default display = %q, want %q", Display(), DevelopmentVersion)
	}
	if !strings.HasSuffix(Display(), "-dev") {
		t.Fatalf("default display %q must carry a -dev suffix", Display())
	}
}

func TestDisplayMarksDevelopmentBuilds(t *testing.T) {
	t.Cleanup(func() {
		Version = DevelopmentVersion
		Channel = ChannelDevelopment
	})
	Channel = ChannelDevelopment
	// Even if a development build somehow carries a bare version string,
	// it must never present itself as a Stable release.
	Version = "0.11.0"
	if got := Display(); got != "0.11.0-dev" {
		t.Fatalf("development display = %q, want %q", got, "0.11.0-dev")
	}
}

func TestDisplayReportsInjectedVersionForStable(t *testing.T) {
	t.Cleanup(func() {
		Version = DevelopmentVersion
		Channel = ChannelDevelopment
	})
	// The release workflow injects the tag version with channel=stable.
	Version = "0.11.0"
	Channel = ChannelStable
	if got := Display(); got != "0.11.0" {
		t.Fatalf("stable display = %q, want %q", got, "0.11.0")
	}
}

func TestParseReleaseTag(t *testing.T) {
	cases := []struct {
		tag     string
		version string
		valid   bool
	}{
		{"server-v0.11.0", "0.11.0", true},
		{"server-v1.2.3", "1.2.3", true},
		{"server-v0.11.0-beta", "", false},
		{"server-v0.11", "", false},
		{"v0.11.0", "", false},
		{"player-v0.11.0", "", false},
		{"server-v0.11.0 ", "", false},
		{" server-v0.11.0", "", false},
		{"latest", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		version, err := ParseReleaseTag(tc.tag)
		if !tc.valid {
			if err == nil {
				t.Errorf("ParseReleaseTag(%q) = %q, want an error", tc.tag, version)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseReleaseTag(%q) returned an error: %v", tc.tag, err)
			continue
		}
		if version != tc.version {
			t.Errorf("ParseReleaseTag(%q) = %q, want %q", tc.tag, version, tc.version)
		}
	}
}
