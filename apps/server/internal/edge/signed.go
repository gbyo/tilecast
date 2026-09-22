package edge

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// Signed documents: the wrapper every server-authorized Edge object travels
// in (edge_protocol::signed in the daemon). The signing input is
//
//	"tilecast-edge-signed-v1\n" || purpose || "\n" || canonical body bytes
//
// so a signature cannot be replayed under another purpose. Peers relay the
// wrapper byte-for-byte; they never re-sign.

const signedFormatV1 = "tilecast-edge-signed-v1"

const (
	PurposeServerChange   = "server.change"
	PurposeServerSnapshot = "server.snapshot"
)

type SignatureBlock struct {
	Alg   string `json:"alg"`
	KeyID string `json:"keyId"`
	Value string `json:"value"`
}

type SignedDocument struct {
	Format    string         `json:"format"`
	Purpose   string         `json:"purpose"`
	Body      string         `json:"body"`
	Signature SignatureBlock `json:"signature"`
}

// KeyID is "sha256:<hex>" of the raw 32-byte Ed25519 public key.
func KeyID(public ed25519.PublicKey) string {
	sum := sha256.Sum256(public)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func signingInput(purpose string, body []byte) []byte {
	input := make([]byte, 0, len(signedFormatV1)+len(purpose)+2+len(body))
	input = append(input, signedFormatV1...)
	input = append(input, '\n')
	input = append(input, purpose...)
	input = append(input, '\n')
	return append(input, body...)
}

// Sign canonicalizes body and signs it for purpose.
func Sign(key ed25519.PrivateKey, purpose string, body map[string]any) (SignedDocument, []byte, error) {
	canonical, err := Canonicalize(body)
	if err != nil {
		return SignedDocument{}, nil, err
	}
	public, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		return SignedDocument{}, nil, errors.New("signing key is not Ed25519")
	}
	signature := ed25519.Sign(key, signingInput(purpose, canonical))
	return SignedDocument{
		Format:  signedFormatV1,
		Purpose: purpose,
		Body:    base64.RawURLEncoding.EncodeToString(canonical),
		Signature: SignatureBlock{
			Alg:   "ed25519",
			KeyID: KeyID(public),
			Value: base64.RawURLEncoding.EncodeToString(signature),
		},
	}, canonical, nil
}

// Encode returns the wire bytes stored in edge_changes and relayed by peers.
func (d SignedDocument) Encode() ([]byte, error) {
	return json.Marshal(d)
}

// Verify checks a document against one trusted key and returns its body.
// The server uses this for self-checks and tests; nodes run the Rust
// verifier.
func Verify(document SignedDocument, purpose string, public ed25519.PublicKey) (map[string]any, error) {
	if document.Format != signedFormatV1 {
		return nil, errors.New("unsupported signed-document format")
	}
	if document.Purpose != purpose {
		return nil, errors.New("unexpected purpose")
	}
	if document.Signature.Alg != "ed25519" || document.Signature.KeyID != KeyID(public) {
		return nil, errors.New("untrusted key")
	}
	body, err := base64.RawURLEncoding.DecodeString(document.Body)
	if err != nil {
		return nil, fmt.Errorf("malformed body: %w", err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(document.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return nil, errors.New("malformed signature")
	}
	if !ed25519.Verify(public, signingInput(purpose, body), signature) {
		return nil, errors.New("signature does not verify")
	}
	return ParseCanonical(body)
}

// BodyDigest is the hex SHA-256 of canonical body bytes: the document's
// identity for duplicate and conflict detection.
func BodyDigest(canonical []byte) string {
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

func equalBytes(a, b []byte) bool { return bytes.Equal(a, b) }
