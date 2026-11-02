package auth

import (
	"testing"
)

// TestPrincipalFromSessionDerivesManagementIdentity pins the Phase 4
// translation: the principal carries the user, the session credential kind,
// the auth method, and the enrollment flag, and nothing credential-specific.
func TestPrincipalFromSessionDerivesManagementIdentity(t *testing.T) {
	session := Session{
		User:              User{Role: "administrator"},
		Token:             "opaque-token",
		CSRFToken:         "csrf-token",
		AuthMethod:        "password+totp",
		EnrollmentPending: true,
	}
	principal := PrincipalFromSession(session)
	if principal.User != session.User {
		t.Fatalf("principal user = %+v, want %+v", principal.User, session.User)
	}
	if principal.CredentialKind != CredentialKindSession {
		t.Fatalf("credential kind = %q, want session", principal.CredentialKind)
	}
	if principal.AuthMethod != "password+totp" {
		t.Fatalf("auth method = %q, want password+totp", principal.AuthMethod)
	}
	if !principal.EnrollmentPending {
		t.Fatal("enrollment flag was lost")
	}
	if principal.GrantID != nil || principal.ClientID != "" || principal.ClientInstance != "" {
		t.Fatalf("session principal carries grant fields: %+v", principal)
	}
	if principal.IsOwner() {
		t.Fatal("an administrator is not the Owner")
	}
	// The session alone carries no authority: the request boundary resolves
	// capabilities from the live role.
	if principal.Can(CapUsersManage) {
		t.Fatal("an unresolved principal must hold no capabilities")
	}
	principal.Capabilities, _ = BuiltinCapabilities(principal.User.Role)
	if !principal.Can(CapUsersManage) || principal.Can(CapSystemBackups) {
		t.Fatal("administrator capabilities are wrong")
	}
}
