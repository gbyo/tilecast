package media

import (
	"os"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, database.Migrate)) }
