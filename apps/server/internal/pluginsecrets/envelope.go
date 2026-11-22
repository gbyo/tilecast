package pluginsecrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// Envelope layout, for wrapped DEKs and sealed secrets:
//
//	version (1 byte) | nonce (12 bytes) | AES-256-GCM ciphertext and tag
//
// The version byte lets a later construction coexist with bytes an older
// server wrote. Every encryption draws a fresh nonce from the system CSPRNG.
const (
	envelopeVersion = 1
	nonceBytes      = 12
)

const (
	secretAADLabel = "tilecast-secret-v1"
	dekAADLabel    = "tilecast-dek-v1"
)

// errOpen is the one decryption failure. It carries no detail on purpose.
var errOpen = errors.New("decryption failed")

// SecretRef names one secret: the plugin, the owner, and the setting key.
type SecretRef struct {
	PluginID  string
	OwnerType string
	OwnerID   uuid.UUID
	Key       string
}

// Owner types of a secret.
const (
	OwnerOrganization = "organization"
	OwnerInstance     = "instance"
	OwnerScreen       = "screen"
)

func (ref SecretRef) validate() error {
	switch ref.OwnerType {
	case OwnerOrganization, OwnerInstance, OwnerScreen:
	default:
		return fmt.Errorf("unknown secret owner type %q", ref.OwnerType)
	}
	if ref.PluginID == "" || ref.Key == "" || ref.OwnerID == uuid.Nil || len(ref.PluginID) > 80 || len(ref.Key) > 80 {
		return errors.New("a secret needs a plugin, an owner, and a key")
	}
	return nil
}

// aad joins length-prefixed fields so that no two different field lists
// produce the same bytes.
func aad(fields ...string) []byte {
	out := []byte{}
	for _, field := range fields {
		var size [2]byte
		binary.BigEndian.PutUint16(size[:], uint16(len(field)))
		out = append(out, size[:]...)
		out = append(out, field...)
	}
	return out
}

func secretAAD(ref SecretRef) []byte {
	return aad(secretAADLabel, ref.PluginID, ref.OwnerType, ref.OwnerID.String(), ref.Key)
}

func dekAAD(dekID uuid.UUID, kekID string) []byte {
	return aad(dekAADLabel, dekID.String(), kekID)
}

func gcm(key []byte) (cipher.AEAD, error) {
	if len(key) != keyBytes {
		return nil, errOpen
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errOpen
	}
	return cipher.NewGCM(block)
}

func seal(key, plaintext, additional []byte) ([]byte, error) {
	aead, err := gcm(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate a nonce: %w", err)
	}
	out := make([]byte, 0, 1+nonceBytes+len(plaintext)+aead.Overhead())
	out = append(out, envelopeVersion)
	out = append(out, nonce...)
	return aead.Seal(out, nonce, plaintext, additional), nil
}

func open(key, envelope, additional []byte) ([]byte, error) {
	if len(envelope) < 1+nonceBytes+16 || envelope[0] != envelopeVersion {
		return nil, errOpen
	}
	aead, err := gcm(key)
	if err != nil {
		return nil, errOpen
	}
	plaintext, err := aead.Open(nil, envelope[1:1+nonceBytes], envelope[1+nonceBytes:], additional)
	if err != nil {
		return nil, errOpen
	}
	return plaintext, nil
}

// wrapDEK encrypts a DEK with a KEK.
func wrapDEK(kek []byte, kekID string, dekID uuid.UUID, dek []byte) ([]byte, error) {
	return seal(kek, dek, dekAAD(dekID, kekID))
}

// unwrapDEK decrypts a DEK.
func unwrapDEK(kek []byte, kekID string, dekID uuid.UUID, wrapped []byte) ([]byte, error) {
	dek, err := open(kek, wrapped, dekAAD(dekID, kekID))
	if err != nil || len(dek) != keyBytes {
		return nil, errOpen
	}
	return dek, nil
}

// sealSecret encrypts one secret value under a DEK for its location.
func sealSecret(dek []byte, ref SecretRef, value string) ([]byte, error) {
	return seal(dek, []byte(value), secretAAD(ref))
}

// openSecret decrypts one secret value at its location.
func openSecret(dek []byte, ref SecretRef, envelope []byte) (string, error) {
	plaintext, err := open(dek, envelope, secretAAD(ref))
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func newDEK() ([]byte, error) {
	dek := make([]byte, keyBytes)
	if _, err := rand.Read(dek); err != nil {
		return nil, fmt.Errorf("generate a key: %w", err)
	}
	return dek, nil
}
