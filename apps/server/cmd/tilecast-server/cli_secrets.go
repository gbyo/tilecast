package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/tilecast/tilecast/apps/server/internal/backup"
	"github.com/tilecast/tilecast/apps/server/internal/config"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
)

// cliSecrets runs the plugin secret key commands. They read the same
// TILECAST_* variables as the server and never print key material.
func cliSecrets(ctx context.Context, logger *slog.Logger, args []string) {
	cfg := loadCLIConfig()
	if args[0] == "export-kek" || args[0] == "import-kek" {
		if len(args) != 2 {
			fmt.Fprintf(os.Stderr, "usage: tilecast-server secrets %s <file>\n", args[0])
			os.Exit(2)
		}
	}
	ring, err := pluginsecrets.Load(cfg.SecretsKeyFile)
	if err != nil {
		cliFail("read "+pluginsecrets.KeyFileEnvironmentVariable, err)
	}
	switch args[0] {
	case "export-kek":
		forbidden := []string{cfg.Backup.Root, cfg.Media.Root, cfg.Updates.Root, cfg.Packages.Root}
		if err := ring.Export(args[1], forbidden); err != nil {
			cliFail("export the key encryption keys", err)
		}
		fmt.Printf("Wrote %d key encryption key(s) to %s.\n", len(ring.IDs()), args[1])
		fmt.Println("Store this file apart from Tilecast backups. Anyone with it and a backup can read the plugin secrets.")
		fmt.Println("Then confirm the export in Studio (Settings, Plugin secrets) so Owners stop seeing the warning.")
		return
	case "import-kek":
		added, err := ring.Import(args[1])
		if err != nil {
			cliFail("import key encryption keys", err)
		}
		fmt.Printf("Added %d key encryption key(s): %s\n", len(added), strings.Join(added, ", "))
		return
	}
	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		cliFail("database connection failed", err)
	}
	defer db.Close()
	store := pluginsecrets.NewStore(db, ring, logger)
	switch args[0] {
	case "status":
		status, err := store.Status(ctx)
		if err != nil {
			cliFail("read the secret store", err)
		}
		fmt.Printf("Key file:            %s\n", ring.Path())
		fmt.Printf("Current KEK:         %s\n", status.CurrentKEKID)
		fmt.Printf("KEKs in the file:    %s\n", strings.Join(status.KEKIDs, ", "))
		fmt.Printf("Export confirmed:    %t\n", status.ExportAcknowledged)
		fmt.Printf("Stored secrets:      %d\n", status.Secrets)
		fmt.Printf("Awaiting new DEK:    %d\n", status.PendingMigration)
		fmt.Printf("Unreadable here:     %d\n", status.Unreadable)
	case "rotate-kek":
		// The new KEK is written to the file first, so a crash at any point
		// leaves every DEK wrapped with a KEK the file still holds. Running
		// the command again finishes the rewrap.
		kek, err := ring.AddKEK()
		if err != nil {
			cliFail("add a key encryption key", err)
		}
		rewrapped, missing, err := store.RewrapDEKs(ctx)
		if err != nil {
			cliFail("rewrap data encryption keys (run the command again to finish)", err)
		}
		fmt.Printf("Current KEK is now %s. Rewrapped %d data encryption key(s).\n", kek.ID, rewrapped)
		if len(missing) > 0 {
			fmt.Printf("Some DEKs use KEKs this installation does not hold and were left as they are: %s\n", strings.Join(missing, ", "))
		}
		fmt.Println("Older KEKs stay in the key file until you run prune-keks. Export the keys again now:")
		fmt.Println("  tilecast-server secrets export-kek <new file>")
	case "rotate-dek":
		id, err := store.RotateDEK(ctx)
		if err != nil {
			cliFail("rotate the data encryption key", err)
		}
		fmt.Printf("New secrets now use DEK %s. The server moves existing secrets to it in the background.\n", id)
		if len(args) > 1 && args[1] == "--migrate-now" {
			moved, err := store.MigrateAll(ctx, 100)
			if err != nil {
				cliFail("move secrets to the new DEK (the server resumes this)", err)
			}
			fmt.Printf("Moved %d secret(s).\n", moved)
		}
	case "prune-keks":
		inUse, err := store.KEKsInUse(ctx, db)
		if err != nil {
			cliFail("read the KEKs in use", err)
		}
		removed, err := ring.Prune(inUse)
		if err != nil {
			cliFail("prune key encryption keys", err)
		}
		fmt.Printf("Removed %d key encryption key(s) that no DEK uses: %s\n", len(removed), strings.Join(removed, ", "))
		if len(removed) > 0 {
			fmt.Println("Backups made before the last rotate-kek need an export that still holds the removed keys.")
		}
	default:
		printUsage()
		os.Exit(2)
	}
}

// cliSecretKEKIDs lists the KEKs this installation holds, or none when the
// key file is missing or unusable.
func cliSecretKEKIDs(cfg config.Config) []string {
	ring, err := pluginsecrets.Load(cfg.SecretsKeyFile)
	if err != nil {
		return nil
	}
	return ring.IDs()
}

// printSecretCheck names each plugin setting whose secrets a restore would
// leave unreadable. It never prints a value.
func printSecretCheck(check backup.SecretRestoreCheck) {
	fmt.Println("\nWARNING: some plugin secrets in this archive need keys this server does not hold:")
	fmt.Printf("  Missing KEKs: %s\n", strings.Join(check.MissingKEKIDs, ", "))
	for _, location := range check.Unreadable {
		fmt.Printf("  %s: %s setting %q (%d)\n", location.PluginID, location.OwnerType, location.Key, location.Count)
	}
	fmt.Println("After the restore these settings show \"needs a new value\" until someone enters them again.")
}
