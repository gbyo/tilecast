package demo

import (
	"fmt"

	"github.com/google/uuid"
)

// Every seeded record has a fixed ID so browser tests and screenshots can name
// it directly, and a reset recreates it under the same ID.
//
// The IDs follow de30KKKK-0000-4000-8000-00000000NNNN, where KKKK is the record
// kind and NNNN counts within it. The pattern is only a readability aid; code
// must use these values rather than parse them.
const (
	kindInstallation = 0x0
	kindUser         = 0x1
	kindLocation     = 0x2
	kindScreen       = 0x3
	kindGroup        = 0x4
	kindPlaylist     = 0x5
	kindLayout       = 0x6
	kindSchedule     = 0x7
	kindCampaign     = 0x8
	kindTag          = 0x9
	kindAsset        = 0xa
	kindPlayer       = 0xb
)

func fixedID(kind, n int) uuid.UUID {
	return uuid.MustParse(fmt.Sprintf("de30%04x-0000-4000-8000-%012x", kind, n))
}

// InstallationID is the installation identity of every demo database. It also
// marks the database as disposable: a reset refuses to wipe a database that
// holds any other installation.
var InstallationID = fixedID(kindInstallation, 0).String()

// IDs names every seeded record. A scenario may seed only some of them.
var IDs = struct {
	Owner, Administrator, Editor, Viewer uuid.UUID

	HighSchool, MiddleSchool, MainOffice, AthleticComplex uuid.UUID

	CafeteriaEast, CafeteriaWest, MainHallway, Library, FrontOffice, BoardRoom,
	MiddleSchoolCafeteria, MiddleSchoolLibrary, MiddleSchoolHallway,
	GymLobby, StadiumConcourse, TicketBooth, StaffLounge uuid.UUID

	CafeteriaDisplays, HallwayDisplays, Libraries, AthleticsDisplays uuid.UUID

	MorningAnnouncements, LunchRotation, Athletics, GeneralInformation, SpringMusical uuid.UUID

	HallwaySplit, LobbyPortrait uuid.UUID

	LunchService, FridayNightLights, MorningBroadcast uuid.UUID

	HomecomingWeek uuid.UUID

	TagAnnouncements, TagAthletics, TagFoodService, TagLibrary uuid.UUID

	WelcomeSlide, LunchMenuSlide, HomecomingSlide, LibraryHoursSlide, SpiritWeekSlide,
	WeatherSafetySlide, BoosterClubSlide, SpringMusicalSlide, LobbyClock, DistrictCalendar uuid.UUID
}{
	Owner: fixedID(kindUser, 1), Administrator: fixedID(kindUser, 2), Editor: fixedID(kindUser, 3), Viewer: fixedID(kindUser, 4),

	HighSchool: fixedID(kindLocation, 1), MiddleSchool: fixedID(kindLocation, 2), MainOffice: fixedID(kindLocation, 3), AthleticComplex: fixedID(kindLocation, 4),

	CafeteriaEast: fixedID(kindScreen, 1), CafeteriaWest: fixedID(kindScreen, 2), MainHallway: fixedID(kindScreen, 3),
	Library: fixedID(kindScreen, 4), FrontOffice: fixedID(kindScreen, 5), BoardRoom: fixedID(kindScreen, 6),
	MiddleSchoolCafeteria: fixedID(kindScreen, 7), MiddleSchoolLibrary: fixedID(kindScreen, 8), MiddleSchoolHallway: fixedID(kindScreen, 9),
	GymLobby: fixedID(kindScreen, 10), StadiumConcourse: fixedID(kindScreen, 11), TicketBooth: fixedID(kindScreen, 12),
	StaffLounge: fixedID(kindScreen, 13),

	CafeteriaDisplays: fixedID(kindGroup, 1), HallwayDisplays: fixedID(kindGroup, 2), Libraries: fixedID(kindGroup, 3), AthleticsDisplays: fixedID(kindGroup, 4),

	MorningAnnouncements: fixedID(kindPlaylist, 1), LunchRotation: fixedID(kindPlaylist, 2), Athletics: fixedID(kindPlaylist, 3),
	GeneralInformation: fixedID(kindPlaylist, 4), SpringMusical: fixedID(kindPlaylist, 5),

	HallwaySplit: fixedID(kindLayout, 1), LobbyPortrait: fixedID(kindLayout, 2),

	LunchService: fixedID(kindSchedule, 1), FridayNightLights: fixedID(kindSchedule, 2), MorningBroadcast: fixedID(kindSchedule, 3),

	HomecomingWeek: fixedID(kindCampaign, 1),

	TagAnnouncements: fixedID(kindTag, 1), TagAthletics: fixedID(kindTag, 2), TagFoodService: fixedID(kindTag, 3), TagLibrary: fixedID(kindTag, 4),

	WelcomeSlide: fixedID(kindAsset, 1), LunchMenuSlide: fixedID(kindAsset, 2), HomecomingSlide: fixedID(kindAsset, 3),
	LibraryHoursSlide: fixedID(kindAsset, 4), SpiritWeekSlide: fixedID(kindAsset, 5), WeatherSafetySlide: fixedID(kindAsset, 6),
	BoosterClubSlide: fixedID(kindAsset, 7), SpringMusicalSlide: fixedID(kindAsset, 8), LobbyClock: fixedID(kindAsset, 9),
	DistrictCalendar: fixedID(kindAsset, 10),
}

// playerInstallationID is the ID a simulated Player generated for itself. Real
// players pick a random one; a fixed one lets a reset pair the same "device" to
// the same screen again.
func playerInstallationID(screen uuid.UUID) string {
	return uuid.NewSHA1(fixedID(kindPlayer, 0), screen[:]).String()
}
