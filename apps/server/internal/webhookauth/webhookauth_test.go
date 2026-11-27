package webhookauth

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// The vectors below were computed with an independent HMAC implementation
// (Python's hmac module), not with this package. The Standard Webhooks
// vector is the one the specification's reference libraries publish.

func code(err error) string {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Code
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

func headers(pairs ...string) http.Header {
	h := http.Header{}
	for i := 0; i < len(pairs); i += 2 {
		h.Add(pairs[i], pairs[i+1])
	}
	return h
}

const (
	standardSecret    = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
	standardID        = "msg_p5jXN8AQM9LWM0D4loKWxJek"
	standardTimestamp = "1614265330"
	standardSignature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
)

var standardBody = []byte(`{"test": 2432232314}`)

func standardAt(offset time.Duration) time.Time { return time.Unix(1614265330, 0).Add(offset) }

func TestStandardWebhooksVector(t *testing.T) {
	h := headers("webhook-id", standardID, "webhook-timestamp", standardTimestamp, "webhook-signature", standardSignature)
	id, err := Standard(standardSecret, h, standardBody, standardAt(0))
	if err != nil || id != standardID {
		t.Fatalf("id %q err %v", id, err)
	}
}

func TestStandardWebhooksDecodesTheKeyMaterial(t *testing.T) {
	key, err := StandardKey(standardSecret)
	if err != nil || len(key) != 24 {
		t.Fatalf("key %d bytes, %v", len(key), err)
	}
	// The literal ASCII text of the secret is not the key: a signature
	// made with it fails.
	literal := mac([]byte(standardSecret), []byte(standardID+"."+standardTimestamp+"."), standardBody)
	h := headers("webhook-id", standardID, "webhook-timestamp", standardTimestamp,
		"webhook-signature", "v1,"+b64(literal))
	if _, err := Standard(standardSecret, h, standardBody, standardAt(0)); code(err) != CodeSignatureInvalid {
		t.Fatalf("literal key accepted: %v", err)
	}
	if _, err := StandardKey("whsec_not base64!"); !errors.Is(err, ErrSecretUnusable) {
		t.Fatalf("bad secret: %v", err)
	}
}

func TestStandardWebhooksRotationAndVersions(t *testing.T) {
	for name, value := range map[string]string{
		"rotated":        "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= " + standardSignature,
		"asymmetric too": "v1a,ZmFrZQ== " + standardSignature,
	} {
		h := headers("webhook-id", standardID, "webhook-timestamp", standardTimestamp, "webhook-signature", value)
		if _, err := Standard(standardSecret, h, standardBody, standardAt(0)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// A v1a entry alone is never accepted: asymmetric signatures are not
	// verified in this release.
	h := headers("webhook-id", standardID, "webhook-timestamp", standardTimestamp, "webhook-signature", "v1a,"+standardSignature[3:])
	if _, err := Standard(standardSecret, h, standardBody, standardAt(0)); code(err) != CodeSignatureMissing {
		t.Fatalf("v1a accepted: %v", err)
	}
}

func TestStandardWebhooksRefusals(t *testing.T) {
	good := func() http.Header {
		return headers("webhook-id", standardID, "webhook-timestamp", standardTimestamp, "webhook-signature", standardSignature)
	}
	cases := map[string]struct {
		header http.Header
		body   []byte
		at     time.Time
		want   string
	}{
		"bad signature":    {headers("webhook-id", standardID, "webhook-timestamp", standardTimestamp, "webhook-signature", "v1,AAAA"), standardBody, standardAt(0), CodeSignatureInvalid},
		"changed body":     {good(), []byte(`{"test": 2432232315}`), standardAt(0), CodeSignatureInvalid},
		"trailing space":   {good(), append(append([]byte{}, standardBody...), ' '), standardAt(0), CodeSignatureInvalid},
		"old timestamp":    {good(), standardBody, standardAt(5*time.Minute + time.Second), CodeTimestampOutOfSpan},
		"future timestamp": {good(), standardBody, standardAt(-5*time.Minute - time.Second), CodeTimestampOutOfSpan},
		"no id":            {headers("webhook-timestamp", standardTimestamp, "webhook-signature", standardSignature), standardBody, standardAt(0), CodeDeliveryIDMissing},
		"no signature":     {headers("webhook-id", standardID, "webhook-timestamp", standardTimestamp), standardBody, standardAt(0), CodeSignatureMissing},
	}
	for name, c := range cases {
		if _, err := Standard(standardSecret, c.header, c.body, c.at); code(err) != c.want {
			t.Fatalf("%s: got %v want %s", name, err, c.want)
		}
	}
	// The edge of the window is accepted.
	if _, err := Standard(standardSecret, good(), standardBody, standardAt(5*time.Minute)); err != nil {
		t.Fatalf("edge: %v", err)
	}
}

// Square-style: base64 HMAC-SHA256 of the exact notification URL followed
// by the exact raw body, in x-square-hmacsha256-signature.
func TestSquareStyleURLBody(t *testing.T) {
	declaration := plugin.WebhookSignature{Scheme: plugin.SignatureHMACSHA256, Header: "x-square-hmacsha256-signature",
		Format: plugin.SignatureFormatPlain, Encoding: plugin.SignatureEncodingBase64, SignedPayload: plugin.SignedURLBody}
	endpoint := "https://tilecast.example/api/v1/hooks/payments_test/payments"
	body := []byte(`{"merchant_id":"ML1","type":"payment.updated","event_id":"0b6ce3c6-7b7e-4b1e-9b7a-6a1c1e2f9a10","data":{"id":"pay_1"}}`)
	h := headers("x-square-hmacsha256-signature", "BXzkB/eJT0rK8LaHoqD5ll4pnhAYJX1RoTSYYCqTYg8=")
	if err := HMAC(declaration, "sq-signature-key-7f3a", h, endpoint, body, time.Now()); err != nil {
		t.Fatal(err)
	}
	// Another address, such as one a proxy header would suggest, fails.
	if err := HMAC(declaration, "sq-signature-key-7f3a", h, "https://internal:8080/api/v1/hooks/payments_test/payments", body, time.Now()); code(err) != CodeSignatureInvalid {
		t.Fatalf("other URL accepted: %v", err)
	}
}

// Planning Center-style: hex HMAC-SHA256 of the raw body in
// X-PCO-Webhooks-Authenticity, keyed by the secret text. The secret looks
// like hex and is still used as text.
func TestPlanningCenterStyleBody(t *testing.T) {
	declaration := plugin.WebhookSignature{Scheme: plugin.SignatureHMACSHA256, Header: "X-PCO-Webhooks-Authenticity",
		Format: plugin.SignatureFormatPlain, Encoding: plugin.SignatureEncodingHex, SignedPayload: plugin.SignedBody}
	body := []byte(`{"data":[{"id":"5a1f9c3e-2b44-4f61-8d1f-7a0c9a2b3c4d","type":"EventDelivery","attributes":{"name":"services.v2.events.plan_time.updated","attempt":1,"payload":"{}"}}]}`)
	secret := "a3f9c1d2e4b5a6978877665544332211a3f9c1d2e4b5a6978877665544332211"
	h := headers("X-PCO-Webhooks-Authenticity", "272272f744163a3cf15d5370860e094cd8e1e88af6c7fcc2b0654b0d2371926b")
	if err := HMAC(declaration, secret, h, "", body, time.Now()); err != nil {
		t.Fatal(err)
	}
	uppercase := headers("X-PCO-Webhooks-Authenticity", "272272F744163A3CF15D5370860E094CD8E1E88AF6C7FCC2B0654B0D2371926B")
	if err := HMAC(declaration, secret, uppercase, "", body, time.Now()); err != nil {
		t.Fatalf("uppercase hex: %v", err)
	}
	// The signature made with the hex-decoded secret is not accepted.
	decoded := headers("X-PCO-Webhooks-Authenticity", "d96d8650a2663d12b8730a456828b4f739ca520579a4cf6a1a13d28bee6d4359")
	if err := HMAC(declaration, secret, decoded, "", body, time.Now()); code(err) != CodeSignatureInvalid {
		t.Fatalf("hex-decoded key accepted: %v", err)
	}
}

func TestPairsTimestampBodyWithRotation(t *testing.T) {
	declaration := plugin.WebhookSignature{Scheme: plugin.SignatureHMACSHA256, Header: "Example-Signature",
		Format: plugin.SignatureFormatPairs, TimestampKey: "t", SignatureKey: "v1",
		Encoding: plugin.SignatureEncodingHex, SignedPayload: plugin.SignedTimestampBody}
	body := []byte(`{"data":[{"id":"5a1f9c3e-2b44-4f61-8d1f-7a0c9a2b3c4d","type":"EventDelivery","attributes":{"name":"services.v2.events.plan_time.updated","attempt":1,"payload":"{}"}}]}`)
	now := time.Unix(1700000000, 0)
	value := "t=1700000000,v1=00ff,v1=20b2785b3a93449be77f431af01c56b0d0637668f83dec1ac1172c1d4ab40635,v0=abc"
	if err := HMAC(declaration, "whsec_stripe_like_text", headers("Example-Signature", value), "", body, now); err != nil {
		t.Fatal(err)
	}
	if err := HMAC(declaration, "whsec_stripe_like_text", headers("Example-Signature", value), "", body, now.Add(6*time.Minute)); code(err) != CodeTimestampOutOfSpan {
		t.Fatalf("old: %v", err)
	}
	twoTimestamps := "t=1700000000,t=1700000001," + value[13:]
	if err := HMAC(declaration, "whsec_stripe_like_text", headers("Example-Signature", twoTimestamps), "", body, now); code(err) != CodeTimestampMissing {
		t.Fatalf("two timestamps: %v", err)
	}
}

func TestPlainPrefixTimestampHeader(t *testing.T) {
	declaration := plugin.WebhookSignature{Scheme: plugin.SignatureHMACSHA256, Header: "X-Hub-Signature-256",
		Format: plugin.SignatureFormatPlain, TimestampHeader: "X-Timestamp", Prefix: "sha256=",
		Encoding: plugin.SignatureEncodingBase64, SignedPayload: plugin.SignedTimestampBody}
	body := []byte(`{"ok":true}`)
	now := time.Unix(1700000000, 0)
	signature := b64(mac([]byte("plain secret"), []byte("1700000000."), body))
	good := headers("X-Hub-Signature-256", "sha256="+signature, "X-Timestamp", "1700000000")
	if err := HMAC(declaration, "plain secret", good, "", body, now); err != nil {
		t.Fatal(err)
	}
	unprefixed := headers("X-Hub-Signature-256", signature, "X-Timestamp", "1700000000")
	if err := HMAC(declaration, "plain secret", unprefixed, "", body, now); code(err) != CodeSignatureMissing {
		t.Fatalf("unprefixed: %v", err)
	}
	noTimestamp := headers("X-Hub-Signature-256", "sha256="+signature)
	if err := HMAC(declaration, "plain secret", noTimestamp, "", body, now); code(err) != CodeTimestampMissing {
		t.Fatalf("no timestamp: %v", err)
	}
	if err := HMAC(declaration, "", good, "", body, now); !errors.Is(err, ErrSecretUnusable) {
		t.Fatalf("empty secret: %v", err)
	}
}

func TestCandidatesAreBounded(t *testing.T) {
	declaration := plugin.WebhookSignature{Scheme: plugin.SignatureHMACSHA256, Header: "Sig",
		Format: plugin.SignatureFormatPlain, Encoding: plugin.SignatureEncodingHex, SignedPayload: plugin.SignedBody}
	body := []byte("x")
	right := hexOf(mac([]byte("k"), body))
	value := ""
	for i := 0; i < plugin.MaxWebhookSignatures; i++ {
		value += "00,"
	}
	// The right signature after the bound is not tried.
	if err := HMAC(declaration, "k", headers("Sig", value+right), "", body, time.Now()); code(err) != CodeSignatureInvalid {
		t.Fatalf("candidate past the bound accepted: %v", err)
	}
}

func TestPointer(t *testing.T) {
	doc := []byte(`{"data":[{"id":"abc","n":42,"f":1.5,"o":{}}],"a/b":{"m~n":"x"}}`)
	for pointer, want := range map[string]string{"/data/0/id": "abc", "/data/0/n": "42", "/a~1b/m~0n": "x"} {
		if got, ok := Pointer(doc, pointer); !ok || got != want {
			t.Fatalf("%s: %q %v", pointer, got, ok)
		}
	}
	for _, pointer := range []string{"/data/1/id", "/data/0/f", "/data/0/o", "/data/00/id", "/missing", "data"} {
		if _, ok := Pointer(doc, pointer); ok {
			t.Fatalf("%s resolved", pointer)
		}
	}
	if _, ok := Pointer([]byte(`not json`), "/id"); ok {
		t.Fatal("invalid document resolved")
	}
}

func TestValidDeliveryID(t *testing.T) {
	long := make([]byte, plugin.MaxWebhookDeliveryIDBytes+1)
	for i := range long {
		long[i] = 'a'
	}
	for id, want := range map[string]bool{"msg_1": true, "": false, "a b": false, "é": false, string(long): false, string(long[1:]): true} {
		if ValidDeliveryID(id) != want {
			t.Fatalf("%q", id)
		}
	}
}

func b64(data []byte) string   { return base64.StdEncoding.EncodeToString(data) }
func hexOf(data []byte) string { return hex.EncodeToString(data) }
