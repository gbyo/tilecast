package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/backup"
	"github.com/tilecast/tilecast/apps/server/internal/config"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

func printUsage() {
	fmt.Print(`Tilecast server administration

This is the local server and recovery utility. It runs on the server host
with direct database access. Remote management from an operator machine is
the tilecast CLI, which is a separate application.

Usage:
  tilecast-server                          Run the Tilecast server (default)
  tilecast-server serve                    Run the Tilecast server
  tilecast-server backup create            Create a full backup into TILECAST_BACKUP_ROOT
  tilecast-server backup verify <file>     Fully verify a backup archive
  tilecast-server backup inspect <file>    Show a backup archive's manifest
  tilecast-server restore verify <file>    Verify an archive and show the restore plan
  tilecast-server restore apply <file>     Restore a backup (stop the server first)
  tilecast-server mfa reset <username>     Clear a user's multi-factor enrollment

Restore flags (tilecast-server restore apply):
  --yes                             Skip the interactive confirmation
  --confirm-identity-mismatch       Restore an archive from a different installation
  --skip-pre-restore-backup         Do not create a pre-restore backup first
  --force                           Proceed even if a running server holds the database lock

Multi-factor reset flags (tilecast-server mfa reset):
  --yes                             Skip the interactive confirmation

Use "mfa reset" only when no Owner or Administrator can perform the reset in
Studio. It clears the account's authenticator, passkeys, and recovery codes,
signs the account out everywhere, and records an audit entry.

These commands read the same TILECAST_* environment variables as the server.
`)
}

func runCLI(command string, args []string) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	ctx, stop := signalContext()
	defer stop()

	switch {
	case command == "backup" && len(args) > 0 && args[0] == "create":
		cliBackupCreate(ctx, logger)
	case command == "backup" && len(args) > 1 && args[0] == "verify":
		cliArchiveVerify(ctx, args[1])
	case command == "backup" && len(args) > 1 && args[0] == "inspect":
		cliArchiveInspect(ctx, args[1])
	case command == "restore" && len(args) > 1 && args[0] == "verify":
		cliRestoreVerify(ctx, args[1])
	case command == "restore" && len(args) > 0 && args[0] == "apply":
		cliRestoreApply(ctx, logger, args[1:])
	case command == "mfa" && len(args) > 1 && args[0] == "reset":
		cliMFAReset(ctx, args[1:])
	default:
		printUsage()
		os.Exit(2)
	}
}

func signalContext() (context.Context, context.CancelFunc) {
	return context.WithCancel(context.Background())
}

func cliFail(message string, err error) {
	fmt.Fprintf(os.Stderr, "error: %s: %v\n", message, err)
	os.Exit(1)
}

func loadCLIConfig() config.Config {
	cfg, err := config.Load()
	if err != nil {
		cliFail("configuration is invalid", err)
	}
	return cfg
}

func cliLimits(cfg config.Config) backup.Limits {
	return backup.Limits{MaxFiles: cfg.Backup.MaxArchiveFiles, MaxExpandedBytes: cfg.Backup.MaxArchiveBytes}
}

func cliBackupCreate(ctx context.Context, logger *slog.Logger) {
	cfg := loadCLIConfig()
	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		cliFail("database connection failed", err)
	}
	defer db.Close()

	guard := backup.NewGuard()
	service, err := backup.NewService(db, cfg.Backup.Root, guard)
	if err != nil {
		cliFail("initialize backup service", err)
	}
	jobID, err := service.BeginExternalJob(ctx, "backup")
	if err != nil {
		if errors.Is(err, backup.ErrJobActive) {
			cliFail("cannot start", errors.New("another backup or restore job is already running"))
		}
		cliFail("record backup job", err)
	}

	fmt.Println("Creating backup...")
	result, err := backup.Create(ctx, backup.CreateOptions{
		DB:                db,
		MediaRoot:         cfg.Media.Root,
		UpdatesRoot:       cfg.Updates.Root,
		BackupRoot:        cfg.Backup.Root,
		Kind:              backup.KindManual,
		Build:             version.CurrentBuild(),
		ReservedFreeBytes: cfg.Backup.ReservedFreeBytes,
		Limits:            cliLimits(cfg),
		Progress: func(phase string, percent int) {
			service.TouchExternalJob(ctx, jobID)
			fmt.Printf("  %-40s %3d%%\n", phase, percent)
		},
	})
	service.CompleteExternalJob(ctx, jobID, err)
	if err != nil {
		cliFail("backup failed", err)
	}
	if err := registerCLIResult(ctx, service, result); err != nil {
		logger.Warn("backup finished but registering it in the catalog failed", "error", err)
	}
	fmt.Printf("\nBackup complete: %s (%d bytes)\n", result.Path, result.SizeBytes)
	fmt.Printf("  Tilecast version: %s\n  Server channel: %s\n  Build commit: %s\n  Schema version: %d\n  Files: %d\n", result.Manifest.TilecastVersion, result.Manifest.ServerChannel, result.Manifest.BuildCommit, result.Manifest.SchemaVersion, len(result.Manifest.Files))
}

