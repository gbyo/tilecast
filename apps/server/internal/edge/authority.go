package edge

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Edge server secrets (RFC §10.4, §12).
//
// Two keys live under the Edge root (TILECAST_EDGE_ROOT, default /data/edge),
// separate from each other and from the offline player release-signing key,
// which never exists on the server:
//
//	authority.key  Ed25519 PKCS#8: signs change envelopes and snapshots
//	ca.key         Ed25519 PKCS#8: signs node certificates
//	ca.crt         the installation Edge CA certificate (public)
//
// PostgreSQL records the public identity (edge_authority). Startup rules:
//
//   - no row and no files: generate both keys and the CA, write the files
//     (temp file, fsync, rename, mode 0600), then insert the row;
//   - files but no row: an earlier start crashed after writing the files and
//     before the insert, or the database was restored without Edge state;
//     the row is recreated from the files;
//   - a row whose files are missing or do not match: ErrAuthorityMissing.
//     Every Edge endpoint then answers edge_authority_unavailable. A new
//     identity is never generated silently: that would strand every enrolled
//     node, which pins the old CA and authority key.

const (
	authorityEpoch  = 1
	caValidity      = 20 * 365 * 24 * time.Hour
	authorityFile   = "authority.key"
	caKeyFile       = "ca.key"
	caCertFile      = "ca.crt"
	edgeURNPrefix   = "urn:tilecast:edge:"
	purposeNodeURN  = "urn:tilecast:edge:purpose:node"
	purposeCAURN    = "urn:tilecast:edge:purpose:ca"
	advisoryLockKey = 7421917
)

var ErrAuthorityMissing = errors.New("edge authority files are missing or do not match the database")

// ErrInstallationNotConfigured means one-time setup has not run yet. Unlike
// ErrAuthorityMissing it resolves on its own, so initialization is retried.
var ErrInstallationNotConfigured = errors.New("edge authority needs a configured installation")

type Authority struct {
	InstallationID string
	Epoch          int
	signingKey     ed25519.PrivateKey
	caKey          ed25519.PrivateKey
	caCert         *x509.Certificate
	caDER          []byte
}

func (a *Authority) PublicKey() ed25519.PublicKey {
	return a.signingKey.Public().(ed25519.PublicKey)
}

func (a *Authority) KeyID() string { return KeyID(a.PublicKey()) }

func (a *Authority) CACertificateDER() []byte { return append([]byte(nil), a.caDER...) }

func (a *Authority) CAFingerprint() string {
	sum := sha256.Sum256(a.caDER)
	return hex.EncodeToString(sum[:])
}

func edgeURN(kind, id string) *url.URL {
	parsed, _ := url.Parse(edgeURNPrefix + kind + ":" + id)
	return parsed
}

