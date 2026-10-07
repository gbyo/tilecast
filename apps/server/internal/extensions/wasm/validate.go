package wasm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// ValidatePackageRuntime checks the version 2 runtime declarations
// against extracted package content: the module file exists, fits the
// size cap, and passes shape inspection, and the Studio entry exists
// within its cap. The manifest itself already validated; this is the
// content half of install validation.
func ValidatePackageRuntime(contentDir string, manifest packagemanifest.Manifest) error {
	if manifest.Runtime == nil && manifest.Capabilities == nil {
		return nil
	}
	jobs := manifest.Capabilities != nil && manifest.Capabilities.Background != nil
	studio := manifest.Capabilities != nil && manifest.Capabilities.StudioUI != nil
	if manifest.Runtime != nil {
		modulePath, err := contain(contentDir, manifest.Runtime.Module)
		if err != nil {
			return fmt.Errorf("runtime module: %v", err)
		}
		module, err := Inspect(modulePath)
		if err != nil {
			return fmt.Errorf("runtime module: %v", err)
		}
		if jobs && !isFuncExport(module, "run_job") {
			return fmt.Errorf("runtime module: background jobs require an exported run_job function")
		}
		if studio && !isFuncExport(module, "handle_ui_request") {
			return fmt.Errorf("runtime module: Studio UI calls require an exported handle_ui_request function")
		}
	}
	if studio {
		entryPath, err := contain(contentDir, manifest.Capabilities.StudioUI.Entry)
		if err != nil {
			return fmt.Errorf("Studio UI entry: %v", err)
		}
		info, err := os.Stat(entryPath)
		if err != nil || info.IsDir() || info.Size() == 0 || info.Size() > MaxStudioEntryBytes {
			return fmt.Errorf("Studio UI entry: must hold 1 to %d bytes", MaxStudioEntryBytes)
		}
	}
	return nil
}

// isFuncExport reports whether the module exports a function by name.
// Presence matters: a missing export reads the zero value, which equals
// the function kind.
func isFuncExport(module Module, name string) bool {
	kind, ok := module.Exports[name]
	return ok && kind == 0
}

// contain joins a manifest path under the content directory and refuses
// anything that escapes it.
func contain(contentDir, declared string) (string, error) {
	joined := filepath.Join(contentDir, declared)
	rel, err := filepath.Rel(contentDir, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%q escapes the package", declared)
	}
	return joined, nil
}
