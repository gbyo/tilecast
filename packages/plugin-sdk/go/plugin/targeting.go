package plugin

import (
	"fmt"
	"regexp"

	"github.com/google/uuid"
)

// Target scopes. The four scopes and their bounds are a property of Tilecast
// targeting, not of any one plugin.
const (
	TargetAll        = "all"
	TargetScreens    = "screens"
	TargetSyncGroups = "sync_groups"
	TargetLocations  = "locations"
)

// MaxTargets bounds one instance's explicit targets.
const MaxTargets = 250

// Target is an instance's screen targeting as stored by plugins that follow
// the targeting convention: an instances table with a target_scope column
// and a targets table of (instance_id, target_type, target_id).
type Target struct {
	Scope string
	IDs   []uuid.UUID
}

// Validate checks the shape of a target without touching the database.
func (t Target) Validate() error {
	switch t.Scope {
	case TargetAll:
		if len(t.IDs) != 0 {
			return fmt.Errorf("%w: all-screen targeting cannot include targetIds", ErrInvalid)
		}
	case TargetScreens, TargetSyncGroups, TargetLocations:
		if len(t.IDs) == 0 || len(t.IDs) > MaxTargets {
			return fmt.Errorf("%w: targeted instances require between one and %d targets", ErrInvalid, MaxTargets)
		}
	default:
		return fmt.Errorf("%w: targetScope is invalid", ErrInvalid)
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range t.IDs {
		if seen[id] {
			return fmt.Errorf("%w: targetIds must be unique", ErrInvalid)
		}
		seen[id] = true
	}
	return nil
}

var tableName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// ScreenTargetFilter returns `FROM <instances> i WHERE i.enabled AND (...)`:
// the enabled instances that apply to the screen bound to $1. Both names must
// be the plugin's own table literals; anything else panics, because this is
// SQL text.
func ScreenTargetFilter(instancesTable, targetsTable string) string {
	if !tableName.MatchString(instancesTable) || !tableName.MatchString(targetsTable) {
		panic("plugin: ScreenTargetFilter needs table name literals")
	}
	return fmt.Sprintf(`FROM %s i
		WHERE i.enabled AND (
			i.target_scope='all'
			OR (i.target_scope='screens' AND EXISTS(
				SELECT 1 FROM %s t WHERE t.instance_id=i.id AND t.target_type='screens' AND t.target_id=$1))
			OR (i.target_scope='locations' AND EXISTS(
				SELECT 1 FROM %s t JOIN screens sc ON sc.id=$1 AND sc.location_id=t.target_id
				WHERE t.instance_id=i.id AND t.target_type='locations'))
			OR (i.target_scope='sync_groups' AND EXISTS(
				SELECT 1 FROM %s t JOIN screen_group_memberships m ON m.screen_id=$1 AND m.screen_group_id=t.target_id
				WHERE t.instance_id=i.id AND t.target_type='sync_groups'))
		)`, instancesTable, targetsTable, targetsTable, targetsTable)
}
