package demo

import (
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// The two scenarios share these primitives. A future scenario such as
// large-fleet or offline-fleet reuses them with different screen lists rather
// than adding another seeding path.

const (
	ScenarioBasic       = "basic"
	ScenarioKitchenSink = "kitchen-sink"
)

func init() {
	register(Scenario{Name: ScenarioBasic, Description: "Two buildings, four screens, and two playlists.", seed: seedBasic, screens: basicScreens})
	register(Scenario{Name: ScenarioKitchenSink, Description: "A district with thirteen screens in every status, groups, schedules, Layouts, a campaign, and plugins.", seed: seedKitchenSink, screens: kitchenSinkScreens})
}

// Hardware the demo fleet reports. Versions trail the current releases on some
// screens so update and version views have something to compare.
var (
	fireTVCurrent = Device{Platform: "fire-tv", Manufacturer: "Amazon", Model: "AFTKRT", OSVersion: "11", PlayerVersion: "0.25.0", VersionCode: 46, AndroidSDK: 30, Width: 1920, Height: 1080, Density: 2}
	fireTVOlder   = Device{Platform: "fire-tv", Manufacturer: "Amazon", Model: "AFTSSS", OSVersion: "9", PlayerVersion: "0.23.0", VersionCode: 43, AndroidSDK: 28, Width: 1920, Height: 1080, Density: 2}
	googleTV4K    = Device{Platform: "android-tv", Manufacturer: "Google", Model: "Google TV Streamer", OSVersion: "14", PlayerVersion: "0.25.0", VersionCode: 46, AndroidSDK: 34, Width: 3840, Height: 2160, Density: 2}
	sonyBravia    = Device{Platform: "android-tv", Manufacturer: "Sony", Model: "BRAVIA 4K VH2", OSVersion: "12", PlayerVersion: "0.24.1", VersionCode: 45, AndroidSDK: 31, Width: 3840, Height: 2160, Density: 2}
	linuxCurrent  = Device{Platform: "linux", Manufacturer: "hs-library-01", Model: "Linux arm64", OSVersion: "6.6.51+rpt-rpi-2712", PlayerVersion: "0.17.0", Width: 1920, Height: 1080, Density: 1}
	linuxPortrait = Device{Platform: "linux", Manufacturer: "gym-lobby-01", Model: "Linux x64", OSVersion: "6.8.0-45-generic", PlayerVersion: "0.17.0", Width: 1080, Height: 1920, Density: 1}
	linuxOlder    = Device{Platform: "linux", Manufacturer: "board-room-01", Model: "Linux arm64", OSVersion: "6.1.21-v8+", PlayerVersion: "0.16.2", Width: 1920, Height: 1080, Density: 1}
)

func ptr[T any](value T) *T { return &value }

func seedBasic(b *builder) error {
	if err := seedLocations(b, IDs.HighSchool, IDs.MainOffice); err != nil {
		return err
	}
	for _, screen := range basicScreens() {
		if err := b.screen(screen); err != nil {
			return err
		}
	}
	if err := b.group(IDs.CafeteriaDisplays, "Cafeteria Displays", "Menu boards in every cafeteria.", IDs.CafeteriaEast); err != nil {
		return err
	}
	if err := b.slides(demoSlides(IDs.WelcomeSlide, IDs.LunchMenuSlide, IDs.LibraryHoursSlide)...); err != nil {
		return err
	}
	if err := b.playlist(IDs.MorningAnnouncements, "Morning Announcements", "Start-of-day messages for every building.", true,
		playlistItem{Asset: IDs.WelcomeSlide, Duration: 12 * time.Second},
		playlistItem{Asset: IDs.LibraryHoursSlide, Duration: 10 * time.Second}); err != nil {
		return err
	}
	if err := b.playlist(IDs.LunchRotation, "Lunch Rotation", "Today's menu and cafeteria reminders.", true,
		playlistItem{Asset: IDs.LunchMenuSlide, Duration: 15 * time.Second}); err != nil {
		return err
	}
	if err := b.assignGroup(IDs.CafeteriaDisplays, &IDs.LunchRotation, nil); err != nil {
		return err
	}
	return b.assignScreen(IDs.MainHallway, &IDs.MorningAnnouncements, nil)
}

func basicScreens() []ScreenSpec {
	return []ScreenSpec{
		{ID: IDs.CafeteriaEast, Name: "Cafeteria East", LocationID: &IDs.HighSchool, RoomName: "Cafeteria", Device: fireTVCurrent, State: StateOnline},
		{ID: IDs.MainHallway, Name: "Main Hallway", LocationID: &IDs.HighSchool, RoomName: "Main entrance", Device: googleTV4K, State: StateOnline},
		{ID: IDs.FrontOffice, Name: "Front Office", LocationID: &IDs.MainOffice, RoomName: "Reception", Device: sonyBravia, State: StateRecent},
		{ID: IDs.Library, Name: "Library", LocationID: &IDs.HighSchool, RoomName: "Library", RoomNumber: "L-104", Device: linuxCurrent, State: StateOffline},
	}
}

func seedKitchenSink(b *builder) error {
	steps := []func(*builder) error{
		seedPeople,
		func(b *builder) error {
			return seedLocations(b, IDs.HighSchool, IDs.MiddleSchool, IDs.MainOffice, IDs.AthleticComplex)
		},
		seedFleet,
		seedGroups,
		seedLibrary,
		seedPlaylistsAndLayouts,
		seedAssignments,
		seedSchedules,
		seedCampaign,
		seedPlugins,
		seedSettings,
	}
	for _, step := range steps {
		if err := step(b); err != nil {
			return err
		}
	}
	return nil
}

func seedPeople(b *builder) error {
	people := []struct {
		id                   uuid.UUID
		name, username, role string
	}{
		{IDs.Administrator, "Marcus Reyes", "marcus.reyes", "administrator"},
		{IDs.Editor, "Priya Natarajan", "priya.natarajan", "editor"},
		{IDs.Viewer, "Tom Becker", "tom.becker", "viewer"},
	}
	for _, person := range people {
		if err := b.user(person.id, person.name, person.username, person.role); err != nil {
			return err
		}
	}
	return nil
}

var demoLocations = map[uuid.UUID]devices.LocationInput{
	IDs.HighSchool:      {Name: "High School", AddressLine1: "1200 Falcon Way", City: "Springfield", State: "IL", PostalCode: "62704", Country: "United States"},
	IDs.MiddleSchool:    {Name: "Middle School", AddressLine1: "800 Maple Avenue", City: "Springfield", State: "IL", PostalCode: "62704", Country: "United States"},
	IDs.MainOffice:      {Name: "Main Office", AddressLine1: "15 Civic Plaza", City: "Springfield", State: "IL", PostalCode: "62701", Country: "United States"},
	IDs.AthleticComplex: {Name: "Athletic Complex", AddressLine1: "1250 Falcon Way", City: "Springfield", State: "IL", PostalCode: "62704", Country: "United States"},
}

func seedLocations(b *builder, locations ...uuid.UUID) error {
	for _, id := range locations {
		if err := b.location(id, demoLocations[id]); err != nil {
			return err
		}
	}
	return nil
}

// kitchenSinkScreens covers every status Tilecast computes except revoked,
// which removes a screen from the fleet list.
func kitchenSinkScreens() []ScreenSpec {
	return []ScreenSpec{
		{ID: IDs.CafeteriaEast, Name: "Cafeteria East", LocationID: &IDs.HighSchool, RoomName: "Cafeteria", Description: "Above the east serving line.", Device: fireTVCurrent, State: StateOnline},
		{ID: IDs.CafeteriaWest, Name: "Cafeteria West", LocationID: &IDs.HighSchool, RoomName: "Cafeteria", Description: "Beside the west entrance.", Device: fireTVCurrent, State: StateOnline},
		{ID: IDs.MainHallway, Name: "Main Hallway", LocationID: &IDs.HighSchool, RoomName: "Main entrance", Device: googleTV4K, State: StateOnline},
		{ID: IDs.Library, Name: "Library", LocationID: &IDs.HighSchool, RoomName: "Library", RoomNumber: "L-104", Device: linuxCurrent, State: StateRecent},
		{ID: IDs.FrontOffice, Name: "Front Office", LocationID: &IDs.MainOffice, RoomName: "Reception", Device: sonyBravia, State: StateOnline},
		{ID: IDs.BoardRoom, Name: "Board Room", LocationID: &IDs.MainOffice, RoomName: "Board room", RoomNumber: "210", Device: linuxOlder, State: StateStale},
		{ID: IDs.MiddleSchoolCafeteria, Name: "Middle School Cafeteria", LocationID: &IDs.MiddleSchool, RoomName: "Cafeteria", Device: fireTVOlder, State: StateOnline},
		{ID: IDs.MiddleSchoolLibrary, Name: "Middle School Library", LocationID: &IDs.MiddleSchool, RoomName: "Media center", Device: fireTVOlder, State: StateOffline},
		{ID: IDs.MiddleSchoolHallway, Name: "Middle School Main Hallway", LocationID: &IDs.MiddleSchool, RoomName: "Main hallway", Description: "Disabled while the hallway is repainted.", Device: sonyBravia, State: StateDisabled},
		{ID: IDs.GymLobby, Name: "Gym Lobby", LocationID: &IDs.AthleticComplex, RoomName: "Lobby", Description: "Portrait display by the trophy case.", Device: linuxPortrait, State: StateOnline},
		{ID: IDs.StadiumConcourse, Name: "Stadium Concourse", LocationID: &IDs.AthleticComplex, RoomName: "North concourse", Device: googleTV4K, State: StateOffline},
		{ID: IDs.TicketBooth, Name: "Ticket Booth", LocationID: &IDs.AthleticComplex, RoomName: "Gate A", Device: fireTVCurrent, State: StateStale},
		{ID: IDs.StaffLounge, Name: "Staff Lounge", Description: "Newly installed; no content yet.", Device: fireTVCurrent, State: StateOnline},
	}
}

func seedFleet(b *builder) error {
	for _, screen := range kitchenSinkScreens() {
		if err := b.screen(screen); err != nil {
			return err
		}
	}
	return b.pendingPairing(fireTVCurrent)
}

func seedGroups(b *builder) error {
	groups := []struct {
		id          uuid.UUID
		name, about string
		screens     []uuid.UUID
	}{
		{IDs.CafeteriaDisplays, "Cafeteria Displays", "Menu boards in every cafeteria.", []uuid.UUID{IDs.CafeteriaEast, IDs.CafeteriaWest, IDs.MiddleSchoolCafeteria}},
		{IDs.HallwayDisplays, "Hallway Displays", "Main hallway screens in each school.", []uuid.UUID{IDs.MainHallway, IDs.MiddleSchoolHallway}},
		{IDs.Libraries, "Libraries", "Library and media center displays.", []uuid.UUID{IDs.Library, IDs.MiddleSchoolLibrary}},
		{IDs.AthleticsDisplays, "Athletics Displays", "Gym, stadium, and ticket booth screens.", []uuid.UUID{IDs.GymLobby, IDs.StadiumConcourse, IDs.TicketBooth}},
	}
	for _, group := range groups {
		if err := b.group(group.id, group.name, group.about, group.screens...); err != nil {
			return err
		}
	}
	return nil
}

var slideCatalog = map[uuid.UUID]slideAsset{
	IDs.WelcomeSlide:       {Name: "Welcome Back, Falcons", Slide: slide{Filename: "welcome-back.png", Title: "Welcome back, Falcons", Subtitle: "Classes begin at 8:05 a.m. Doors open at 7:30.", Background: rgb(0x1E3A5F), Accent: rgb(0xF2B134)}},
	IDs.LunchMenuSlide:     {Name: "Lunch Menu", Slide: slide{Filename: "lunch-menu.png", Title: "Today's lunch", Subtitle: "Chicken tacos, black beans, fresh fruit, milk", Background: rgb(0x2F5D3A), Accent: rgb(0xF4E285)}},
	IDs.HomecomingSlide:    {Name: "Homecoming Game", Slide: slide{Filename: "homecoming.png", Title: "Homecoming game", Subtitle: "Friday 7 p.m. at Falcon Stadium", Background: rgb(0x6B1E2E), Accent: rgb(0xF2B134)}},
	IDs.LibraryHoursSlide:  {Name: "Library Hours", Slide: slide{Filename: "library-hours.png", Title: "Library hours", Subtitle: "Monday to Thursday 7:15 a.m. to 4:30 p.m.", Background: rgb(0x1F5F63), Accent: rgb(0xB8E0D2)}},
	IDs.SpiritWeekSlide:    {Name: "Spirit Week", Slide: slide{Filename: "spirit-week.png", Title: "Spirit week", Subtitle: "Tuesday is jersey day. Wear your team colors.", Background: rgb(0x4A2C6D), Accent: rgb(0xF2B134)}},
	IDs.WeatherSafetySlide: {Name: "Severe Weather Procedures", Slide: slide{Filename: "weather-safety.png", Title: "Severe weather", Subtitle: "Move to the interior hallway and wait for staff.", Background: rgb(0x3B3F46), Accent: rgb(0xE4572E)}},
	IDs.BoosterClubSlide:   {Name: "Booster Club", Slide: slide{Filename: "booster-club.png", Title: "Join the booster club", Subtitle: "Meetings every second Monday in the library.", Background: rgb(0x7A2E1F), Accent: rgb(0xF4E285)}},
	IDs.SpringMusicalSlide: {Name: "Spring Musical", Slide: slide{Filename: "spring-musical.png", Title: "Spring musical", Subtitle: "Auditions open in March. Sign up in room 118.", Background: rgb(0x5C2751), Accent: rgb(0xF7C6D9)}},
}

func demoSlides(ids ...uuid.UUID) []slideAsset {
	result := make([]slideAsset, 0, len(ids))
	for _, id := range ids {
		asset := slideCatalog[id]
		asset.ID = id
		result = append(result, asset)
	}
	return result
}

func seedLibrary(b *builder) error {
	tags := []struct {
		id          uuid.UUID
		name, color string
	}{
		{IDs.TagAnnouncements, "Announcements", "#1E3A5F"},
		{IDs.TagAthletics, "Athletics", "#6B1E2E"},
		{IDs.TagFoodService, "Food Service", "#2F5D3A"},
		{IDs.TagLibrary, "Library", "#1F5F63"},
	}
	for _, tag := range tags {
		if err := b.tag(tag.id, tag.name, tag.color); err != nil {
			return err
		}
	}
	if err := b.slides(demoSlides(IDs.WelcomeSlide, IDs.LunchMenuSlide, IDs.HomecomingSlide, IDs.LibraryHoursSlide,
		IDs.SpiritWeekSlide, IDs.WeatherSafetySlide, IDs.BoosterClubSlide, IDs.SpringMusicalSlide)...); err != nil {
		return err
	}
	tagged := map[uuid.UUID][]uuid.UUID{
		IDs.TagAnnouncements: {IDs.WelcomeSlide, IDs.SpiritWeekSlide, IDs.WeatherSafetySlide},
		IDs.TagAthletics:     {IDs.HomecomingSlide, IDs.BoosterClubSlide},
		IDs.TagFoodService:   {IDs.LunchMenuSlide},
		IDs.TagLibrary:       {IDs.LibraryHoursSlide},
	}
	for _, tag := range []uuid.UUID{IDs.TagAnnouncements, IDs.TagAthletics, IDs.TagFoodService, IDs.TagLibrary} {
		if err := b.tagAssets(tag, tagged[tag]...); err != nil {
			return err
		}
	}
	if err := b.widget(IDs.LobbyClock, media.WidgetInput{Provider: "clock", Name: "Lobby Clock", Description: "Central time, 12-hour.",
		Configuration: mustJSON(map[string]any{"timezone": demoTimezone, "format": "12", "showSeconds": false, "foregroundColor": "#ffffff", "backgroundColor": "#1e3a5f"})}); err != nil {
		return err
	}
	return b.website(IDs.DistrictCalendar, media.WebsiteInput{Name: "District Calendar", Description: "Public events calendar.", WebsiteConfig: media.WebsiteConfig{
		URL: "https://example.com/district-calendar", JavaScriptEnabled: true, DOMStorageEnabled: true, CookiePolicy: "first_party",
		ReloadPolicy: "on_each_activation", LoadTimeoutSeconds: 20, ZoomPercent: 100, BackgroundColor: "#1E3A5F", FailureBehavior: "placeholder",
	}})
}

func seedPlaylistsAndLayouts(b *builder) error {
	if err := b.playlist(IDs.GeneralInformation, "General Information", "Evergreen information for lobbies and libraries.", true,
		playlistItem{Asset: IDs.WelcomeSlide, Duration: 12 * time.Second},
		playlistItem{Asset: IDs.LibraryHoursSlide, Duration: 10 * time.Second},
		playlistItem{Asset: IDs.WeatherSafetySlide, Duration: 10 * time.Second}); err != nil {
		return err
	}
	// The hallway Layout frames General Information with the spirit week slide
	// and a banner. It has no clock: no released player reports the
	// environment.time capability a clock inside a Layout requires.
	if err := b.layout(IDs.HallwaySplit, "Hallway Split", "Playlist zone with a spirit week panel and school banner.", "landscape", 1920, 1080, true,
		layouts.Placement{ID: uuid.NewSHA1(IDs.HallwaySplit, []byte("zone")), Type: "playlistZone", Name: "Announcements", X: 0, Y: 0, Width: 1440, Height: 1080, Layer: 1, Opacity: 1, Visible: true, PlaylistID: &IDs.GeneralInformation},
		layouts.Placement{ID: uuid.NewSHA1(IDs.HallwaySplit, []byte("panel")), Type: "asset", Name: "Spirit week", X: 1440, Y: 0, Width: 480, Height: 540, Layer: 2, Opacity: 1, Visible: true, AssetID: &IDs.SpiritWeekSlide},
		layouts.Placement{ID: uuid.NewSHA1(IDs.HallwaySplit, []byte("banner")), Type: "primitive", Name: "Banner", X: 1440, Y: 540, Width: 480, Height: 540, Layer: 3, Opacity: 1, Visible: true,
			Primitive: &layouts.Primitive{Kind: "text", Text: "Go Falcons!", FontSize: 64, FontWeight: 700, TextAlign: "center", VerticalAlign: "middle", Color: "#FFFFFF", BackgroundColor: "#6B1E2E"}},
	); err != nil {
		return err
	}
	// An unpublished portrait draft, so Studio shows a Layout that has never
	// reached a screen. The Lobby Clock appears only here and in the library,
	// because no released player can display a clock Widget yet.
	if err := b.layout(IDs.LobbyPortrait, "Lobby Portrait", "Draft for the gym lobby portrait display.", "portrait", 1080, 1920, false,
		layouts.Placement{ID: uuid.NewSHA1(IDs.LobbyPortrait, []byte("hero")), Type: "asset", Name: "Hero", X: 0, Y: 0, Width: 1080, Height: 1440, Layer: 1, Opacity: 1, Visible: true, AssetID: &IDs.HomecomingSlide},
		layouts.Placement{ID: uuid.NewSHA1(IDs.LobbyPortrait, []byte("clock")), Type: "widget", Name: "Clock", X: 0, Y: 1440, Width: 1080, Height: 480, Layer: 2, Opacity: 1, Visible: true, WidgetID: &IDs.LobbyClock},
	); err != nil {
		return err
	}
	if err := b.playlist(IDs.MorningAnnouncements, "Morning Announcements", "Start-of-day messages for every building.", true,
		playlistItem{Asset: IDs.WelcomeSlide, Duration: 12 * time.Second},
		playlistItem{Asset: IDs.SpiritWeekSlide, Duration: 10 * time.Second},
		playlistItem{Asset: IDs.WeatherSafetySlide, Duration: 10 * time.Second},
		playlistItem{Asset: IDs.DistrictCalendar, Duration: 30 * time.Second}); err != nil {
		return err
	}
	if err := b.playlist(IDs.LunchRotation, "Lunch Rotation", "Today's menu and cafeteria reminders.", true,
		playlistItem{Asset: IDs.LunchMenuSlide, Duration: 15 * time.Second},
		playlistItem{Asset: IDs.SpiritWeekSlide, Duration: 8 * time.Second},
		playlistItem{Asset: IDs.BoosterClubSlide, Duration: 8 * time.Second}); err != nil {
		return err
	}
	if err := b.playlist(IDs.Athletics, "Athletics", "Game days, boosters, and ticket information.", true,
		playlistItem{Asset: IDs.HomecomingSlide, Duration: 12 * time.Second},
		playlistItem{Asset: IDs.BoosterClubSlide, Duration: 10 * time.Second},
		playlistItem{Layout: &IDs.HallwaySplit, Duration: 20 * time.Second}); err != nil {
		return err
	}
	// Created but never published: a draft playlist in the library.
	return b.playlist(IDs.SpringMusical, "Spring Musical", "Draft promotion for spring auditions.", false,
		playlistItem{Asset: IDs.SpringMusicalSlide, Duration: 12 * time.Second})
}

// seedAssignments leaves Staff Lounge unassigned and gives every other screen
// content through its group or directly.
func seedAssignments(b *builder) error {
	groups := []struct {
		group            uuid.UUID
		playlist, layout *uuid.UUID
	}{
		{IDs.CafeteriaDisplays, &IDs.MorningAnnouncements, nil},
		{IDs.HallwayDisplays, nil, &IDs.HallwaySplit},
		{IDs.Libraries, &IDs.GeneralInformation, nil},
		{IDs.AthleticsDisplays, &IDs.GeneralInformation, nil},
	}
	for _, assignment := range groups {
		if err := b.assignGroup(assignment.group, assignment.playlist, assignment.layout); err != nil {
			return err
		}
	}
	if err := b.assignScreen(IDs.FrontOffice, &IDs.GeneralInformation, nil); err != nil {
		return err
	}
	return b.assignScreen(IDs.BoardRoom, &IDs.MorningAnnouncements, nil)
}

func seedSchedules(b *builder) error {
	weekdays := []int{1, 2, 3, 4, 5}
	schedules := []struct {
		id    uuid.UUID
		input scheduling.Input
	}{
		{IDs.LunchService, scheduling.Input{Name: "Lunch Service", Description: "Menu boards during lunch periods.", PlaylistID: IDs.LunchRotation,
			Type: scheduling.Weekly, Timezone: demoTimezone, Priority: 50, Enabled: true, DailyStart: ptr("10:30"), DailyEnd: ptr("13:30"), DaysOfWeek: weekdays,
			Targets: []scheduling.Target{{Type: "group", ID: IDs.CafeteriaDisplays}}}},
		{IDs.MorningBroadcast, scheduling.Input{Name: "Morning Broadcast", Description: "Announcements before first period.", PlaylistID: IDs.MorningAnnouncements,
			Type: scheduling.Weekly, Timezone: demoTimezone, Priority: 40, Enabled: true, DailyStart: ptr("07:15"), DailyEnd: ptr("08:15"), DaysOfWeek: weekdays,
			Targets: []scheduling.Target{{Type: "group", ID: IDs.Libraries}, {Type: "screen", ID: IDs.FrontOffice}}}},
		{IDs.FridayNightLights, scheduling.Input{Name: "Friday Night Lights", Description: "Game-day content across the athletic complex.", PlaylistID: IDs.Athletics,
			Type: scheduling.Weekly, Timezone: demoTimezone, Priority: 60, Enabled: true, DailyStart: ptr("15:00"), DailyEnd: ptr("23:00"), DaysOfWeek: []int{5},
			Targets: []scheduling.Target{{Type: "group", ID: IDs.AthleticsDisplays}}}},
	}
	for _, schedule := range schedules {
		if err := b.schedule(schedule.id, schedule.input); err != nil {
			return err
		}
	}
	return nil
}

// seedCampaign leaves Homecoming Week as a draft with one planned block, so
// the campaign editor has content without publishing schedules.
func seedCampaign(b *builder) error {
	start := time.Now().In(mustLocation(demoTimezone)).AddDate(0, 0, 14)
	startDate := start.Format("2006-01-02")
	endDate := start.AddDate(0, 0, 4).Format("2006-01-02")
	return b.campaign(IDs.HomecomingWeek, "Homecoming Week", "Spirit days, the parade, and the homecoming game.", func(draft *campaigns.Snapshot) {
		draft.Destinations = []campaigns.Destination{{Type: "group", ID: IDs.AthleticsDisplays}, {Type: "group", ID: IDs.CafeteriaDisplays}}
		draft.Blocks = []campaigns.Block{{
			ID: uuid.NewSHA1(IDs.HomecomingWeek, []byte("spirit-days")), Name: "Spirit days", ContentType: "playlist", ContentID: IDs.Athletics,
			Priority: 70, Type: string(scheduling.Weekly), Timezone: demoTimezone, StartDate: &startDate, EndDate: &endDate,
			DailyStart: ptr("07:00"), DailyEnd: ptr("16:00"), DaysOfWeek: []int{1, 2, 3, 4, 5},
		}}
	})
}

// seedPlugins lets each plugin that contributes Demo Mode data seed its own.
func seedPlugins(b *builder) error {
	if err := b.svc.Plugins.SeedDemo(b.ctx, plugin.Demo{
		Scenario: "district", OwnerID: b.owner, Timezone: demoTimezone,
		Locations: map[string]uuid.UUID{
			"high_school": IDs.HighSchool, "middle_school": IDs.MiddleSchool,
			"main_office": IDs.MainOffice, "athletic_complex": IDs.AthleticComplex,
		},
	}); err != nil {
		return err
	}
	if err := b.installPlugins(plugins.BrandBugID); err != nil {
		return err
	}
	_, err := b.svc.Plugins.CreateBrandBug(b.ctx, b.owner, plugins.BrandBugInput{
		Name: "Falcons mark", Corner: "top_right", Text: "Go Falcons", WidthPercent: 12, TextSizePercent: 3, OpacityPercent: 85,
		MarginPercent: 3, TextColor: "#FFFFFF", BackgroundStyle: "scrim", Enabled: true, TargetScope: "all", TargetIDs: []uuid.UUID{},
	})
	return err
}

func seedSettings(b *builder) error {
	return b.organizationSettings(map[string]any{
		"organization.short_name":      "Demo District",
		"organization.timezone":        demoTimezone,
		"organization.support_name":    "District Technology Help Desk",
		"organization.support_email":   "helpdesk@example.org",
		"organization.support_message": "Call extension 4400 for display problems.",
	})
}

func mustLocation(name string) *time.Location {
	location, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return location
}
