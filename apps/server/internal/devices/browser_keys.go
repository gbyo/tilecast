package devices

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"math/big"
)

// BrowserPublicKey is the public-only P-256 JWK exported by WebCrypto.
// Unknown JWK fields are rejected by the HTTP decoder.
type BrowserPublicKey struct {
	KeyType string   `json:"kty"`
	Curve   string   `json:"crv"`
	X       string   `json:"x"`
	Y       string   `json:"y"`
	Ext     bool     `json:"ext"`
	KeyOps  []string `json:"key_ops"`
}

func (key BrowserPublicKey) parse() (*ecdsa.PublicKey, error) {
	if key.KeyType != "EC" || key.Curve != "P-256" || len(key.KeyOps) != 1 || key.KeyOps[0] != "verify" {
		return nil, ErrInvalidCredential
	}
	x, err := base64.RawURLEncoding.Strict().DecodeString(key.X)
	if err != nil || len(x) != 32 {
		return nil, ErrInvalidCredential
	}
	y, err := base64.RawURLEncoding.Strict().DecodeString(key.Y)
	if err != nil || len(y) != 32 {
		return nil, ErrInvalidCredential
	}
	public := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	if !public.Curve.IsOnCurve(public.X, public.Y) {
		return nil, ErrInvalidCredential
	}
	return public, nil
}

func verifyBrowserSignature(key BrowserPublicKey, message, encoded string) bool {
	public, err := key.parse()
	if err != nil {
		return false
	}
	// WebCrypto ECDSA returns IEEE P1363 r || s, not ASN.1 DER.
	signature, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(signature) != 64 {
		return false
	}
	digest := sha256.Sum256([]byte(message))
	return ecdsa.Verify(public, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:]))
}