func registerCLIResult(ctx context.Context, service *backup.Service, result backup.CreateResult) error {
	now := result.Manifest.CreatedAt
	return service.RegisterArchive(ctx, backup.Archive{
		FileName:         result.FileName,
		Kind:             backup.KindManual,
		Status:           "complete",
		SizeBytes:        result.SizeBytes,
		ArchiveSHA256:    result.ArchiveSHA256,
		TilecastVersion:  result.Manifest.TilecastVersion,
		SchemaVersion:    result.Manifest.SchemaVersion,
		InstallationID:   result.Manifest.InstallationID,
		OrganizationName: result.Manifest.OrganizationName,
		Components:       result.Manifest.Components,
		Verification:     "verified",
		VerifiedAt:       &now,
		CreatedAt:        result.Manifest.CreatedAt,
	})
}

func cliArchiveVerify(ctx context.Context, path string) {
	limits := backup.Limits{}
	if os.Getenv("TILECAST_DATABASE_URL") != "" {
		limits = cliLimits(loadCLIConfig())
	}
	fmt.Printf("Verifying %s...\n", path)
	result, err := backup.Verify(ctx, path, limits)
	if err != nil {
		cliFail("verification failed", err)
	}
	fmt.Printf("Archive is valid.\n")
	printManifestSummary(result.Manifest, result.SizeBytes)
	fmt.Printf("  Archive SHA-256: %s\n", result.ArchiveSHA256)
}

func cliArchiveInspect(ctx context.Context, path string) {
	limits := backup.Limits{}
	if os.Getenv("TILECAST_DATABASE_URL") != "" {
		limits = cliLimits(loadCLIConfig())
	}
	manifest, size, err := backup.Inspect(ctx, path, limits)
	if err != nil {
		cliFail("inspect failed", err)
	}
	printManifestSummary(manifest, size)
	fmt.Println("\nNote: inspect reads only the manifest. Run 'tilecast backup verify' to check every checksum.")
}

func printManifestSummary(manifest backup.Manifest, size int64) {
	fmt.Printf("  Organization: %s\n", manifest.OrganizationName)
	fmt.Printf("  Installation: %s\n", manifest.InstallationID)
	fmt.Printf("  Created: %s\n", manifest.CreatedAt.Format("2006-01-02 15:04:05 MST"))
	fmt.Printf("  Tilecast version: %s\n  Server channel: %s\n  Build commit: %s\n", manifest.TilecastVersion, manifest.ServerChannel, manifest.BuildCommit)
	fmt.Printf("  Schema version: %d\n", manifest.SchemaVersion)
	fmt.Printf("  Archive size: %d bytes\n", size)
	fmt.Printf("  Components:\n")
	for _, component := range manifest.Components {
		fmt.Printf("    %-18s %6d files  %12d bytes\n", component.Name, component.FileCount, component.TotalBytes)
	}
}

func cliRestoreVerify(ctx context.Context, path string) {
	cfg := loadCLIConfig()
	fmt.Printf("Verifying %s...\n", path)
	if _, err := backup.Verify(ctx, path, cliLimits(cfg)); err != nil {
		cliFail("verification failed", err)
	}
	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		cliFail("database connection failed", err)
	}
	defer db.Close()
	plan, err := backup.Plan(ctx, db, path, cliLimits(cfg))
	if err != nil {
		cliFail("restore plan failed", err)
	}
	fmt.Println("Archive is valid and restorable.")
	printManifestSummary(plan.Manifest, plan.SizeBytes)
	fmt.Printf("  Current installation: %s\n", plan.CurrentInstallationID)
	if plan.IdentityMismatch {
		fmt.Println("\nWARNING: this archive belongs to a DIFFERENT installation.")
		fmt.Println("Restoring it replaces this installation's identity; existing players will not reconnect.")
	} else {
		fmt.Println("\nInstallation identity matches. Players can reconnect after restore.")
	}
}

