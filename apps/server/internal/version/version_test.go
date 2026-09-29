package version

import (
	"strings"
	"testing"
)

func TestDisplayMarksDevelopmentBuilds(t *testing.T) {
	t.Cleanup(func() { Channel = ChannelDevelopment })
	Channel = ChannelDevelopment
	if got := Display(); got != Version+"-dev" {
		t.Fatalf("development display = %q, want %q", got, Version+"-dev")
	}
	if Display() == Version {
		t.Fatal("development build must not present itself as the bare release version")
	}
}

func TestDisplayReportsBareVersionForStable(t *testing.T) {
	t.Cleanup(func() { Channel = ChannelDevelopment })
	Channel = ChannelStable
	if got := Display(); got != Version {
		t.Fatalf("stable display = %q, want %q", got, Version)
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

func TestVersionIsBareSemver(t *testing.T) {
	// The release workflow compares the tag version against this constant,
	// so it must never carry a suffix itself.
	if strings.ContainsAny(Version, "-+") || strings.Count(Version, ".") != 2 {
		t.Fatalf("Version %q must be a bare major.minor.patch release line", Version)
	}
}
