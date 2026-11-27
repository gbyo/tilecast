// Command gen writes the plugin SDK's typed Server service client from the
// service registry. Run it from apps/server:
//
//	go run ./internal/extensions/services/gen
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
)

func main() {
	for _, file := range []struct {
		path   string
		render func() ([]byte, error)
	}{{services.BundledClientPath, services.BundledClientSource}, {services.BundledCatalogPath, services.BundledCatalogSource}} {
		source, err := file.render()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := os.WriteFile(filepath.Join("..", "..", file.path), source, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
