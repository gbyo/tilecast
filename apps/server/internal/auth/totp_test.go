package auth

import (
	"encoding/base32"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The RFC 6238 appendix B vectors, restricted to the SHA-1 eight-digit set and
// truncated to the six digits Tilecast uses.
func TestTOTPMatchesRFC6238Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	cases := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
	}
	for _, testCase := range cases {
		step := testCase.unix / 30
		if got := totpCode(secret, step); got != testCase.want {
			t.Fatalf("code at %d: got %s want %s", testCase.unix, got, testCase.want)
		}
	}
}

func TestVerifyTOTPAcceptsAdjacentSteps(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111109, 0)
	for _, offset := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		code := totpCode(secret, now.Add(offset).Unix()/30)
		if _, ok := verifyTOTP(secret, code, now, nil); !ok {
			t.Fatalf("expected the code at offset %s to verify", offset)
		}
	}
	stale := totpCode(secret, now.Add(-120*time.Second).Unix()/30)
	if _, ok := verifyTOTP(secret, stale, now, nil); ok {
		t.Fatal("expected a code outside the window to fail")
	}
}

// A code stays displayed for thirty seconds, so without a replay guard an
// observed code could be reused within its own window.
func TestVerifyTOTPRejectsReplay(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111109, 0)
	code := totpCode(secret, now.Unix()/30)
	step, ok := verifyTOTP(secret, code, now, nil)
	if !ok {
		t.Fatal("expected the first use to verify")
	}
	if _, ok := verifyTOTP(secret, code, now, &step); ok {
		t.Fatal("expected the second use of the same code to fail")
	}
}

func TestVerifyTOTPIgnoresFormatting(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111109, 0)
	code := totpCode(secret, now.Unix()/30)
	spaced := code[:3] + " " + code[3:]
	if _, ok := verifyTOTP(secret, spaced, now, nil); !ok {
		t.Fatal("expected a space-separated code to verify")
	}
	if _, ok := verifyTOTP(secret, "12345", now, nil); ok {
		t.Fatal("expected a short code to fail")
	}
}

func TestProvisioningURIIsScannable(t *testing.T) {
	secret, err := newTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	uri := TOTPProvisioningURI(secret, "Greenwood Library", "owner@example.org")
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatalf("parse provisioning uri: %v", err)
	}
	if parsed.Scheme != "otpauth" || parsed.Host != "totp" {
		t.Fatalf("unexpected provisioning uri: %s", uri)
	}
	if parsed.Query().Get("issuer") != "Greenwood Library" {
		t.Fatalf("missing issuer: %s", uri)
	}
	key := parsed.Query().Get("secret")
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(key)
	if err != nil {
		t.Fatalf("secret is not base32: %v", err)
	}
	if len(decoded) != totpSecretLen {
		t.Fatalf("expected a %d byte secret, got %d", totpSecretLen, len(decoded))
	}
	if !strings.Contains(parsed.Path, "owner@example.org") {
		t.Fatalf("label omits the account: %s", parsed.Path)
	}
}

func TestRecoveryCodesAreGroupedAndNormalized(t *testing.T) {
	code, err := newRecoveryCode()
	if err != nil {
		t.Fatal(err)
	}
	groups := strings.Split(code, "-")
	if len(groups) != recoveryGroups {
		t.Fatalf("expected %d groups, got %q", recoveryGroups, code)
	}
	for _, group := range groups {
		if len(group) != recoveryGroupLen {
			t.Fatalf("unexpected group length in %q", code)
		}
		for _, r := range group {
			if !strings.ContainsRune(recoveryAlphabet, r) {
				t.Fatalf("character %q is outside the recovery alphabet", r)
			}
		}
	}
	// Codes get written down, so a user retyping one with different casing or
	// spacing must still match.
	if normalizeRecoveryCode(strings.ToUpper(code)) != normalizeRecoveryCode(code) {
		t.Fatal("expected normalization to fold case")
	}
	if normalizeRecoveryCode(" "+code+" ") != normalizeRecoveryCode(code) {
		t.Fatal("expected normalization to drop separators")
	}
	// Recovery codes are hashed with the password hasher, which has a minimum
	// length; a shorter format would silently fail to enroll.
	if len(normalizeRecoveryCode(code)) < 12 {
		t.Fatalf("recovery code %q is too short to hash", code)
	}
}

func TestMFAPolicyScope(t *testing.T) {
	if ParseMFAPolicy("nonsense") != MFAPolicyNone {
		t.Fatal("an unknown policy value must not require enrollment")
	}
	if !ParseMFAPolicy("administrators").AppliesTo("owner") || !ParseMFAPolicy("administrators").AppliesTo("administrator") {
		t.Fatal("the administrators scope must cover owners and administrators")
	}
	if ParseMFAPolicy("administrators").AppliesTo("editor") {
		t.Fatal("the administrators scope must not cover editors")
	}
	if !ParseMFAPolicy("all").AppliesTo("viewer") {
		t.Fatal("the all scope must cover every role")
	}
}

func TestResolveWebAuthnConfig(t *testing.T) {
	config, reason := ResolveWebAuthnConfig("Tilecast", "https://signage.example.org", "", "")
	if reason != "" || config.RPID != "signage.example.org" || len(config.Origins) != 1 || config.Origins[0] != "https://signage.example.org" {
		t.Fatalf("unexpected https configuration: %#v reason=%q", config, reason)
	}
	// A plain-HTTP LAN installation is the common Tilecast deployment and must
	// report why passkeys are unavailable rather than half-configuring them.
	if _, reason := ResolveWebAuthnConfig("Tilecast", "http://192.168.1.40:8080", "", ""); reason == "" {
		t.Fatal("expected plain HTTP to disable passkeys")
	}
	if _, reason := ResolveWebAuthnConfig("Tilecast", "https://192.168.1.40:8443", "", ""); reason == "" {
		t.Fatal("expected an IP address to disable passkeys")
	}
	if _, reason := ResolveWebAuthnConfig("Tilecast", "http://127.0.0.1:8080", "", ""); reason == "" {
		t.Fatal("expected a loopback IP address to disable passkeys")
	}
	if _, reason := ResolveWebAuthnConfig("Tilecast", "http://localhost:8080", "", ""); reason != "" {
		t.Fatalf("expected localhost to remain usable for development: %s", reason)
	}
	override, reason := ResolveWebAuthnConfig("Tilecast", "http://tilecast:8080", "signage.example.org", "https://signage.example.org, https://alt.example.org")
	if reason != "" || override.RPID != "signage.example.org" || len(override.Origins) != 2 {
		t.Fatalf("expected the override to be used verbatim: %#v reason=%q", override, reason)
	}
}
