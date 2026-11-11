package livestream

import "time"

// Transport is how a Watch Live profile reaches Studio.
type Transport string

const (
	TransportMJPEG Transport = "mjpeg"
	TransportH264  Transport = "h264"
)

// H264Codec is the WebCodecs codec string of every H.264 profile:
// Constrained Baseline, level 3.1, which covers 1280x720 at 15 FPS.
const H264Codec = "avc1.42e01f"

// Profile is one negotiated Watch Live capture and transport mode. Profiles
// are a closed vocabulary pinned by
// packages/player-contracts/fixtures/watch-live.json.
type Profile struct {
	ID            string
	Code          byte
	Transport     Transport
	MaxWidth      int
	MaxHeight     int
	FPS           int
	FrameInterval time.Duration
	TargetBitrate int
}

const (
	ProfileH264720p15  = "h264-720p15"
	ProfileH264540p15  = "h264-540p15"
	ProfileH264540p10  = "h264-540p10"
	ProfileMJPEG540p10 = "mjpeg-540p10"
	ProfileMJPEG360p8  = "mjpeg-360p8"
)

// Profiles lists every profile in preference order, best first.
var Profiles = []Profile{
	{ID: ProfileH264720p15, Code: 1, Transport: TransportH264, MaxWidth: 1280, MaxHeight: 720, FPS: 15, FrameInterval: 67 * time.Millisecond, TargetBitrate: 1_500_000},
	{ID: ProfileH264540p15, Code: 2, Transport: TransportH264, MaxWidth: 960, MaxHeight: 540, FPS: 15, FrameInterval: 67 * time.Millisecond, TargetBitrate: 900_000},
	{ID: ProfileH264540p10, Code: 3, Transport: TransportH264, MaxWidth: 960, MaxHeight: 540, FPS: 10, FrameInterval: 100 * time.Millisecond, TargetBitrate: 700_000},
	{ID: ProfileMJPEG540p10, Transport: TransportMJPEG, MaxWidth: 960, MaxHeight: 540, FPS: 10, FrameInterval: 100 * time.Millisecond},
	{ID: ProfileMJPEG360p8, Transport: TransportMJPEG, MaxWidth: 640, MaxHeight: 360, FPS: 8, FrameInterval: 125 * time.Millisecond},
}

// MaxProfileList bounds a viewer or Player profile list.
const MaxProfileList = 16

// LegacyProfile is what a Player or Studio that says nothing gets.
var legacyProfile = Profiles[len(Profiles)-1]

// legacyViewerProfiles is what a Studio start request without capability
// information can consume: the multipart MJPEG relay.
var legacyViewerProfiles = []string{ProfileMJPEG540p10, ProfileMJPEG360p8}

// legacyEdgeProfiles is what a Player that sent the retired
// captureProfile=edge-540p10 query can produce.
var legacyEdgeProfiles = []string{ProfileMJPEG540p10, ProfileMJPEG360p8}

func profileByID(id string) (Profile, int, bool) {
	for rank, profile := range Profiles {
		if profile.ID == id {
			return profile, rank, true
		}
	}
	return Profile{}, -1, false
}

func profileByCode(code byte) (Profile, bool) {
	if code == 0 {
		return Profile{}, false
	}
	for _, profile := range Profiles {
		if profile.Code == code {
			return profile, true
		}
	}
	return Profile{}, false
}

// NormalizeProfiles keeps the known IDs of a bounded list. Unknown IDs are
// ignored so a newer client can name profiles this server does not know.
func NormalizeProfiles(ids []string) []string {
	if ids == nil {
		return nil
	}
	known := make([]string, 0, len(Profiles))
	for _, profile := range Profiles {
		for _, id := range ids {
			if id == profile.ID {
				known = append(known, id)
				break
			}
		}
	}
	return known
}

// selectProfile returns the best profile both sides support, no better than
// ceilingRank (a session never upgrades). A nil list means the side did not
// say: a viewer is MJPEG-only and a Player is the legacy profile. When the
// sides share nothing, the legacy profile is the fallback every Player and
// Studio understands.
func selectProfile(viewer, player []string, ceilingRank int) (Profile, int) {
	if viewer == nil {
		viewer = legacyViewerProfiles
	}
	if player == nil {
		player = []string{legacyProfile.ID}
	}
	contains := func(list []string, id string) bool {
		for _, candidate := range list {
			if candidate == id {
				return true
			}
		}
		return false
	}
	if ceilingRank >= len(Profiles) {
		ceilingRank = len(Profiles) - 1
	}
	for rank, profile := range Profiles {
		if rank < ceilingRank {
			continue
		}
		if contains(viewer, profile.ID) && contains(player, profile.ID) {
			return profile, rank
		}
	}
	return legacyProfile, len(Profiles) - 1
}

// LegacyEdgeProfiles is the profile list of an older Edge Player that sent
// captureProfile=edge-540p10.
func LegacyEdgeProfiles() []string { return append([]string(nil), legacyEdgeProfiles...) }