// LoadOrInitAuthority applies the startup rules above.
func LoadOrInitAuthority(ctx context.Context, db *pgxpool.Pool, root string) (*Authority, error) {
	var installationID string
	if err := db.QueryRow(ctx, `SELECT installation_id FROM organization_settings WHERE singleton=TRUE`).Scan(&installationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInstallationNotConfigured
		}
		return nil, fmt.Errorf("read installation identity: %w", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create edge root: %w", err)
	}
	conn, err := db.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	// Two server processes starting together must not generate two CAs.
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, advisoryLockKey); err != nil {
		return nil, err
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, advisoryLockKey) //nolint:errcheck

	var row struct {
		installationID string
		epoch          int
		publicKey      []byte
		caDER          []byte
	}
	err = conn.QueryRow(ctx, `SELECT installation_id,authority_epoch,authority_public_key,ca_certificate_der FROM edge_authority WHERE singleton=TRUE`).
		Scan(&row.installationID, &row.epoch, &row.publicKey, &row.caDER)
	hasRow := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("read edge authority: %w", err)
	}
	authority, fileErr := loadAuthorityFiles(root, installationID)
	switch {
	case hasRow && fileErr != nil:
		return nil, fmt.Errorf("%w: %v", ErrAuthorityMissing, fileErr)
	case hasRow:
		if row.installationID != installationID || !equalBytes(row.publicKey, authority.PublicKey()) || !equalBytes(row.caDER, authority.caDER) {
			return nil, ErrAuthorityMissing
		}
		authority.Epoch = row.epoch
		return authority, nil
	case fileErr == nil:
		// Files survived without the row: recreate the row from them.
	case errors.Is(fileErr, os.ErrNotExist):
		authority, err = generateAuthority(root, installationID)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("%w: %v", ErrAuthorityMissing, fileErr)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO edge_authority(singleton,installation_id,authority_epoch,authority_public_key,authority_key_id,ca_certificate_der,ca_fingerprint)
		VALUES(TRUE,$1,$2,$3,$4,$5,$6)`, installationID, authority.Epoch, []byte(authority.PublicKey()), authority.KeyID(), authority.caDER, authority.CAFingerprint()); err != nil {
		return nil, fmt.Errorf("record edge authority: %w", err)
	}
	return authority, nil
}

func generateAuthority(root, installationID string) (*Authority, error) {
	_, signingKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	caPublic, caKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Tilecast Edge CA " + installationID},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(caValidity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		URIs:                  []*url.URL{edgeURN("installation", installationID), mustURL(purposeCAURN)},
	}
	caDER, err := x509.CreateCertificate(rand.Reader, template, template, caPublic, caKey)
	if err != nil {
		return nil, fmt.Errorf("create edge CA: %w", err)
	}
	for name, key := range map[string]ed25519.PrivateKey{authorityFile: signingKey, caKeyFile: caKey} {
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, err
		}
		if err := writePrivateFile(filepath.Join(root, name), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})); err != nil {
			return nil, err
		}
	}
	if err := writePrivateFile(filepath.Join(root, caCertFile), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})); err != nil {
		return nil, err
	}
	return loadAuthorityFiles(root, installationID)
}

func loadAuthorityFiles(root, installationID string) (*Authority, error) {
	signingKey, err := readPrivateKey(filepath.Join(root, authorityFile))
	if err != nil {
		return nil, err
	}
	caKey, err := readPrivateKey(filepath.Join(root, caKeyFile))
	if err != nil {
		return nil, err
	}
	certPEM, err := readOwnerOnly(filepath.Join(root, caCertFile))
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("ca.crt is not a PEM certificate")
	}
	caCert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	caPublic, ok := caCert.PublicKey.(ed25519.PublicKey)
	if !ok || !equalBytes(caPublic, caKey.Public().(ed25519.PublicKey)) {
		return nil, errors.New("ca.crt does not match ca.key")
	}
	if !hasURI(caCert, edgeURN("installation", installationID).String()) {
		return nil, errors.New("edge CA belongs to another installation")
	}
	if equalBytes(signingKey.Public().(ed25519.PublicKey), caPublic) {
		return nil, errors.New("authority and CA keys must differ")
	}
	return &Authority{InstallationID: installationID, Epoch: authorityEpoch, signingKey: signingKey, caKey: caKey, caCert: caCert, caDER: block.Bytes}, nil
}

func readOwnerOnly(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s must be a regular owner-only file", filepath.Base(path))
	}
	return os.ReadFile(path)
}

func readPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := readOwnerOnly(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s is not a PEM private key", filepath.Base(path))
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s is not an Ed25519 key", filepath.Base(path))
	}
	return key, nil
}

// writePrivateFile writes via a unique temporary file, fsyncs it, renames it
// into place and fsyncs the directory. Existing files are never overwritten.
func writePrivateFile(path string, data []byte) error {
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("%s already exists", filepath.Base(path))
	}
	temp := path + "." + uuid.NewString() + ".tmp"
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(temp)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temp)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temp)
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		os.Remove(temp)
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		dir.Close()
	}
	return nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 127)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, err
	}
	return serial.Add(serial, big.NewInt(1)), nil
}

func mustURL(value string) *url.URL {
	parsed, err := url.Parse(value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func hasURI(cert *x509.Certificate, want string) bool {
	for _, uri := range cert.URIs {
		if uri.String() == want {
			return true
		}
	}
	return false
}
