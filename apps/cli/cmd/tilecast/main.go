// Command tilecast is the Tilecast remote management CLI.
//
// It talks to a Tilecast Server over the supported HTTP API. It never links
// Server internals, PostgreSQL code, or plugin implementation packages; the
// boundary test in internal/cli enforces that.
package main

import (
	"os"

	"github.com/tilecast/tilecast/apps/cli/internal/cli"
)

func main() {
	if err := cli.Main(os.Args[1:]); err != nil {
		os.Exit(1)
	}
}
