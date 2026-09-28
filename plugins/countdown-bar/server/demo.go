package server

import (
	"context"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var _ plugin.DemoSeeder = (*Plugin)(nil)

// SeedDemo adds a weekday lunch countdown to the demo schools.
func (p *Plugin) SeedDemo(ctx context.Context, demo plugin.Demo) error {
	targets := []uuid.UUID{}
	for _, name := range []string{"high_school", "middle_school"} {
		if id, ok := demo.Locations[name]; ok {
			targets = append(targets, id)
		}
	}
	scope := plugin.TargetLocations
	if len(targets) == 0 {
		scope = plugin.TargetAll
	}
	lunchEnds := "12:55"
	padding := 4
	_, err := p.Create(ctx, demo.OwnerID, Input{
		Name: "Lunch ends", Message: "Lunch ends in", ScheduleType: "weekly", TargetTime: &lunchEnds, DaysOfWeek: []int{1, 2, 3, 4, 5},
		Timezone: demo.Timezone, LeadTimeSeconds: 900, DisplayMode: "overlay", HeightPX: 72, ProgressFill: "none", ContentPadding: &padding,
		TextScale: 100, Enabled: true, StartingSoonSeconds: 300, UrgentSeconds: 60, PulseSeconds: 10,
		TargetScope: scope, TargetIDs: targets,
	})
	return err
}
