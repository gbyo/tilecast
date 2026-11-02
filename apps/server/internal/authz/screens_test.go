package authz

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

func restricted() ScreenAccess {
	return ScreenAccess{UserID: uuid.New(), Configured: true}
}

func TestScreenSQLUsesTheCallersAlias(t *testing.T) {
	// The screens table is aliased `s` in one query and `sc` in another. A
	// hard-coded alias would silently compare the wrong row.
	withSC := restricted().ScreenSQL("sc", "$1")
	if !strings.Contains(withSC, "sc.location_id") || !strings.Contains(withSC, "sc.id") {
		t.Errorf("predicate did not use the alias:\n%s", withSC)
	}
	withS := restricted().ScreenSQL("s", "$3")
	if !strings.Contains(withS, "s.location_id") || !strings.Contains(withS, "user_id=$3") {
		t.Errorf("predicate did not use the alias or parameter:\n%s", withS)
	}
	if strings.Contains(withS, "$1") {
		t.Error("the user parameter must be the one the caller named")
	}
}

func TestScreenSQLCoversBothGrantKinds(t *testing.T) {
	sql := restricted().ScreenSQL("sc", "$1")
	for _, want := range []string{"scope_type='location'", "scope_type='group'", "screen_group_memberships"} {
		if !strings.Contains(sql, want) {
			t.Errorf("predicate lacks %s", want)
		}
	}
}

func TestPredicatesAreSelfContained(t *testing.T) {
	// The fragments are pasted into larger WHERE clauses, so each has to be
	// parenthesised or an adjacent OR would change its meaning.
	access := restricted()
	for name, sql := range map[string]string{
		"screen":   access.ScreenSQL("sc", "$1"),
		"group":    access.GroupSQL("g", "$1"),
		"schedule": access.ScheduleSQL("sch", "$1"),
		"takeover": access.TakeoverSQL("t.id", "$1"),
		"location": access.LocationVisibleSQL("l", "$1"),
		"pairing":  access.PairingCodeSQL("p", "$1"),
	} {
		sql = strings.TrimSpace(sql)
		if !strings.HasPrefix(sql, "(") && !strings.HasPrefix(sql, "EXISTS") || !strings.HasSuffix(sql, ")") {
			t.Errorf("%s predicate must be self-contained:\n%s", name, sql)
		}
	}
}

func TestPolicyModeDecidesThePredicate(t *testing.T) {
	user := uuid.New()
	if got := (ScreenAccess{UserID: user, All: true, Configured: true}).ScreenSQL("s", "$1"); !strings.HasSuffix(got, "OR TRUE)") || strings.Contains(got, "user_screen_scopes") {
		t.Errorf("all = %q, want a constant TRUE", got)
	}
	// A missing policy reaches nothing, whatever grant rows remain.
	if got := (ScreenAccess{UserID: user}).ScreenSQL("s", "$1"); !strings.HasSuffix(got, "AND FALSE)") || strings.Contains(got, "user_screen_scopes") {
		t.Errorf("missing policy = %q, want a constant FALSE", got)
	}
	if got := (ScreenAccess{UserID: user}).GroupSQL("g", "$1"); !strings.HasSuffix(got, "AND FALSE)") {
		t.Errorf("missing policy group = %q, want a constant FALSE", got)
	}
	// The constants still name the parameter so PostgreSQL can type it.
	if got := (ScreenAccess{UserID: user, All: true}).ScreenSQL("s", "$3"); !strings.Contains(got, "$3::uuid") {
		t.Errorf("all = %q, want the parameter named", got)
	}
	if got := (ScreenAccess{UserID: user}).Mode(); got != ModeRestricted {
		t.Errorf("missing policy mode = %q, want restricted", got)
	}
}

func TestGroupPredicateNeedsAnAnchor(t *testing.T) {
	// An empty group must not pass by vacuous truth: the predicate needs a
	// direct grant or at least one member.
	sql := restricted().GroupSQL("g", "$1")
	if !strings.Contains(sql, "authz_any.screen_group_id=g.id") {
		t.Errorf("group predicate does not require a member:\n%s", sql)
	}
	schedule := restricted().ScheduleSQL("sch", "$1")
	if !strings.Contains(schedule, "authz_t0.schedule_id=sch.id") {
		t.Errorf("schedule predicate does not require a target:\n%s", schedule)
	}
}

func TestRequireIsDenyByDefault(t *testing.T) {
	if err := Require(Actor{}, auth.CapScreenRead); !errors.Is(err, ErrForbidden) {
		t.Fatalf("anonymous actor err = %v, want ErrForbidden", err)
	}
	actor := Actor{UserID: uuid.New(), Capabilities: auth.NewCapabilitySet(auth.CapScreenRead)}
	if err := Require(actor, auth.CapScreenRead); err != nil {
		t.Fatalf("held capability err = %v", err)
	}
	if err := Require(actor, auth.CapScreenRead, auth.CapScreenManage); !errors.Is(err, ErrForbidden) {
		t.Fatalf("missing capability err = %v, want ErrForbidden", err)
	}
}

func TestOwnerNeedsNoPolicyRow(t *testing.T) {
	// No database: the Owner rule must not read one.
	access, err := New(nil).Access(context.Background(), Actor{UserID: uuid.New(), Owner: true})
	if err != nil || !access.All {
		t.Fatalf("owner access = %+v, %v", access, err)
	}
}

func TestPolicyInputValidation(t *testing.T) {
	for _, test := range []struct {
		name  string
		input PolicyInput
		ok    bool
	}{
		{"all", PolicyInput{Mode: ModeAll}, true},
		{"all with grants", PolicyInput{Mode: ModeAll, Grants: []Grant{{Type: "location", ID: uuid.New()}}}, false},
		{"restricted empty", PolicyInput{Mode: ModeRestricted}, true},
		{"restricted grants", PolicyInput{Mode: ModeRestricted, Grants: []Grant{{Type: "group", ID: uuid.New()}}}, true},
		{"unknown grant", PolicyInput{Mode: ModeRestricted, Grants: []Grant{{Type: "building", ID: uuid.New()}}}, false},
		{"nil grant", PolicyInput{Mode: ModeRestricted, Grants: []Grant{{Type: "group"}}}, false},
		{"missing mode", PolicyInput{}, false},
	} {
		if err := test.input.Validate(); (err == nil) != test.ok {
			t.Errorf("%s: err=%v, want ok=%v", test.name, err, test.ok)
		}
	}
}
