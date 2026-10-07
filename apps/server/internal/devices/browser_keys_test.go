package devices

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func browserTestKey(t *testing.T) (*ecdsa.PrivateKey, BrowserPublicKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encode := func(value *big.Int) string {
		return base64.RawURLEncoding.EncodeToString(value.FillBytes(make([]byte, 32)))
	}
	return key, BrowserPublicKey{KeyType: "EC", Curve: "P-256", X: encode(key.X), Y: encode(key.Y), Ext: true, KeyOps: []string{"verify"}}
}

func browserTestSignature(t *testing.T, key *ecdsa.PrivateKey, message string) string {
	t.Helper()
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	bytes := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	return base64.RawURLEncoding.EncodeToString(bytes)
}

func TestBrowserWebCryptoSignature(t *testing.T) {
	private, public := browserTestKey(t)
	signature := browserTestSignature(t, private, "challenge")
	if !verifyBrowserSignature(public, "challenge", signature) {
		t.Fatal("P1363 signature rejected")
	}
	if verifyBrowserSignature(public, "other challenge", signature) || verifyBrowserSignature(public, "challenge", "invalid") {
		t.Fatal("invalid signature accepted")
	}
	_, other := browserTestKey(t)
	if verifyBrowserSignature(other, "challenge", signature) {
		t.Fatal("signature from another installation accepted")
	}
	public.Curve = "P-384"
	if _, err := public.parse(); err == nil {
		t.Fatal("unsupported curve accepted")
	}
}

func TestBrowserPublicKeyRejectsMalformedCoordinates(t *testing.T) {
	_, public := browserTestKey(t)
	public.X = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	public.Y = public.X
	if _, err := public.parse(); err == nil {
		t.Fatal("point outside curve accepted")
	}
	public.X = "invalid"
	if _, err := public.parse(); err == nil {
		t.Fatal("invalid coordinate accepted")
	}
}

func TestBrowserSessionSecretCannotEnterJSON(t *testing.T) {
	secret, err := randomSecret(32)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(BrowserSession{SessionSecret: secret})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), "SessionSecret") {
		t.Fatal("session secret entered JSON")
	}
	for _, value := range []any{BrowserSession{SessionSecret: secret}, BrowserLaunch{RecoverySecret: secret}} {
		if strings.Contains(fmt.Sprintf("%v %#v", value, value), secret) {
			t.Fatal("browser secret entered formatted output")
		}
	}
}

// browserGolden is a signature produced by WebCrypto exactly as the Browser
// Host signs (apps/player-web/scripts/generate-webcrypto-golden.mjs).
type browserGolden struct {
	PublicKey          BrowserPublicKey `json:"publicKey"`
	SlotID             uuid.UUID        `json:"slotId"`
	BindingID          uuid.UUID        `json:"bindingId"`
	Nonce              string           `json:"nonce"`
	Message            string           `json:"message"`
	Signature          string           `json:"signature"`
	NonceOnlySignature string           `json:"nonceOnlySignature"`
}

func loadBrowserGolden(t *testing.T) browserGolden {
	t.Helper()
	raw, err := os.ReadFile("testdata/browser_webcrypto_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden browserGolden
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	return golden
}

func TestBrowserWebCryptoGoldenSignatureIsAcceptedForTheServerMessage(t *testing.T) {
	golden := loadBrowserGolden(t)
	// The server rebuilds the message itself; it never trusts signing text
	// the client supplies.
	if want := browserChallengeMessage(golden.SlotID, golden.BindingID, golden.Nonce); golden.Message != want {
		t.Fatalf("browser and server disagree on the challenge message:\nbrowser %q\nserver  %q", golden.Message, want)
	}
	if !verifyBrowserSignature(golden.PublicKey, browserChallengeMessage(golden.SlotID, golden.BindingID, golden.Nonce), golden.Signature) {
		t.Fatal("a Chromium-compatible WebCrypto P-256 signature over the exact challenge message was rejected")
	}
	if verifyBrowserSignature(golden.PublicKey, golden.Nonce, golden.Signature) {
		t.Fatal("a signature over the whole message verified as a nonce")
	}
}

func TestBrowserSignatureBindsNonceSlotAndBinding(t *testing.T) {
	golden := loadBrowserGolden(t)
	message := browserChallengeMessage(golden.SlotID, golden.BindingID, golden.Nonce)
	if verifyBrowserSignature(golden.PublicKey, message, golden.NonceOnlySignature) {
		t.Fatal("the previous nonce-only signature was accepted")
	}
	for name, other := range map[string]string{
		"slot":    browserChallengeMessage(uuid.New(), golden.BindingID, golden.Nonce),
		"binding": browserChallengeMessage(golden.SlotID, uuid.New(), golden.Nonce),
		"nonce":   browserChallengeMessage(golden.SlotID, golden.BindingID, strings.Repeat("A", 43)),
	} {
		if verifyBrowserSignature(golden.PublicKey, other, golden.Signature) {
			t.Fatalf("a signature for another %s was accepted", name)
		}
	}
}
