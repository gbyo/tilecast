package trust

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
)

func testEnvelope(t *testing.T, payload json.RawMessage, keyID string, private ed25519.PrivateKey) []byte {
	t.Helper()
	signature := ed25519.Sign(private, payload)
	data, err := json.Marshal(Envelope{
		Payload:    payload,
		Signatures: []Signature{{KeyID: keyID, Signature: base64.StdEncoding.EncodeToString(signature)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestVerifyEnvelope(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewEd25519Verifier("tilecast-marketplace-2026", public)
	if err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"formatVersion":1,"listings":[]}`)

	returned, err := VerifyEnvelope(testEnvelope(t, payload, verifier.KeyID(), private), verifier)
	if err != nil {
		t.Fatal(err)
	}
	if string(returned) != string(payload) {
		t.Fatalf("payload = %s", returned)
	}
}

func TestVerifyEnvelopeTriesAllMatchingSignatures(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewEd25519Verifier("tilecast-marketplace-2026", public)
	if err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"formatVersion":1,"listings":[]}`)
	valid := ed25519.Sign(private, payload)
	data, err := json.Marshal(Envelope{
		Payload: payload,
		Signatures: []Signature{
			{KeyID: verifier.KeyID(), Signature: base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))},
			{KeyID: verifier.KeyID(), Signature: base64.StdEncoding.EncodeToString(valid)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyEnvelope(data, verifier); err != nil {
		t.Fatalf("second valid signature was not accepted: %v", err)
	}
}

func TestVerifyEnvelopeFailsClosed(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	otherPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewEd25519Verifier("tilecast-marketplace-2026", public)
	if err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"formatVersion":1}`)

	t.Run("tampered payload", func(t *testing.T) {
		data := testEnvelope(t, payload, verifier.KeyID(), private)
		tampered := json.RawMessage(`{"formatVersion":2}`)
		var envelope Envelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			t.Fatal(err)
		}
		envelope.Payload = tampered
		repacked, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyEnvelope(repacked, verifier); err == nil {
			t.Fatal("expected a verification failure")
		}
	})
	t.Run("wrong key", func(t *testing.T) {
		wrong, err := NewEd25519Verifier("tilecast-marketplace-2026", otherPublic)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyEnvelope(testEnvelope(t, payload, verifier.KeyID(), private), wrong); err == nil {
			t.Fatal("expected a verification failure")
		}
	})
	t.Run("unknown key id", func(t *testing.T) {
		if _, err := VerifyEnvelope(testEnvelope(t, payload, "someone-else", private), verifier); !errors.Is(err, ErrUnknownKey) {
			t.Fatalf("err = %v, want ErrUnknownKey", err)
		}
	})
	t.Run("no signatures", func(t *testing.T) {
		data, err := json.Marshal(Envelope{Payload: payload})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyEnvelope(data, verifier); !errors.Is(err, ErrNoSignature) {
			t.Fatalf("err = %v, want ErrNoSignature", err)
		}
	})
	t.Run("unknown fields rejected", func(t *testing.T) {
		data := testEnvelope(t, payload, verifier.KeyID(), private)
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		raw["capabilities"] = []string{"everything"}
		repacked, err := json.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyEnvelope(repacked, verifier); err == nil {
			t.Fatal("expected an unknown-field rejection")
		}
	})
	t.Run("malformed base64", func(t *testing.T) {
		data, err := json.Marshal(Envelope{
			Payload:    payload,
			Signatures: []Signature{{KeyID: verifier.KeyID(), Signature: "!!!"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyEnvelope(data, verifier); err == nil {
			t.Fatal("expected a base64 failure")
		}
	})
}

func TestParsePublicKey(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParsePublicKey(base64.StdEncoding.EncodeToString(public))
	if err != nil {
		t.Fatal(err)
	}
	if !parsed.Equal(public) {
		t.Fatal("round trip mismatch")
	}
	if _, err := ParsePublicKey("!!!"); err == nil {
		t.Fatal("expected a base64 failure")
	}
	if _, err := ParsePublicKey("abcd"); err == nil {
		t.Fatal("expected a length failure")
	}
}
