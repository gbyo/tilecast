package cli

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// This file holds the handwritten administration reads for fleet
// activity: overview, uptime, incidents, and playback compliance. Every
// command here is read-only: none of them prompts, and --window/--from/
// --to pass straight through for the server to validate.

func newActivityCommand(env *environment) *cobra.Command {
	activity := &cobra.Command{Use: "activity", Short: "Read fleet activity, uptime, incidents, and compliance"}
	overview := &cobra.Command{
		Use:   "overview",
		Short: "Show the fleet activity overview for a window",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runActivityOverview(cmd, env)
		},
	}
	addOutputFlags(overview)
	overview.Flags().String("from", "", "Window start (RFC 3339, default 24h ago)")
	overview.Flags().String("to", "", "Window end (RFC 3339, default now)")
	uptime := &cobra.Command{
		Use:   "uptime",
		Short: "Show the fleet uptime report",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runActivityUptime(cmd, env)
		},
	}
	addOutputFlags(uptime)
	uptime.Flags().String("window", "24h", "Report window: 24h, 7d, or 30d")
	incidents := &cobra.Command{
		Use:   "incidents",
		Short: "List incidents (active by default)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runIncidentList(cmd, env)
		},
	}
	addOutputFlags(incidents)
	incidents.Flags().String("status", "", "Filter: open, acknowledged, recovered, resolved, ignored, or all")
	incidents.Flags().String("severity", "", "Filter: info, warning, error, or critical")
	incidents.Flags().String("type", "", "Filter by incident type")
	incident := &cobra.Command{
		Use:   "incident",
		Short: "Inspect one incident",
	}
	incidentGet := &cobra.Command{
		Use:   "get <id>",
		Short: "Show one incident with its timeline",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runIncidentGet(cmd, env, args[0])
		},
	}
	addOutputFlags(incidentGet)
	incident.AddCommand(incidentGet)
	compliance := &cobra.Command{
		Use:   "compliance",
		Short: "Show expected-versus-actual playback compliance",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPlaybackCompliance(cmd, env)
		},
	}
	addOutputFlags(compliance)
	compliance.Flags().String("from", "", "Window start (RFC 3339, default 24h ago)")
	compliance.Flags().String("to", "", "Window end (RFC 3339, default now)")
	activity.AddCommand(overview, uptime, incidents, incident, compliance)
	return activity
}

func activityWindowFlags(cmd *cobra.Command) (string, string) {
	from, _ := cmd.Flags().GetString("from")
	to, _ := cmd.Flags().GetString("to")
	return from, to
}

// printActivityJSON renders a read payload: --json prints the data
// member, human prints it indented. Activity payloads are server-shaped
// reports, so generic JSON is the honest rendering.
func printActivityJSON(cmd *cobra.Command, status int, body []byte) error {
	var data any
	if err := apiclient.DecodeBody(status, body, &data); err != nil {
		return err
	}
	return printData(cmd, data, func() string {
		raw, _ := json.MarshalIndent(data, "", "  ")
		return string(raw)
	})
}

func runActivityOverview(cmd *cobra.Command, env *environment) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	from, to := activityWindowFlags(cmd)
	status, body, err := transport.ActivityOverview(ctx, from, to)
	if err != nil {
		return err
	}
	return printActivityJSON(cmd, status, body)
}

func runActivityUptime(cmd *cobra.Command, env *environment) error {
	window, _ := cmd.Flags().GetString("window")
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.ActivityUptime(ctx, window)
	if err != nil {
		return err
	}
	return printActivityJSON(cmd, status, body)
}

type incidentRecord map[string]any

func runIncidentList(cmd *cobra.Command, env *environment) error {
	statusFilter, _ := cmd.Flags().GetString("status")
	severity, _ := cmd.Flags().GetString("severity")
	incidentType, _ := cmd.Flags().GetString("type")
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.ListIncidents(ctx, statusFilter, severity, incidentType)
	if err != nil {
		return err
	}
	var data struct {
		Items []incidentRecord `json:"items"`
	}
	if err := apiclient.DecodeBody(status, body, &data); err != nil {
		return err
	}
	sort.Slice(data.Items, func(i, j int) bool {
		return incidentField(data.Items[i], "openedAt") > incidentField(data.Items[j], "openedAt")
	})
	return printData(cmd, data.Items, func() string {
		var out strings.Builder
		writer := tabwriter.NewWriter(&out, 0, 4, 2, ' ', 0)
		for _, item := range data.Items {
			id, _ := item["id"].(string)
			short := id
			if len(short) > 8 {
				short = short[:8]
			}
			_, _ = writer.Write([]byte(short + "\t" + incidentField(item, "severity") + "\t" + incidentField(item, "status") + "\t" + incidentField(item, "title") + "\n"))
		}
		_ = writer.Flush()
		return "ID\tSEVERITY\tSTATUS\tTITLE\n" + strings.TrimSuffix(out.String(), "\n")
	})
}

func incidentField(record incidentRecord, key string) string {
	value, _ := record[key].(string)
	return value
}

func runIncidentGet(cmd *cobra.Command, env *environment, id string) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.GetIncident(ctx, id)
	if err != nil {
		return err
	}
	var record incidentRecord
	if err := apiclient.DecodeBody(status, body, &record); err != nil {
		return err
	}
	return printData(cmd, record, func() string {
		var out strings.Builder
		out.WriteString("title=" + incidentField(record, "title") + "\n")
		out.WriteString(fmt.Sprintf("status=%s severity=%s\n", incidentField(record, "status"), incidentField(record, "severity")))
		if timeline, ok := record["timeline"].([]any); ok {
			fmt.Fprintf(&out, "timelineEvents=%d", len(timeline))
		}
		return strings.TrimSuffix(out.String(), "\n")
	})
}

func runPlaybackCompliance(cmd *cobra.Command, env *environment) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	from, to := activityWindowFlags(cmd)
	status, body, err := transport.PlaybackCompliance(ctx, from, to)
	if err != nil {
		return err
	}
	return printActivityJSON(cmd, status, body)
}
