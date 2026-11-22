// Package pluginsecrets stores Plugin Manifest API 3 plugin secrets with
// envelope encryption (docs/plugin-secrets.md).
//
// The security posture in one place, because every file here depends on it:
//
//   - A key encryption key (KEK) is 256 random bits in the key file named by
//     TILECAST_SECRETS_KEY_FILE. It never enters PostgreSQL, a log, an audit
//     event, or a Tilecast backup. The file holds the current KEK and every
//     older KEK that a stored data encryption key still needs.
//   - A data encryption key (DEK) is 256 random bits stored in PostgreSQL,
//     wrapped with one KEK under AES-256-GCM and bound to its own ID and the
//     KEK ID. Rotating the KEK wraps each DEK again; the secrets do not
//     change.
//   - A secret is sealed with AES-256-GCM under the current DEK with a fresh
//     random 96-bit nonce. The additional authenticated data names
//     tilecast-secret-v1, the plugin, the owner type and ID, and the setting
//     key, so a ciphertext copied to another plugin, owner, or setting fails
//     authentication.
//   - Failures are reported as "unavailable" or "needs a new value". No error
//     carries key bytes, ciphertext, plaintext, or crypto detail.
package pluginsecrets

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// KeyFileEnvironmentVariable names the key file.
const KeyFileEnvironmentVariable = "TILECAST_SECRETS_KEY_FILE"

// DefaultKeyFile is the key file path when the variable is unset. It is in
// the data directory, outside the media, package, update, and backup roots.
const DefaultKeyFile = "/data/secrets/kek.json"

const (
	keyFileFormat  = "tilecast-secret-keys"
	keyFileVersion = 1
	keyBytes       = 32
	maxKeyFile     = 64 << 10
	maxKeys        = 64
)

var (
	// ErrKeyFileInvalid means the key file exists but cannot be used. The
	// message never includes key material.
	ErrKeyFileInvalid = errors.New("the secrets key file is not a valid Tilecast key file")
	// ErrKeyFileMissing means the key file does not exist and was not created.
	ErrKeyFileMissing = errors.New("the secrets key file does not exist")
	// ErrKeyFileInsecure means the key file can be read by other accounts.
	ErrKeyFileInsecure = errors.New("the secrets key file must be a regular file readable only by its owner")
	// ErrExportExists refuses to overwrite an existing export file.
	ErrExportExists = errors.New("the export file already exists; choose a new path")
)

// KEK is one key encryption key. ID is a stable, non-secret identifier.
type KEK struct {
	ID        string
	CreatedAt time.Time
	key       []byte
}

// KeyRing is the set of KEKs in the key file.
type KeyRing struct {
	path    string
	current string
	keys    map[string]KEK
}

type keyFileJSON struct {
	Format  string        `json:"format"`
	Version int           `json:"version"`
	Current string        `json:"current"`
	Keys    []keyFileItem `json:"keys"`
}

type keyFileItem struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	Key       string    `json:"key"`
}

// Path is the key file path.
func (r *KeyRing) Path() string { return r.path }

// CurrentID is the KEK that wraps new DEKs.
func (r *KeyRing) CurrentID() string { return r.current }

// IDs lists every KEK ID, sorted.
func (r *KeyRing) IDs() []string {
	ids := make([]string, 0, len(r.keys))
	for id := range r.keys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Has reports whether the ring holds a KEK.
func (r *KeyRing) Has(id string) bool {
	_, ok := r.keys[id]
	return ok
}

func (r *KeyRing) key(id string) ([]byte, bool) {
	kek, ok := r.keys[id]
	return kek.key, ok
}

// LoadOrCreate reads the key file, creating it with one new KEK when it does
// not exist. A file that exists but cannot be used is an error: silently
// replacing it would make every stored secret unreadable.
func LoadOrCreate(path string) (*KeyRing, bool, error) {
	ring, err := Load(path)
	if err == nil {
		return ring, false, nil
	}
	if !errors.Is(err, ErrKeyFileMissing) {
		return nil, false, err
	}
	kek, err := newKEK()
	if err != nil {
		return nil, false, err
	}
	ring = &KeyRing{path: path, current: kek.ID, keys: map[string]KEK{kek.ID: kek}}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, false, fmt.Errorf("create the secrets key directory: %w", err)
	}
	if err := writeKeyFile(path, ring, true); err != nil {
		if errors.Is(err, os.ErrExist) {
			// Another process created it first; use that one.
			ring, err = Load(path)
			return ring, false, err
		}
		return nil, false, err
	}
	return ring, true, nil
}

