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
	"strings"
	"testing"
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
