// Package trust verifies signed marketplace documents before the server
// acts on them.
//
// A signed document is an envelope carrying the exact payload bytes plus
// detached signatures. Verification covers those bytes; no canonical form
// is needed because the signer and the verifier hash the same document.
// Unknown envelope fields are rejected, so a signature cannot smuggle in
// semantics the reader does not understand.
//
// Version 1 signs with Ed25519 under a Tilecast marketplace key the
// operator pins in configuration. Sigstore bundles may join later behind
// the Verifier interface; the envelope shape already carries key IDs for
// that migration.
package trust

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrNoSignature answers an envelope with no usable signature.
var ErrNoSignature = errors.New("no usable signature")

// ErrUnknownKey answers a signature from a key this server does not pin.
var ErrUnknownKey = errors.New("unknown signing key")

// MarketplaceKeyID names the pinned Tilecast marketplace signing key.
// The signed catalog must carry a signature under this ID.
const MarketplaceKeyID = "tilecast-marketplace"

// Verifier checks one signature scheme.
type Verifier interface {
	// KeyID names the pinned key this verifier checks.
	KeyID() string
	// Verify checks a detached signature over exact payload bytes.
	Verify(payload, signature []byte) error
}

// ParsePublicKey decodes a 32-byte Ed25519 public key from base64, the
// same encoding as the player-update manifest key.
func ParsePublicKey(encoded string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("public key is not base64: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key must be %d bytes", ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

type ed25519Verifier struct {
	keyID  string
	public ed25519.PublicKey
}

// NewEd25519Verifier pins one marketplace signing key.
func NewEd25519Verifier(keyID string, public ed25519.PublicKey) (Verifier, error) {
	if keyID == "" {
		return nil, errors.New("key id must not be empty")
	}
	if len(public) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key must be %d bytes", ed25519.PublicKeySize)
	}
	return &ed25519Verifier{keyID: keyID, public: public}, nil
}

// KeyID implements Verifier.
func (v *ed25519Verifier) KeyID() string { return v.keyID }

// Verify implements Verifier.
func (v *ed25519Verifier) Verify(payload, signature []byte) error {
	if !ed25519.Verify(v.public, payload, signature) {
		return fmt.Errorf("signature from %s does not verify", v.keyID)
	}
	return nil
}

// Signature is one detached envelope signature.
type Signature struct {
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

// Envelope carries exact payload bytes plus detached signatures.
type Envelope struct {
	Payload    json.RawMessage `json:"payload"`
	Signatures []Signature     `json:"signatures"`
}

// VerifyEnvelope decodes a signed envelope and verifies it against the
// pinned verifiers. It returns the exact payload bytes one signature
// covers. Verification succeeds when any pinned key verifies; it fails
// closed when no signature matches a pinned key.
func VerifyEnvelope(data []byte, verifiers ...Verifier) (json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var envelope Envelope
	if err := decoder.Decode(&envelope); err != nil {
		return nil, fmt.Errorf("signed envelope: %w", err)
	}
	if len(envelope.Payload) == 0 {
		return nil, fmt.Errorf("signed envelope: %w", ErrNoSignature)
	}
	if len(envelope.Signatures) == 0 {
		return nil, fmt.Errorf("signed envelope: %w", ErrNoSignature)
	}
	byID := make(map[string]Verifier, len(verifiers))
	for _, verifier := range verifiers {
		byID[verifier.KeyID()] = verifier
	}
	var matched bool
	var lastErr error
	for _, signature := range envelope.Signatures {
		verifier, ok := byID[signature.KeyID]
		if !ok {
			continue
		}
		matched = true
		raw, err := base64.StdEncoding.DecodeString(signature.Signature)
		if err != nil {
			lastErr = fmt.Errorf("signature from %s is not base64: %w", signature.KeyID, err)
			continue
		}
		if err := verifier.Verify(envelope.Payload, raw); err != nil {
			lastErr = err
			continue
		}
		return envelope.Payload, nil
	}
	if !matched {
		return nil, fmt.Errorf("signed envelope: %w", ErrUnknownKey)
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("signed envelope: %w", ErrNoSignature)
}