func cliRestoreApply(ctx context.Context, logger *slog.Logger, args []string) {
	flags := flag.NewFlagSet("restore apply", flag.ExitOnError)
	yes := flags.Bool("yes", false, "skip the interactive confirmation")
	confirmMismatch := flags.Bool("confirm-identity-mismatch", false, "restore an archive from a different installation")
	skipPreRestore := flags.Bool("skip-pre-restore-backup", false, "do not create a pre-restore backup first")
	force := flags.Bool("force", false, "proceed even if a running server holds the database lock")
	if err := flags.Parse(args); err != nil {
		os.Exit(2)
	}
	if flags.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: tilecast restore apply [flags] <file>")
		os.Exit(2)
	}
	path := flags.Arg(0)
	cfg := loadCLIConfig()

	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		cliFail("database connection failed", err)
	}
	defer db.Close()

	// Refuse to restore underneath a running server.
	lockConn, err := pgx.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		cliFail("database connection failed", err)
	}
	defer lockConn.Close(context.Background())
	var free bool
	if err := lockConn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, backup.ServerAdvisoryLockID).Scan(&free); err != nil {
		cliFail("check server lock", err)
	}
	if !free && !*force {
		cliFail("cannot restore", errors.New("the Tilecast server appears to be running; stop it first (or pass --force if you are certain it is stopped)"))
	}

	plan, err := backup.Plan(ctx, db, path, cliLimits(cfg))
	if err != nil {
		cliFail("restore plan failed", err)
	}
	fmt.Println("Restore plan:")
	printManifestSummary(plan.Manifest, plan.SizeBytes)
	fmt.Printf("  Current installation: %s\n", plan.CurrentInstallationID)
	if plan.IdentityMismatch {
		fmt.Println("\nWARNING: this archive belongs to a DIFFERENT installation.")
		if !*confirmMismatch {
			cliFail("cannot restore", errors.New("pass --confirm-identity-mismatch to restore an archive from a different installation"))
		}
	}

	if !*yes {
		fmt.Print("\nThis REPLACES the current database and all Tilecast-managed files.\nType RESTORE to continue: ")
		reader := bufio.NewReader(os.Stdin)
		line, _ := reader.ReadString('\n')
		if strings.TrimSpace(line) != "RESTORE" {
			fmt.Println("Restore cancelled.")
			os.Exit(1)
		}
	}

	guard := backup.NewGuard()
	service, err := backup.NewService(db, cfg.Backup.Root, guard)
	if err != nil {
		cliFail("initialize backup service", err)
	}

	fmt.Println("Restoring...")
	result, err := backup.Apply(ctx, backup.ApplyOptions{
		DB:                      db,
		DatabaseURL:             cfg.DatabaseURL,
		MediaRoot:               cfg.Media.Root,
		UpdatesRoot:             cfg.Updates.Root,
		BackupRoot:              cfg.Backup.Root,
		ArchivePath:             path,
		Build:                   version.CurrentBuild(),
		ReservedFreeBytes:       cfg.Backup.ReservedFreeBytes,
		Limits:                  cliLimits(cfg),
		SkipPreRestoreBackup:    *skipPreRestore,
		ConfirmIdentityMismatch: *confirmMismatch,
		Progress: func(phase string, percent int) {
			fmt.Printf("  %-40s %3d%%\n", phase, percent)
		},
		Logger: logger,
	})
	if err != nil {
		cliFail("restore failed", err)
	}
	db.Reset()
	if err := service.ReconcileDisk(ctx); err != nil {
		logger.Warn("post-restore catalog reconciliation failed", "error", err)
	}
	fmt.Println("\nRestore complete.")
	if result.PreRestoreBackup != "" {
		fmt.Printf("A pre-restore backup was saved as %s in the backup root.\n", result.PreRestoreBackup)
	}
	fmt.Println("All browser sessions were signed out. Start the server and check /healthz and /readyz.")
}

// cliMFAReset is the break-glass path for an installation whose only Owner has
// lost every factor. It is deliberately a local command: it requires shell
// access to the server and the database credentials, which is a materially
// higher bar than a password.
func cliMFAReset(ctx context.Context, args []string) {
	flags := flag.NewFlagSet("mfa reset", flag.ExitOnError)
	yes := flags.Bool("yes", false, "skip the interactive confirmation")
	if err := flags.Parse(args); err != nil {
		os.Exit(2)
	}
	if flags.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: tilecast mfa reset [--yes] <username>")
		os.Exit(2)
	}
	username := strings.ToLower(strings.TrimSpace(flags.Arg(0)))
	cfg := loadCLIConfig()

	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		cliFail("database connection failed", err)
	}
	defer db.Close()

	var id uuid.UUID
	var name, role string
	err = db.QueryRow(ctx, `SELECT id,name,role FROM users WHERE lower(username)=$1`, username).Scan(&id, &name, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		cliFail("cannot reset", fmt.Errorf("no account with username %q", username))
	}
	if err != nil {
		cliFail("look up account", err)
	}

	fmt.Printf("Account: %s (%s, %s)\n", name, username, role)
	if !*yes {
		fmt.Print("\nThis removes the authenticator, every passkey, and all recovery codes,\nand signs the account out everywhere.\nType RESET to continue: ")
		reader := bufio.NewReader(os.Stdin)
		line, _ := reader.ReadString('\n')
		if strings.TrimSpace(line) != "RESET" {
			fmt.Println("Reset cancelled.")
			os.Exit(1)
		}
	}

	service := auth.NewService(db, cfg.SessionTTL)
	if err := service.ResetFactors(ctx, id, nil); err != nil {
		cliFail("reset multi-factor enrollment", err)
	}
	fmt.Println("Multi-factor enrollment cleared. The account can sign in with its password and enroll again.")
}
