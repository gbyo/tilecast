package database

import (
	"bytes"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"time"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	bundled "github.com/tilecast/tilecast/plugins"
)

//go:embed migrations/*.sql
var coreMigrations embed.FS

// migrationDir is the one directory Goose reads. Core and plugin migrations
// appear in it side by side, so there is one version sequence, one
// goose_db_version history, and one schema version for backup and restore.
const migrationDir = "migrations"

var migrationName = regexp.MustCompile(`^(\d+)_[a-z0-9_]+\.sql$`)

// CatalogEntry is one migration and the part of Tilecast that owns it.
type CatalogEntry struct {
	Version int64
	File    string
	Owner   string
	Content []byte
}

// Catalog lists every migration compiled into this binary: the server's own
// and every bundled plugin's, ordered by version.
func Catalog() ([]CatalogEntry, error) {
	return catalogFrom(bundled.Bundled())
}

func catalogFrom(plugins []plugin.Plugin) ([]CatalogEntry, error) {
	entries := []CatalogEntry{}
	collect := func(fsys fs.FS, dir, owner string) error {
		files, err := fs.ReadDir(fsys, dir)
		if err != nil {
			return err
		}
		for _, file := range files {
			if file.IsDir() || path.Ext(file.Name()) != ".sql" {
				continue
			}
			match := migrationName.FindStringSubmatch(file.Name())
			if match == nil {
				return fmt.Errorf("migration %s (%s) is not named NNNNN_name.sql", file.Name(), owner)
			}
			version, err := strconv.ParseInt(match[1], 10, 64)
			if err != nil {
				return err
			}
			content, err := fs.ReadFile(fsys, path.Join(dir, file.Name()))
			if err != nil {
				return err
			}
			entries = append(entries, CatalogEntry{Version: version, File: file.Name(), Owner: owner, Content: content})
		}
		return nil
	}
	if err := collect(coreMigrations, migrationDir, "core"); err != nil {
		return nil, err
	}
	for _, p := range plugins {
		migrator, ok := p.(plugin.Migrator)
		if !ok || migrator.Migrations() == nil {
			continue
		}
		if err := collect(migrator.Migrations(), ".", p.Manifest().ID); err != nil {
			return nil, fmt.Errorf("plugin %s migrations: %w", p.Manifest().ID, err)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Version < entries[j].Version })
	for index := 1; index < len(entries); index++ {
		if entries[index].Version == entries[index-1].Version {
			return nil, fmt.Errorf("migration version %d is used by %s (%s) and %s (%s)",
				entries[index].Version, entries[index-1].File, entries[index-1].Owner, entries[index].File, entries[index].Owner)
		}
	}
	return entries, nil
}

// migrationFS presents the catalog to Goose as one directory.
func migrationFS() (fs.FS, error) {
	entries, err := Catalog()
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for _, entry := range entries {
		files[entry.File] = entry.Content
	}
	return memoryFS(files), nil
}

// memoryFS is a read-only file system holding one directory of files.
type memoryFS map[string][]byte

func (m memoryFS) Open(name string) (fs.File, error) {
	if name == "." || name == migrationDir {
		return &memoryDir{fs: m, name: name}, nil
	}
	dir, file := path.Split(name)
	if dir != migrationDir+"/" {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	content, ok := m[file]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return &memoryFile{info: memoryInfo{name: file, size: int64(len(content))}, Reader: bytes.NewReader(content)}, nil
}

func (m memoryFS) ReadDir(name string) ([]fs.DirEntry, error) {
	switch name {
	case ".":
		return []fs.DirEntry{fs.FileInfoToDirEntry(memoryInfo{name: migrationDir, dir: true})}, nil
	case migrationDir:
		names := make([]string, 0, len(m))
		for file := range m {
			names = append(names, file)
		}
		sort.Strings(names)
		entries := make([]fs.DirEntry, 0, len(names))
		for _, file := range names {
			entries = append(entries, fs.FileInfoToDirEntry(memoryInfo{name: file, size: int64(len(m[file]))}))
		}
		return entries, nil
	}
	return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrNotExist}
}

type memoryFile struct {
	info memoryInfo
	*bytes.Reader
}

func (f *memoryFile) Stat() (fs.FileInfo, error) { return f.info, nil }
func (f *memoryFile) Close() error               { return nil }

type memoryDir struct {
	fs   memoryFS
	name string
	read bool
}

func (d *memoryDir) Stat() (fs.FileInfo, error) {
	return memoryInfo{name: path.Base(d.name), dir: true}, nil
}
func (d *memoryDir) Read([]byte) (int, error) {
	return 0, &fs.PathError{Op: "read", Path: d.name, Err: fs.ErrInvalid}
}
func (d *memoryDir) Close() error { return nil }
func (d *memoryDir) ReadDir(count int) ([]fs.DirEntry, error) {
	if d.read {
		if count > 0 {
			return nil, io.EOF
		}
		return nil, nil
	}
	d.read = true
	return d.fs.ReadDir(d.name)
}

type memoryInfo struct {
	name string
	size int64
	dir  bool
}

func (i memoryInfo) Name() string { return i.name }
func (i memoryInfo) Size() int64  { return i.size }
func (i memoryInfo) Mode() fs.FileMode {
	if i.dir {
		return fs.ModeDir | 0o555
	}
	return 0o444
}
func (i memoryInfo) ModTime() time.Time { return time.Time{} }
func (i memoryInfo) IsDir() bool        { return i.dir }
func (i memoryInfo) Sys() any           { return nil }
