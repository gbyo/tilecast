package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

var databaseNamePart = regexp.MustCompile(`[^a-z0-9_]+`)

// Run gives one Go test package a temporary PostgreSQL database. PostgreSQL
// advisory locks are scoped to a database, so existing fixture locks remain
// effective inside a package without serializing other packages.
func Run(m *testing.M, migrate func(context.Context, string) error) (exitCode int) {
	baseURL := os.Getenv("TEST_DATABASE_URL")
	if baseURL == "" {
		return m.Run()
	}

	setupCtx, cancelSetup := context.WithTimeout(context.Background(), time.Minute)
	testURL, cleanup, err := createDatabase(setupCtx, baseURL, packageName())
	cancelSetup()
	if err != nil {
		fmt.Fprintf(os.Stderr, "prepare package test database: %v\n", err)
		return 1
	}

	previousURL, hadPreviousURL := os.LookupEnv("TEST_DATABASE_URL")
	if err := os.Setenv("TEST_DATABASE_URL", testURL); err != nil {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancelCleanup()
		if cleanupErr := cleanup(cleanupCtx); cleanupErr != nil {
			fmt.Fprintf(os.Stderr, "remove package test database: %v\n", cleanupErr)
		}
		fmt.Fprintf(os.Stderr, "set package test database URL: %v\n", err)
		return 1
	}
	defer func() {
		if hadPreviousURL {
			_ = os.Setenv("TEST_DATABASE_URL", previousURL)
		} else {
			_ = os.Unsetenv("TEST_DATABASE_URL")
		}
	}()
	defer func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancelCleanup()
		if cleanupErr := cleanup(cleanupCtx); cleanupErr != nil {
			fmt.Fprintf(os.Stderr, "remove package test database: %v\n", cleanupErr)
			if exitCode == 0 {
				exitCode = 1
			}
		}
	}()

	migrateCtx, cancelMigrate := context.WithTimeout(context.Background(), time.Minute)
	err = migrate(migrateCtx, testURL)
	cancelMigrate()
	if err != nil {
		fmt.Fprintf(os.Stderr, "migrate package test database: %v\n", err)
		return 1
	}

	return m.Run()
}

func createDatabase(ctx context.Context, baseURL, packageName string) (string, func(context.Context) error, error) {
	baseConfig, err := pgx.ParseConfig(baseURL)
	if err != nil {
		return "", nil, fmt.Errorf("parse TEST_DATABASE_URL: %w", err)
	}

	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", nil, fmt.Errorf("generate temporary database name: %w", err)
	}
	name := fmt.Sprintf("tilecast_test_%s_%s", normalizePackageName(packageName), hex.EncodeToString(suffix[:]))
	admin, err := pgx.ConnectConfig(ctx, baseConfig.Copy())
	if err != nil {
		return "", nil, fmt.Errorf("connect to test database: %w", err)
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE "%s" TEMPLATE template0`, name)); err != nil {
		_ = admin.Close(ctx)
		return "", nil, fmt.Errorf("create temporary database %s: %w", name, err)
	}

	cleanup := func(cleanupCtx context.Context) error {
		_, dropErr := admin.Exec(cleanupCtx, fmt.Sprintf(`DROP DATABASE IF EXISTS "%s" WITH (FORCE)`, name))
		closeErr := admin.Close(cleanupCtx)
		return errors.Join(dropErr, closeErr)
	}
	testURL, err := databaseURLFor(baseURL, name)
	if err != nil {
		_ = cleanup(ctx)
		return "", nil, err
	}
	return testURL, cleanup, nil
}

func databaseURLFor(baseURL, databaseName string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("parse TEST_DATABASE_URL: %w", err)
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return "", fmt.Errorf("TEST_DATABASE_URL must use a postgres URL")
	}
	parsed.Path = "/" + databaseName
	parsed.RawPath = ""
	return parsed.String(), nil
}

func packageName() string {
	workingDirectory, err := os.Getwd()
	if err != nil {
		return "package"
	}
	return filepath.Base(workingDirectory)
}

func normalizePackageName(name string) string {
	name = strings.ToLower(name)
	name = databaseNamePart.ReplaceAllString(name, "_")
	name = strings.Trim(name, "_")
	if name == "" {
		return "package"
	}
	if len(name) > 24 {
		return name[:24]
	}
	return name
}
