package httpapi

import (
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

func TestValidateManagedUser(t *testing.T) {
	t.Parallel()
	valid := managedUserInput{
		Name: "Jamie Rivera", Username: "jamie.rivera", Password: "correct horse battery", Role: "editor",
	}
	if err := validateManagedUser(valid, true); err != nil {
		t.Fatalf("valid user rejected: %v", err)
	}
	cases := []struct {
		name  string
		input managedUserInput
	}{
		{"short name", managedUserInput{Name: "J", Username: "jamie", Password: "correct horse battery", Role: "editor"}},
		{"invalid username", managedUserInput{Name: "Jamie", Username: "not valid", Password: "correct horse battery", Role: "editor"}},
		{"short password", managedUserInput{Name: "Jamie", Username: "jamie", Password: "short", Role: "editor"}},
		{"missing role", managedUserInput{Name: "Jamie", Username: "jamie", Password: "correct horse battery", Role: ""}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := validateManagedUser(test.input, true); err == nil {
				t.Fatal("invalid user was accepted")
			}
		})
	}
}

// TestBuiltinRoleHierarchyIsPreserved pins that delegation over built-in
// roles reproduces the hierarchy every installation had before custom roles:
// the Owner manages anyone, an Administrator manages Editor, Contributor, and
// Viewer accounts, and nobody else manages accounts at all.
func TestBuiltinRoleHierarchyIsPreserved(t *testing.T) {
	t.Parallel()
	cases := []struct {
		actor, target string
		want          bool
	}{
		{"owner", "owner", true},
		{"owner", "administrator", true},
		{"administrator", "editor", true},
		{"administrator", "contributor", true},
		{"administrator", "viewer", true},
		{"administrator", "administrator", false},
		{"administrator", "owner", false},
		{"editor", "viewer", false},
		{"viewer", "viewer", false},
	}
	for _, test := range cases {
		actor, _ := auth.BuiltinCapabilities(test.actor)
		target, _ := auth.BuiltinCapabilities(test.target)
		principal := auth.Principal{User: auth.User{Role: test.actor}, Capabilities: actor}
		got := principal.Can(auth.CapUsersManage) && principal.Delegator().CanAssignRole(test.target, target)
		if got != test.want {
			t.Errorf("%s managing %s = %v, want %v", test.actor, test.target, got, test.want)
		}
	}
}
