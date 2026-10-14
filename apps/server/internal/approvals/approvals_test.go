package approvals

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

type stubSettings struct {
	values map[string]any
	err    error
}

func (s stubSettings) Organization(context.Context) (settings.Document, error) {
	return settings.Document{Values: s.values}, s.err
}

func TestApprovalIsOffByDefault(t *testing.T) {
	// An installation that upgrades must not find every playlist unassignable.
	svc := NewService(nil, stubSettings{values: map[string]any{}})
	if svc.Required(context.Background()) {
		t.Error("approval must default to off")
	}
}

func TestApprovalReadsTheSetting(t *testing.T) {
	svc := NewService(nil, stubSettings{values: map[string]any{"content.approval_required": true}})
	if !svc.Required(context.Background()) {
		t.Error("the setting was not read")
	}
}

func TestUnreadableSettingsDoNotBlockTheFleet(t *testing.T) {
	// Same rule as the MFA enrollment policy: an unreadable policy value means
	// "not required". Failing closed here would make a settings outage look
	// like every playlist being unapprovable.
	svc := NewService(nil, stubSettings{err: errors.New("database is unreachable")})
	if svc.Required(context.Background()) {
		t.Error("a settings failure must not gate assignment")
	}
}

func TestGateIsANoOpWhenApprovalIsOff(t *testing.T) {
	// No database is wired in, so reaching a query at all would panic. Passing
	// proves the gate short-circuits before touching one.
	svc := NewService(nil, stubSettings{values: map[string]any{}})
	if err := svc.Gate(context.Background(), TypePlaylist, testUUID()); err != nil {
		t.Errorf("Gate = %v, want nil", err)
	}
}

func TestUnknownContentTypeIsRejected(t *testing.T) {
	svc := NewService(nil, stubSettings{values: map[string]any{"content.approval_required": true}})
	_, err := svc.currentRevision(context.Background(), nil, "screen", testUUID(), false)
	if !errors.Is(err, ErrValidation) {
		t.Errorf("currentRevision = %v, want a validation error", err)
	}
}

func TestTheGatedRevisionReadLocksTheRowAnEditWrites(t *testing.T) {
	// Without the lock the gate answers about a revision that can change before
	// the assignment commits. The lock has to name the row an edit actually
	// writes: the playlists row, or the layouts row a publish repoints. Locking
	// layout_revisions would block nothing, because a publish inserts a new
	// revision rather than changing the old one.
	for _, testCase := range []struct{ contentType, want string }{
		{TypePlaylist, "FOR SHARE"},
		{TypeLayout, "FOR SHARE OF l"},
	} {
		query, err := revisionQuery(testCase.contentType, true)
		if err != nil {
			t.Fatalf("revisionQuery(%s) = %v", testCase.contentType, err)
		}
		if !strings.HasSuffix(query, testCase.want) {
			t.Errorf("%s locked with %q, want a %q suffix", testCase.contentType, query, testCase.want)
		}
	}
}

func TestTheAdvisoryRevisionReadTakesNoLock(t *testing.T) {
	// The preview and the reviewer's own read must not hold an editor's save open.
	for _, contentType := range []string{TypePlaylist, TypeLayout} {
		query, err := revisionQuery(contentType, false)
		if err != nil {
			t.Fatalf("revisionQuery(%s) = %v", contentType, err)
		}
		if strings.Contains(query, "FOR SHARE") {
			t.Errorf("%s read unlocked still locks: %q", contentType, query)
		}
	}
}

func testUUID() uuid.UUID { return uuid.MustParse("11111111-1111-1111-1111-111111111111") }

func TestNotApprovedErrorNamesTheContentType(t *testing.T) {
	// The message reaches an operator through a 409, so it has to read as a
	// sentence about their playlist, not as an error chain.
	err := errUnapproved(TypePlaylist)
	if !strings.Contains(err.Error(), "playlist") {
		t.Errorf("error = %q", err)
	}
	if !errors.Is(err, ErrNotApproved) {
		t.Error("the sentinel must be preserved for the HTTP mapping")
	}
}

func TestReviewPolicyModes(t *testing.T) {
	if reviewRequiredFor(PolicyOff, builtin("contributor"), TypePlaylist) {
		t.Error("off policy unexpectedly requires review")
	}
	if !reviewRequiredFor(PolicyContributors, builtin("contributor"), TypePlaylist) {
		t.Error("Contributor work should require review")
	}
	if reviewRequiredFor(PolicyContributors, builtin("editor"), TypePlaylist) {
		t.Error("manager publication should remain direct under contributor policy")
	}
	if !reviewRequiredFor(PolicyEveryone, builtin("owner"), TypePlaylist) {
		t.Error("everyone policy should require review for owners")
	}
}

func TestCampaignPublicationPermissionDoesNotGrantEditorScheduleAuthority(t *testing.T) {
	if !canAuthor(TypeCampaign, builtin("editor")) {
		t.Error("editor should be able to author campaigns")
	}
	if canPublishContent(TypeCampaign, builtin("editor")) {
		t.Error("editor must not publish campaign schedule changes")
	}
	if !canPublishContent(TypeCampaign, builtin("administrator")) {
		t.Error("administrator should publish campaign schedule changes")
	}
}

func TestSemanticPlaylistDiffNamesMeaningfulChanges(t *testing.T) {
	before := json.RawMessage(`{"name":"Morning","items":[{"id":"a","position":0,"durationMs":5000}]}`)
	after := json.RawMessage(`{"name":"Morning board","items":[{"id":"a","position":0,"durationMs":7000},{"id":"b","position":1,"durationMs":5000}]}`)
	changes := semanticChanges(TypePlaylist, before, after)
	if len(changes) != 3 {
		t.Fatalf("changes=%#v, want details plus added and changed items", changes)
	}
	kinds := map[string]bool{}
	for _, change := range changes {
		kinds[change.Kind] = true
	}
	for _, kind := range []string{"details_changed", "item_added", "item_changed"} {
		if !kinds[kind] {
			t.Fatalf("changes=%#v missing %s", changes, kind)
		}
	}
}

// builtin is a built-in role's authority, as the request layer resolves it.
func builtin(role string) Authority {
	capabilities, _ := auth.BuiltinCapabilities(role)
	return capabilities
}

// TestReviewFollowsCapabilitiesNotRoleNames pins that a custom role is
// reviewed by what it can do: under the Contributors policy, an author who
// cannot publish playlists waits for review, and one who can does not.
func TestReviewFollowsCapabilitiesNotRoleNames(t *testing.T) {
	author := auth.NewCapabilitySet(auth.CapPlaylistRead, auth.CapPlaylistEdit)
	publisher := auth.NewCapabilitySet(auth.CapPlaylistRead, auth.CapPlaylistEdit, auth.CapPlaylistPublish)
	if !reviewRequiredFor(PolicyContributors, author, TypePlaylist) {
		t.Error("an author without publish rights should be reviewed")
	}
	if reviewRequiredFor(PolicyContributors, publisher, TypePlaylist) {
		t.Error("an author with publish rights should publish directly")
	}
	if !reviewRequiredFor(PolicyContributors, publisher, TypeLayout) {
		t.Error("publish rights for playlists must not cover Layouts")
	}
}
