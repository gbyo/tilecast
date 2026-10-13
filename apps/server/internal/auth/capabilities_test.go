package auth

import (
	"strings"
	"testing"
)

// TestBuiltinCapabilityMatrix pins what each built-in role may do. Changing a
// line here changes the authority of every existing account on that role, so
// it must be a deliberate decision recorded in the change that makes it.
func TestBuiltinCapabilityMatrix(t *testing.T) {
	want := map[string]string{
		RoleViewer: "activity.read campaign.read datasource.read layout.read media.read playlist.read plugins.use schedule.read screen.read widget.read",
		RoleContributor: "activity.read campaign.read datasource.edit datasource.read layout.edit layout.read media.collections.manage media.edit " +
			"media.folders.manage media.organize media.read media.tags.assign media.tags.manage media.upload playlist.edit playlist.read " +
			"plugins.use schedule.read screen.read widget.edit widget.read",
		RoleEditor: "activity.audit activity.read campaign.edit campaign.read content.review datasource.edit datasource.manage datasource.read " +
			"layout.delete layout.edit layout.publish layout.read media.archive media.collections.manage media.delete media.edit " +
			"media.folders.manage media.organize media.read media.tags.assign media.tags.manage media.upload playlist.delete playlist.edit " +
			"playlist.publish playlist.read plugins.use schedule.read screen.read widget.delete widget.edit widget.read",
	}
	for role, expected := range want {
		set, ok := BuiltinCapabilities(role)
		if !ok {
			t.Fatalf("%s is not built in", role)
		}
		if got := strings.Join(set.Strings(), " "); got != expected {
			t.Errorf("%s capabilities changed:\n got  %s\n want %s", role, got, expected)
		}
	}
	owner, _ := BuiltinCapabilities(RoleOwner)
	administrator, _ := BuiltinCapabilities(RoleAdministrator)
	if len(owner) != len(capabilityCatalog) {
		t.Errorf("owner holds %d of %d capabilities", len(owner), len(capabilityCatalog))
	}
	for _, definition := range capabilityCatalog {
		if administrator.Has(definition.Key) == definition.OwnerReserved {
			t.Errorf("administrator and %s: reserved=%v", definition.Key, definition.OwnerReserved)
		}
	}
	for _, reservedKey := range []Capability{CapSystemBackups, CapIntegrationsManage, CapPlayerReleases} {
		if administrator.Has(reservedKey) {
			t.Errorf("administrator holds Owner-reserved %s", reservedKey)
		}
	}
}

// TestVocabularyIsClosedAndConsistent checks that requirements name real
// capabilities, that built-in bundles satisfy their own requirements, and
// that a stored string outside the vocabulary never becomes authority.
func TestVocabularyIsClosedAndConsistent(t *testing.T) {
	for _, definition := range capabilityCatalog {
		for _, requirement := range definition.Requires {
			if _, ok := capabilityIndex[requirement]; !ok {
				t.Errorf("%s requires unknown %s", definition.Key, requirement)
			}
		}
	}
	for _, role := range BuiltinRoleKeys {
		set, _ := BuiltinCapabilities(role)
		if missing := set.MissingRequirements(); len(missing) > 0 {
			t.Errorf("%s misses %v", role, missing)
		}
	}
	set := NewCapabilitySet("media.read", "everything", "users.manage ", Capability(""))
	if got := strings.Join(set.Strings(), ","); got != "media.read" {
		t.Errorf("unknown strings were kept: %s", got)
	}
}

func TestDelegation(t *testing.T) {
	owner, _ := BuiltinCapabilities(RoleOwner)
	administrator, _ := BuiltinCapabilities(RoleAdministrator)
	ownerDelegator := Delegator{Role: RoleOwner, Capabilities: owner}
	adminDelegator := Delegator{Role: RoleAdministrator, Capabilities: administrator}
	classroom := NewCapabilitySet(CapMediaRead, CapMediaUpload, CapMediaTagsAssign)
	peopleDesk := NewCapabilitySet(CapUsersManage, CapMediaRead)

	if !adminDelegator.CanDelegate(classroom) || !ownerDelegator.CanDelegate(classroom) {
		t.Error("a Media-only role should be delegable by Owner and Administrator")
	}
	if adminDelegator.CanDelegate(peopleDesk) || adminDelegator.CanDelegate(NewCapabilitySet(CapRolesManage)) {
		t.Error("an Administrator must not delegate access administration")
	}
	if !ownerDelegator.CanDelegate(peopleDesk) {
		t.Error("the Owner delegates access administration")
	}
	if adminDelegator.CanAssignRole(RoleAdministrator, administrator) || adminDelegator.CanAssignRole(RoleOwner, owner) {
		t.Error("an Administrator must not assign Owner or Administrator")
	}
	limited := Delegator{Role: "custom.desk", Capabilities: NewCapabilitySet(CapUsersManage, CapMediaRead, CapMediaUpload)}
	if limited.CanDelegate(NewCapabilitySet(CapMediaRead, CapMediaDelete)) {
		t.Error("a custom manager delegated a capability it does not hold")
	}
	if !limited.CanDelegate(NewCapabilitySet(CapMediaRead, CapMediaUpload)) {
		t.Error("a custom manager should delegate a subset of its own authority")
	}
	if limited.CanAssignRole("custom.desk", limited.Capabilities) {
		t.Error("a manager role must not be assignable by its own holders")
	}
}

func TestRoleInputValidation(t *testing.T) {
	cases := []struct {
		name  string
		input RoleInput
		ok    bool
	}{
		{"valid", RoleInput{Name: "Classroom Media", Capabilities: []string{"media.read", "media.upload"}}, true},
		{"reserved", RoleInput{Name: "Backups", Capabilities: []string{"system.backups"}}, false},
		{"unknown", RoleInput{Name: "Made up", Capabilities: []string{"media.everything"}}, false},
		{"missing requirement", RoleInput{Name: "Upload only", Capabilities: []string{"media.upload"}}, false},
		{"built-in name", RoleInput{Name: "viewer", Capabilities: []string{"media.read"}}, false},
		{"short name", RoleInput{Name: "x", Capabilities: []string{"media.read"}}, false},
	}
	for _, test := range cases {
		_, _, err := normalizeRoleInput(test.input)
		if (err == nil) != test.ok {
			t.Errorf("%s: err=%v, want ok=%v", test.name, err, test.ok)
		}
	}
}
