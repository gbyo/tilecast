// Package credential makes and parses the two-part bearer credentials of
// Tilecast: <prefix><public id>.<secret>. The public ID selects a stored
// record; only the SHA-256 digest of the secret is stored, and the
// presented secret is compared with it in constant time. Integration tokens
// (tci_) and plugin webhook tokens (tch_) share this shape and nothing
// else: each owner keeps its own table, scopes, and lifecycle.
package credential

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

// New generates a public ID (12 random bytes, hex) and a secret (32 random
// bytes, unpadded base64url).
func New() (publicID, secret string, err error) {
	publicBytes := make([]byte, 12)
	if _, err = rand.Read(publicBytes); err != nil {
		return "", "", err
	}
	secretBytes := make([]byte, 32)
	if _, err = rand.Read(secretBytes); err != nil {
		return "", "", err
	}
	return hex.EncodeToString(publicBytes), base64.RawURLEncoding.EncodeToString(secretBytes), nil
}

// Format joins a credential for its one-time reveal.
func Format(prefix, publicID, secret string) string { return prefix + publicID + "." + secret }

// Digest is the stored form of a secret.
func Digest(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// Matches compares a presented secret with a stored digest in constant time.
func Matches(secret string, stored []byte) bool {
	presented := sha256.Sum256([]byte(secret))
	return subtle.ConstantTimeCompare(presented[:], stored) == 1
}

// ParseBearer splits an Authorization header value of the form
// "Bearer <prefix><public id>.<secret>". It does no lookup, so a malformed
// header costs nothing.
func ParseBearer(header, prefix string) (publicID, secret string, ok bool) {
	value := strings.TrimSpace(header)
	if !strings.HasPrefix(value, "Bearer ") {
		return "", "", false
	}
	raw := strings.TrimSpace(strings.TrimPrefix(value, "Bearer "))
	if !strings.HasPrefix(raw, prefix) {
		return "", "", false
	}
	publicID, secret, found := strings.Cut(strings.TrimPrefix(raw, prefix), ".")
	if !found || publicID == "" || secret == "" {
		return "", "", false
	}
	return publicID, secret, true
}
