package fleetops

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func playlistRequest(ids ...uuid.UUID) Request {
	playlist := uuid.New()
	return Request{ScreenIDs: ids, Action: ActionAssignPlaylist, PlaylistID: &playlist}
}

func TestValidateRequiresScreens(t *testing.T) {
	request := playlistRequest()
	if err := request.Validate(); !errors.Is(err, ErrValidation) {
		t.Errorf("Validate() = %v, want a validation error", err)
	}
}

func TestValidateRejectsTooManyScreens(t *testing.T) {
	ids := make([]uuid.UUID, MaxScreensPerOperation+1)
	for i := range ids {
		ids[i] = uuid.New()
	}
	err := playlistRequest(ids...).Validate()
	if !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "no more than") {
		t.Errorf("Validate() = %v, want a size limit error", err)
	}
}

func TestValidateRejectsBothPresentations(t *testing.T) {
	playlist, layout := uuid.New(), uuid.New()
	request := Request{
		ScreenIDs: []uuid.UUID{uuid.New()}, Action: ActionAssignPlaylist,
		PlaylistID: &playlist, LayoutID: &layout,
	}
	if err := request.Validate(); !errors.Is(err, ErrValidation) {
		t.Errorf("Validate() = %v, want a validation error", err)
	}
}

func TestValidateRejectsUnknownAction(t *testing.T) {
	request := Request{ScreenIDs: []uuid.UUID{uuid.New()}, Action: "delete_everything"}
	if err := request.Validate(); !errors.Is(err, ErrValidation) {
		t.Errorf("Validate() = %v, want a validation error", err)
	}
}

func TestSetEnabledNeedsAnExplicitValue(t *testing.T) {
	// A missing flag must not default to one of the two outcomes.
	request := Request{ScreenIDs: []uuid.UUID{uuid.New()}, Action: ActionSetEnabled}
	if err := request.Validate(); !errors.Is(err, ErrValidation) {
		t.Errorf("Validate() = %v, want a validation error", err)
	}
	enabled := false
	request.Enabled = &enabled
	if err := request.Validate(); err != nil {
		t.Errorf("Validate() = %v, want nil", err)
	}
}

func TestCommandsAreNotReversible(t *testing.T) {
	command := Request{ScreenIDs: []uuid.UUID{uuid.New()}, Action: ActionSendCommand, CommandType: "sync_now"}
	if command.Reversible() {
		t.Error("a delivered command cannot be recalled, so it must not offer undo")
	}
	if !playlistRequest(uuid.New()).Reversible() {
		t.Error("an assignment must be reversible")
	}
}

func TestChangesComparesAgainstCurrentState(t *testing.T) {
	playlist := uuid.New()
	other := uuid.New()
	request := Request{Action: ActionAssignPlaylist, PlaylistID: &playlist}

	if changes(screenRow{playlistID: &playlist}, request) {
		t.Error("assigning the playlist a screen already has is not a change")
	}
	if !changes(screenRow{playlistID: &other}, request) {
		t.Error("assigning a different playlist is a change")
	}
	if !changes(screenRow{}, request) {
		t.Error("assigning to an unassigned screen is a change")
	}
}

func TestClearIsOnlyAChangeWhenSomethingIsAssigned(t *testing.T) {
	request := Request{Action: ActionClearAssignment}
	if changes(screenRow{}, request) {
		t.Error("clearing an unassigned screen is not a change")
	}
	layout := uuid.New()
	if !changes(screenRow{layoutID: &layout}, request) {
		t.Error("clearing an assigned Layout is a change")
	}
}

func TestSetEnabledChangeDetection(t *testing.T) {
	on, off := true, false
	if changes(screenRow{enabled: true}, Request{Action: ActionSetEnabled, Enabled: &on}) {
		t.Error("enabling an enabled screen is not a change")
	}
	if !changes(screenRow{enabled: true}, Request{Action: ActionSetEnabled, Enabled: &off}) {
		t.Error("disabling an enabled screen is a change")
	}
}

func TestCommandIsAlwaysWork(t *testing.T) {
	// A command is an instruction, not a state, so it never reads as no-change.
	request := Request{Action: ActionSendCommand, CommandType: "sync_now"}
	if !changes(screenRow{enabled: true}, request) {
		t.Error("a command must always count as a change")
	}
}

func TestBlockedReasons(t *testing.T) {
	if got := blockedReason(screenRow{archived: true}, playlistRequest()); got != "Archived" {
		t.Errorf("archived screen = %q", got)
	}
	if got := blockedReason(screenRow{revoked: true}, playlistRequest()); got == "" {
		t.Error("a screen with no credential must be blocked")
	}
	if got := blockedReason(screenRow{enabled: true}, playlistRequest()); got != "" {
		t.Errorf("a healthy screen must not be blocked: %q", got)
	}
}

func TestDisabledScreenBlocksACommandButNotAnAssignment(t *testing.T) {
	row := screenRow{enabled: false}
	command := Request{Action: ActionSendCommand, CommandType: "sync_now"}
	if blockedReason(row, command) == "" {
		t.Error("a disabled screen cannot be sent a command")
	}
	// Assigning content to a disabled screen is legitimate preparation.
	if got := blockedReason(row, playlistRequest()); got != "" {
		t.Errorf("assignment to a disabled screen must be allowed: %q", got)
	}
}

func TestCurrentLabelPrefersWhatIsActuallyAssigned(t *testing.T) {
	playlist, layout := uuid.New(), uuid.New()
	if got := (screenRow{playlistID: &playlist, playlistName: "Menu"}).currentLabel(); got != "Playlist: Menu" {
		t.Errorf("currentLabel = %q", got)
	}
	if got := (screenRow{layoutID: &layout, layoutName: "Lobby"}).currentLabel(); got != "Layout: Lobby" {
		t.Errorf("currentLabel = %q", got)
	}
	if got := (screenRow{}).currentLabel(); got != "Nothing assigned" {
		t.Errorf("currentLabel = %q", got)
	}
}

func TestJoinNamesSummarisesLongLists(t *testing.T) {
	if got := joinNames([]string{"A"}); got != "A" {
		t.Errorf("joinNames = %q", got)
	}
	if got := joinNames([]string{"A", "B"}); got != "A and B" {
		t.Errorf("joinNames = %q", got)
	}
	got := joinNames([]string{"A", "B", "C", "D", "E"})
	if !strings.Contains(got, "and 2 more") {
		t.Errorf("joinNames = %q, want a summarised tail", got)
	}
}

func TestCommandIsSkippedForAScreenWhosePlayerCannotRunIt(t *testing.T) {
	service := &Service{}
	service.SetCommandApplicability(func(platform, commandType string) bool {
		return platform != "browser" || commandType == "sync_now"
	})
	browser := screenRow{enabled: true, platform: "browser"}
	if got := service.unsupportedReason(browser, Request{Action: ActionSendCommand, CommandType: "clear_media_cache"}); got == "" {
		t.Error("a Browser Player was offered a command it cannot run")
	}
	if got := service.unsupportedReason(browser, Request{Action: ActionSendCommand, CommandType: "sync_now"}); got != "" {
		t.Errorf("a supported command was blocked: %q", got)
	}
	if got := service.unsupportedReason(screenRow{enabled: true, platform: "linux"}, Request{Action: ActionSendCommand, CommandType: "clear_media_cache"}); got != "" {
		t.Errorf("a native player was blocked: %q", got)
	}
	// Only commands are checked.
	if got := service.unsupportedReason(browser, playlistRequest()); got != "" {
		t.Errorf("an assignment was blocked: %q", got)
	}
}