// Load reads an existing key file.
func Load(path string) (*KeyRing, error) {
	file, err := os.OpenFile(path, os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrKeyFileMissing
	}
	if err != nil {
		return nil, fmt.Errorf("open the secrets key file: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, ErrKeyFileInsecure
	}
	return decodeKeyFile(path, io.LimitReader(file, maxKeyFile+1))
}

func decodeKeyFile(path string, reader io.Reader) (*KeyRing, error) {
	data, err := io.ReadAll(reader)
	if err != nil || len(data) > maxKeyFile {
		return nil, ErrKeyFileInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document keyFileJSON
	if err := decoder.Decode(&document); err != nil || decoder.More() {
		return nil, ErrKeyFileInvalid
	}
	if document.Format != keyFileFormat || document.Version != keyFileVersion || len(document.Keys) == 0 || len(document.Keys) > maxKeys {
		return nil, ErrKeyFileInvalid
	}
	ring := &KeyRing{path: path, current: document.Current, keys: map[string]KEK{}}
	for _, item := range document.Keys {
		if !validKEKID(item.ID) {
			return nil, ErrKeyFileInvalid
		}
		key, err := base64.StdEncoding.DecodeString(item.Key)
		if err != nil || len(key) != keyBytes {
			return nil, ErrKeyFileInvalid
		}
		if _, duplicate := ring.keys[item.ID]; duplicate {
			return nil, ErrKeyFileInvalid
		}
		ring.keys[item.ID] = KEK{ID: item.ID, CreatedAt: item.CreatedAt, key: key}
	}
	if !ring.Has(ring.current) {
		return nil, ErrKeyFileInvalid
	}
	return ring, nil
}

func validKEKID(id string) bool {
	if !strings.HasPrefix(id, "kek-") {
		return false
	}
	_, err := uuid.Parse(strings.TrimPrefix(id, "kek-"))
	return err == nil
}

func newKEK() (KEK, error) {
	key := make([]byte, keyBytes)
	if _, err := rand.Read(key); err != nil {
		return KEK{}, fmt.Errorf("generate a key: %w", err)
	}
	return KEK{ID: "kek-" + uuid.NewString(), CreatedAt: time.Now().UTC().Truncate(time.Second), key: key}, nil
}

func encodeKeyFile(ring *KeyRing) ([]byte, error) {
	document := keyFileJSON{Format: keyFileFormat, Version: keyFileVersion, Current: ring.current}
	for _, id := range ring.IDs() {
		kek := ring.keys[id]
		document.Keys = append(document.Keys, keyFileItem{ID: kek.ID, CreatedAt: kek.CreatedAt, Key: base64.StdEncoding.EncodeToString(kek.key)})
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// writeKeyFile writes a key file with owner-only permissions. exclusive
// refuses to replace an existing file; otherwise the new content replaces
// the file atomically through a temporary file in the same directory, so a
// crash leaves either the old file or the new one, never a partial file.
func writeKeyFile(path string, ring *KeyRing, exclusive bool) error {
	data, err := encodeKeyFile(ring)
	if err != nil {
		return err
	}
	if exclusive {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		return finishFile(file, data, path, false)
	}
	temporary := path + "." + uuid.NewString() + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("write the secrets key file: %w", err)
	}
	if err := finishFile(file, data, temporary, true); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace the secrets key file: %w", err)
	}
	return syncDirectory(filepath.Dir(path))
}

func finishFile(file *os.File, data []byte, path string, removeOnFailure bool) error {
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		if removeOnFailure {
			_ = os.Remove(path)
		}
		return errors.New("the secrets key file could not be written")
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer directory.Close()
	_ = directory.Sync()
	return nil
}

// AddKEK adds a new current KEK and writes the file. The previous KEKs stay:
// DEKs wrapped with them must remain readable until they are wrapped again.
func (r *KeyRing) AddKEK() (KEK, error) {
	if len(r.keys) >= maxKeys {
		return KEK{}, fmt.Errorf("the key file holds %d keys; prune keys no DEK uses before rotating", len(r.keys))
	}
	kek, err := newKEK()
	if err != nil {
		return KEK{}, err
	}
	next := r.clone()
	next.keys[kek.ID] = kek
	next.current = kek.ID
	if err := writeKeyFile(r.path, next, false); err != nil {
		return KEK{}, err
	}
	*r = *next
	return kek, nil
}

// Prune removes the KEKs that are not current and not in keep, and writes
// the file. It returns the removed IDs.
func (r *KeyRing) Prune(keep map[string]bool) ([]string, error) {
	next := r.clone()
	removed := []string{}
	for _, id := range r.IDs() {
		if id != r.current && !keep[id] {
			delete(next.keys, id)
			removed = append(removed, id)
		}
	}
	if len(removed) == 0 {
		return removed, nil
	}
	if err := writeKeyFile(r.path, next, false); err != nil {
		return nil, err
	}
	*r = *next
	return removed, nil
}

// Import adds the KEKs of another key file or export that this ring does not
// hold, keeping the current KEK. It returns the added IDs.
func (r *KeyRing) Import(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open the import file: %w", err)
	}
	defer file.Close()
	other, err := decodeKeyFile(path, io.LimitReader(file, maxKeyFile+1))
	if err != nil {
		return nil, err
	}
	next := r.clone()
	added := []string{}
	for _, id := range other.IDs() {
		if !next.Has(id) {
			next.keys[id] = other.keys[id]
			added = append(added, id)
		}
	}
	if len(next.keys) > maxKeys {
		return nil, fmt.Errorf("the key file would hold more than %d keys", maxKeys)
	}
	if len(added) == 0 {
		return added, nil
	}
	if err := writeKeyFile(r.path, next, false); err != nil {
		return nil, err
	}
	*r = *next
	return added, nil
}

// Export writes every KEK to a new file for offline storage. It refuses to
// overwrite an existing file, and refuses a path inside a directory that a
// Tilecast backup includes.
func (r *KeyRing) Export(path string, forbiddenRoots []string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for _, root := range forbiddenRoots {
		if root == "" {
			continue
		}
		if within(absolute, root) {
			return fmt.Errorf("the export must not be written inside %s, which a Tilecast backup or the media library includes", root)
		}
	}
	err = writeKeyFile(absolute, r, true)
	if errors.Is(err, os.ErrExist) {
		return ErrExportExists
	}
	return err
}

// Reload reads the key file again, for example after another process
// rotated the KEK.
func (r *KeyRing) Reload() error {
	next, err := Load(r.path)
	if err != nil {
		return err
	}
	*r = *next
	return nil
}

func (r *KeyRing) clone() *KeyRing {
	next := &KeyRing{path: r.path, current: r.current, keys: make(map[string]KEK, len(r.keys))}
	for id, kek := range r.keys {
		next.keys[id] = kek
	}
	return next
}

// Within reports whether path is root or below it.
func within(path, root string) bool {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(absoluteRoot, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// CheckKeyFileLocation refuses a key file path inside a directory that a
// backup archive or a package or media download includes.
func CheckKeyFileLocation(path string, roots map[string]string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for name, root := range roots {
		if root != "" && within(absolute, root) {
			return fmt.Errorf("%s must not be inside %s (%s): a backup or download would include the key", KeyFileEnvironmentVariable, name, root)
		}
	}
	return nil
}
