package backup

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

// Kind classifies why a backup archive exists.
type Kind string

const (
	KindManual     Kind = "manual"
	KindScheduled  Kind = "scheduled"
	KindPreRestore Kind = "pre_restore"
	KindImported   Kind = "imported"
)

// fileComponent maps a directory on disk to an archive prefix.
type fileComponent struct {
	name    string
	root    string
	prefix  string
	exclude func(rel string) bool
}

// CreateOptions configures one backup creation run.
type CreateOptions struct {
	DB          *pgxpool.Pool
	MediaRoot   string
	UpdatesRoot string
	BackupRoot  string
	Kind        Kind
	// Build is stamped into the manifest so support and restore workflows
	// can tell which server build created the archive.
	Build version.Build
	// ReservedFreeBytes must remain free on the backup volume after the
	// estimated archive is written.
	ReservedFreeBytes int64
	Limits            Limits
	// Progress receives coarse phase updates; may be nil.
	Progress func(phase string, percent int)
	// Clock supports deterministic archive names in tests; nil uses time.Now.
	Clock func() time.Time
}

// CreateResult describes a completed, verified archive.
type CreateResult struct {
	FileName      string
	Path          string
	SizeBytes     int64
	ArchiveSHA256 string
	Manifest      Manifest
}

// mediaComponents returns the file components included in a backup.
// Media uploads (in-flight) and trash are transient and excluded. Player
// update GitHub OAuth state holds credentials and is never archived.
func backupComponents(mediaRoot, updatesRoot string) []fileComponent {
	return []fileComponent{
		{name: ComponentMediaOriginals, root: filepath.Join(mediaRoot, "originals"), prefix: originalsPrefix},
		{name: ComponentMediaVariants, root: filepath.Join(mediaRoot, "variants"), prefix: variantsPrefix},
		{name: ComponentMediaThumbnails, root: filepath.Join(mediaRoot, "thumbnails"), prefix: thumbnailsPrefix},
		{name: ComponentPlayerUpdates, root: updatesRoot, prefix: updatesPrefix, exclude: func(rel string) bool {
			return strings.HasPrefix(rel, "github-oauth") || strings.HasSuffix(rel, ".part")
		}},
	}
}

// Create builds a complete backup archive using temporary files, fully
// verifies it, and only then atomically renames it into the backup root.
func Create(ctx context.Context, opts CreateOptions) (CreateResult, error) {
	if opts.Clock == nil {
		opts.Clock = time.Now
	}
	now := opts.Clock().UTC()
	if opts.Progress == nil {
		opts.Progress = func(string, int) {}
	}

	tmpDir := filepath.Join(opts.BackupRoot, "tmp")
	if err := os.MkdirAll(tmpDir, 0o750); err != nil {
		return CreateResult{}, fmt.Errorf("create backup workspace: %w", err)
	}

	opts.Progress("checking_disk_space", 2)
	if err := checkBackupDiskSpace(ctx, opts); err != nil {
		return CreateResult{}, err
	}

	fileName := archiveFileName(now, opts.Kind)
	partialPath := filepath.Join(tmpDir, fileName+".partial")
	partial, err := os.OpenFile(partialPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return CreateResult{}, fmt.Errorf("create archive file: %w", err)
	}
	cleanup := func() {
		partial.Close()
		os.Remove(partialPath)
	}

	writer := newArchiveWriter(partial)

	opts.Progress("database_snapshot", 5)
	snapshot, err := dumpDatabase(ctx, opts.DB, writer, tmpDir, func(table string) {
		opts.Progress("database_snapshot:"+table, 10)
	})
	if err != nil {
		cleanup()
		return CreateResult{}, fmt.Errorf("database snapshot failed: %w", err)
	}

	components := []ManifestComponent{databaseComponent(writer.files)}
	for index, component := range backupComponents(opts.MediaRoot, opts.UpdatesRoot) {
		opts.Progress("archiving_"+component.name, 25+index*15)
		summary, err := archiveDirectory(ctx, writer, component)
		if err != nil {
			cleanup()
			return CreateResult{}, fmt.Errorf("archive %s: %w", component.name, err)
		}
		components = append(components, summary)
	}

	manifest := Manifest{
		FormatVersion:    FormatVersion,
		TilecastVersion:  opts.Build.Version,
		ServerChannel:    opts.Build.Channel,
		BuildCommit:      opts.Build.Commit,
		BuildDate:        opts.Build.Date,
		SchemaVersion:    snapshot.SchemaVersion,
		InstallationID:   snapshot.InstallationID,
		OrganizationName: snapshot.OrganizationName,
		CreatedAt:        now,
		Components:       components,
		Database:         DatabaseManifest{Tables: snapshot.Tables, Sequences: snapshot.Sequences},
	}

	opts.Progress("finalizing_archive", 85)
	if err := writer.finish(manifest); err != nil {
		cleanup()
		return CreateResult{}, err
	}
	if err := partial.Sync(); err != nil {
		cleanup()
		return CreateResult{}, fmt.Errorf("flush archive: %w", err)
	}
	if err := partial.Close(); err != nil {
		os.Remove(partialPath)
		return CreateResult{}, fmt.Errorf("close archive: %w", err)
	}

	// The archive only becomes visible after every component and checksum
	// verifies against the manifest that was just written.
	opts.Progress("verifying", 90)
	verified, err := Verify(ctx, partialPath, opts.Limits)
	if err != nil {
		os.Remove(partialPath)
		return CreateResult{}, fmt.Errorf("new archive failed verification: %w", err)
	}

	finalPath := filepath.Join(opts.BackupRoot, fileName)
	if err := os.Rename(partialPath, finalPath); err != nil {
		os.Remove(partialPath)
		return CreateResult{}, fmt.Errorf("finalize archive: %w", err)
	}
	stat, err := os.Stat(finalPath)
	if err != nil {
		return CreateResult{}, fmt.Errorf("stat finished archive: %w", err)
	}
	opts.Progress("complete", 100)
	return CreateResult{
		FileName:      fileName,
		Path:          finalPath,
		SizeBytes:     stat.Size(),
		ArchiveSHA256: verified.ArchiveSHA256,
		Manifest:      verified.Manifest,
	}, nil
}

