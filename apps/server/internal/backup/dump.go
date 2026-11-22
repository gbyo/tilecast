package backup

import (
	"compress/gzip"
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
)

// snapshotInfo carries everything read from the database inside one
// REPEATABLE READ snapshot.
type snapshotInfo struct {
	SchemaVersion    int64
	InstallationID   string
	OrganizationName string
	Tables           []TableDump
	Sequences        []SequenceState
	PluginSecrets    *PluginSecretsManifest
}

// dumpDatabase writes one gzipped COPY dump per table into the archive from
// a single repeatable-read snapshot, so every table reflects the same moment
// in time. Table dumps are spooled to a temporary file first because tar
// headers need the exact size up front.
func dumpDatabase(ctx context.Context, db *pgxpool.Pool, writer *archiveWriter, spoolDir string, progress func(string)) (snapshotInfo, error) {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return snapshotInfo{}, fmt.Errorf("acquire database connection: %w", err)
	}
	defer conn.Release()

	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return snapshotInfo{}, fmt.Errorf("begin snapshot transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var info snapshotInfo
	if err := tx.QueryRow(ctx, `SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY id DESC LIMIT 1`).Scan(&info.SchemaVersion); err != nil {
		return snapshotInfo{}, fmt.Errorf("read schema version: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT installation_id, organization_name FROM organization_settings WHERE singleton`).Scan(&info.InstallationID, &info.OrganizationName); err != nil {
		return snapshotInfo{}, fmt.Errorf("read installation identity (has setup completed?): %w", err)
	}
	// Encrypted plugin secrets ride in the snapshot; the manifest names the
	// KEKs they need so a restore can check for them first.
	locations, err := pluginsecrets.Locations(ctx, tx)
	if err != nil {
		return snapshotInfo{}, fmt.Errorf("read plugin secret locations: %w", err)
	}
	if len(locations) > 0 {
		info.PluginSecrets = &PluginSecretsManifest{Locations: locations}
		seen := map[string]bool{}
		for _, location := range locations {
			if !seen[location.KEKID] {
				seen[location.KEKID] = true
				info.PluginSecrets.RequiredKEKIDs = append(info.PluginSecrets.RequiredKEKIDs, location.KEKID)
			}
		}
		sort.Strings(info.PluginSecrets.RequiredKEKIDs)
	}

	tableNames, err := listBaseTables(ctx, tx)
	if err != nil {
		return snapshotInfo{}, err
	}

	for _, table := range tableNames {
		if progress != nil {
			progress(table)
		}
		var rows int64
		if err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s`, quoteIdentifier(table))).Scan(&rows); err != nil {
			return snapshotInfo{}, fmt.Errorf("count rows in %s: %w", table, err)
		}
		archivePath := databasePrefix + table + ".copy.gz"
		if err := spoolTableDump(ctx, tx, writer, spoolDir, table, archivePath); err != nil {
			return snapshotInfo{}, err
		}
		info.Tables = append(info.Tables, TableDump{Name: table, Rows: rows, ArchivePath: archivePath})
	}

	sequences, err := listSequences(ctx, tx)
	if err != nil {
		return snapshotInfo{}, err
	}
	info.Sequences = sequences

	if err := tx.Commit(ctx); err != nil {
		return snapshotInfo{}, fmt.Errorf("close snapshot transaction: %w", err)
	}
	return info, nil
}

func spoolTableDump(ctx context.Context, tx pgx.Tx, writer *archiveWriter, spoolDir, table, archivePath string) error {
	spool, err := os.CreateTemp(spoolDir, "table-*.copy.gz")
	if err != nil {
		return fmt.Errorf("create table spool file: %w", err)
	}
	spoolPath := spool.Name()
	defer os.Remove(spoolPath)
	defer spool.Close()

	gz, err := gzip.NewWriterLevel(spool, gzip.BestSpeed)
	if err != nil {
		return fmt.Errorf("start table compression: %w", err)
	}
	copySQL := fmt.Sprintf(`COPY %s TO STDOUT`, quoteIdentifier(table))
	if _, err := tx.Conn().PgConn().CopyTo(ctx, gz, copySQL); err != nil {
		return fmt.Errorf("dump table %s: %w", table, err)
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("finish table compression for %s: %w", table, err)
	}
	stat, err := spool.Stat()
	if err != nil {
		return fmt.Errorf("stat table spool file: %w", err)
	}
	if _, err := spool.Seek(0, 0); err != nil {
		return fmt.Errorf("rewind table spool file: %w", err)
	}
	return writer.addFile(archivePath, stat.Size(), stat.ModTime(), spool)
}

func listBaseTables(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'goose_db_version' ORDER BY tablename`)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan table name: %w", err)
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

func listSequences(ctx context.Context, tx pgx.Tx) ([]SequenceState, error) {
	rows, err := tx.Query(ctx, `SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`)
	if err != nil {
		return nil, fmt.Errorf("list sequences: %w", err)
	}
	defer rows.Close()
	var sequences []SequenceState
	for rows.Next() {
		var name string
		var last *int64
		if err := rows.Scan(&name, &last); err != nil {
			return nil, fmt.Errorf("scan sequence: %w", err)
		}
		state := SequenceState{Name: name, Value: 1, IsCalled: false}
		if last != nil {
			state.Value = *last
			state.IsCalled = true
		}
		sequences = append(sequences, state)
	}
	return sequences, rows.Err()
}

// quoteIdentifier safely quotes a PostgreSQL identifier.
func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// tableFromArchivePath maps a db/ archive entry back to its table name.
func tableFromArchivePath(path string) (string, bool) {
	if !strings.HasPrefix(path, databasePrefix) || !strings.HasSuffix(path, ".copy.gz") {
		return "", false
	}
	name := strings.TrimSuffix(strings.TrimPrefix(path, databasePrefix), ".copy.gz")
	if name == "" || strings.Contains(name, "/") {
		return "", false
	}
	return name, true
}