func databaseComponent(files []ManifestFile) ManifestComponent {
	summary := ManifestComponent{Name: ComponentDatabase}
	for _, file := range files {
		if strings.HasPrefix(file.Path, databasePrefix) {
			summary.FileCount++
			summary.TotalBytes += file.SizeBytes
		}
	}
	return summary
}

// archiveDirectory walks one component directory and adds every regular file.
// Symlinks are rejected outright: a Tilecast-managed tree never contains
// them, and following one could leak files from outside the tree.
func archiveDirectory(ctx context.Context, writer *archiveWriter, component fileComponent) (ManifestComponent, error) {
	summary := ManifestComponent{Name: component.name}
	if _, err := os.Stat(component.root); os.IsNotExist(err) {
		// An empty component (for example no player updates yet) is valid.
		return summary, nil
	}
	err := filepath.WalkDir(component.root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("%s is not a regular file; refusing to archive it", path)
		}
		rel, err := filepath.Rel(component.root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if component.exclude != nil && component.exclude(rel) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		if err := writer.addFile(component.prefix+rel, info.Size(), info.ModTime(), file); err != nil {
			return err
		}
		summary.FileCount++
		summary.TotalBytes += info.Size()
		return nil
	})
	if err != nil {
		return ManifestComponent{}, err
	}
	return summary, nil
}

func archiveFileName(now time.Time, kind Kind) string {
	suffix := ""
	if kind == KindPreRestore {
		suffix = "-pre-restore"
	}
	return fmt.Sprintf("tilecast-backup-%s%s.tar", now.Format("20060102T150405Z"), suffix)
}

// checkBackupDiskSpace estimates the archive size from the database size and
// component file sizes, and requires that plus the reserve to fit on the
// backup volume.
func checkBackupDiskSpace(ctx context.Context, opts CreateOptions) error {
	var databaseBytes int64
	if err := opts.DB.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&databaseBytes); err != nil {
		return fmt.Errorf("estimate database size: %w", err)
	}
	estimate := databaseBytes
	for _, component := range backupComponents(opts.MediaRoot, opts.UpdatesRoot) {
		size, err := directorySize(component.root)
		if err != nil {
			return fmt.Errorf("estimate %s size: %w", component.name, err)
		}
		estimate += size
	}
	available, err := availableBytes(opts.BackupRoot)
	if err != nil {
		return fmt.Errorf("check backup volume free space: %w", err)
	}
	needed := estimate + estimate/10 + opts.ReservedFreeBytes
	if int64(available) < needed {
		return fmt.Errorf("not enough space on the backup volume: about %d bytes needed, %d available", needed, available)
	}
	return nil
}

func directorySize(root string) (int64, error) {
	var total int64
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return 0, nil
	}
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			total += info.Size()
		}
		return nil
	})
	return total, err
}

func availableBytes(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return stat.Bavail * uint64(stat.Bsize), nil
}
