package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	apiclient "github.com/tilecast/tilecast/packages/api-client"
)

// This file holds the handwritten content group (playlists) and
// scheduling group (schedules). Publishing is sensitive and confirms;
// reads never do. Playlists are addressed by UUID: unlike screen names,
// playlist names carry no uniqueness promise worth guessing on.

type playlistRecord map[string]any

func playlistID(record playlistRecord) string {
	value, _ := record["id"].(string)
	return value
}

func playlistName(record playlistRecord) string {
	value, _ := record["name"].(string)
	return value
}

func newPlaylistCommand(env *environment) *cobra.Command {
	playlist := &cobra.Command{Use: "playlist", Short: "List, inspect, and publish playlists"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List playlists",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPlaylistList(cmd, env)
		},
	}
	addOutputFlags(list)
	list.Flags().String("search", "", "Filter playlists by name")
	list.Flags().Int("page", 0, "Page number (starts at 1)")
	list.Flags().Int("page-size", 0, "Page size")
	get := &cobra.Command{
		Use:   "get <id>",
		Short: "Show one playlist draft",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPlaylistGet(cmd, env, args[0])
		},
	}
	addOutputFlags(get)
	publish := &cobra.Command{
		Use:   "publish <id>",
		Short: "Publish the current draft (reads it first; conflicts are errors)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPlaylistPublish(cmd, env, args[0])
		},
	}
	addOutputFlags(publish)
	publish.Flags().Int64("expected-revision", 0, "Publish this draft revision instead of the one read now")
	publish.Flags().Bool("yes", false, "Proceed without an interactive confirmation")
	playlist.AddCommand(list, get, publish)
	return playlist
}

func playlistPageFlags(cmd *cobra.Command) (string, int, int) {
	search, _ := cmd.Flags().GetString("search")
	page, _ := cmd.Flags().GetInt("page")
	pageSize, _ := cmd.Flags().GetInt("page-size")
	return search, page, pageSize
}

func runPlaylistList(cmd *cobra.Command, env *environment) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	search, page, pageSize := playlistPageFlags(cmd)
	status, body, err := transport.ListPlaylists(ctx, search, page, pageSize)
	if err != nil {
		return err
	}
	var data struct {
		Items []playlistRecord `json:"items"`
		Total int              `json:"total"`
	}
	if err := apiclient.DecodeBody(status, body, &data); err != nil {
		return err
	}
	sort.Slice(data.Items, func(i, j int) bool { return playlistName(data.Items[i]) < playlistName(data.Items[j]) })
	return printData(cmd, data.Items, func() string {
		var out strings.Builder
		writer := tabwriter.NewWriter(&out, 0, 4, 2, ' ', 0)
		for _, item := range data.Items {
			changes := "no"
			if unpublished, _ := item["hasUnpublishedChanges"].(bool); unpublished {
				changes = "yes"
			}
			_, _ = writer.Write([]byte(playlistID(item) + "\t" + playlistName(item) + "\t" + changes + "\n"))
		}
		_ = writer.Flush()
		return "ID\tNAME\tUNPUBLISHED\n" + strings.TrimSuffix(out.String(), "\n")
	})
}

func runPlaylistGet(cmd *cobra.Command, env *environment, id string) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	record, err := fetchPlaylist(ctx, transport, id)
	if err != nil {
		return err
	}
	return printData(cmd, record, func() string {
		var out strings.Builder
		out.WriteString("name=" + playlistName(record) + "\n")
		if revision, ok := record["draftRevision"].(float64); ok {
			fmt.Fprintf(&out, "draftRevision=%d\n", int64(revision))
		}
		if unpublished, _ := record["hasUnpublishedChanges"].(bool); unpublished {
			out.WriteString("hasUnpublishedChanges=true\n")
		}
		if items, ok := record["items"].([]any); ok {
			fmt.Fprintf(&out, "items=%d", len(items))
		}
		return strings.TrimSuffix(out.String(), "\n")
	})
}

func fetchPlaylist(ctx context.Context, transport *apiclient.Client, id string) (playlistRecord, error) {
	status, body, err := transport.GetPlaylist(ctx, id)
	if err != nil {
		return nil, err
	}
	var record playlistRecord
	if err := apiclient.DecodeBody(status, body, &record); err != nil {
		return nil, err
	}
	return record, nil
}

func runPlaylistPublish(cmd *cobra.Command, env *environment, id string) error {
	expected, _ := cmd.Flags().GetInt64("expected-revision")
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	revision := expected
	if revision <= 0 {
		// Publish the draft actually read: carrying its revision turns a
		// concurrent publish into a clean 409 instead of a silent win.
		draft, err := fetchPlaylist(ctx, transport, id)
		if err != nil {
			return err
		}
		if unpublished, _ := draft["hasUnpublishedChanges"].(bool); !unpublished {
			if !quietFlag(cmd) {
				fmt.Fprintf(cmd.ErrOrStderr(), "%s has no unpublished changes\n", playlistName(draft))
			}
			return printData(cmd, draft, func() string {
				return fmt.Sprintf("already published %s", playlistName(draft))
			})
		}
		rawRevision, _ := draft["draftRevision"].(float64)
		revision = int64(rawRevision)
		if revision <= 0 {
			return fmt.Errorf("the server did not report a draft revision; pass --expected-revision explicitly")
		}
	}
	if err := confirmChange(cmd, "publish this playlist draft? Players pick it up."); err != nil {
		return err
	}
	status, body, err := transport.PublishPlaylist(ctx, id, int(revision))
	if err != nil {
		return err
	}
	if status == http.StatusAccepted {
		var submission any
		if err := apiclient.DecodeBody(status, body, &submission); err != nil {
			return err
		}
		if !quietFlag(cmd) {
			fmt.Fprintln(cmd.ErrOrStderr(), "under editorial review: published nothing, kept the submission")
		}
		return printData(cmd, submission, func() string {
			return "submitted for review"
		})
	}
	var result any
	if err := apiclient.DecodeBody(status, body, &result); err != nil {
		var conflict *apiclient.ConflictError
		if errors.As(err, &conflict) {
			return fmt.Errorf("%w (the draft moved since it was read; run playlist get and publish again)", err)
		}
		return err
	}
	return printData(cmd, result, func() string {
		return fmt.Sprintf("published %s", id)
	})
}

type scheduleRecord map[string]any

func scheduleID(record scheduleRecord) string {
	value, _ := record["id"].(string)
	return value
}

func scheduleName(record scheduleRecord) string {
	value, _ := record["name"].(string)
	return value
}

func newScheduleCommand(env *environment) *cobra.Command {
	schedule := &cobra.Command{Use: "schedule", Short: "List, inspect, and create schedules"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List schedules",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScheduleList(cmd, env)
		},
	}
	addOutputFlags(list)
	list.Flags().String("search", "", "Filter schedules by name")
	list.Flags().Int("page", 0, "Page number (starts at 1)")
	list.Flags().Int("page-size", 0, "Page size")
	get := &cobra.Command{
		Use:   "get <id>",
		Short: "Show one schedule",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScheduleGet(cmd, env, args[0])
		},
	}
	addOutputFlags(get)
	create := &cobra.Command{
		Use:   "create",
		Short: "Create a schedule from a JSON document",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScheduleCreate(cmd, env)
		},
	}
	addOutputFlags(create)
	create.Flags().String("input", "", "Schedule document as JSON")
	create.Flags().String("file", "", "Read the schedule document from this file")
	schedule.AddCommand(list, get, create)
	return schedule
}

func runScheduleList(cmd *cobra.Command, env *environment) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	search, page, pageSize := playlistPageFlags(cmd)
	status, body, err := transport.ListSchedules(ctx, search, page, pageSize)
	if err != nil {
		return err
	}
	var data struct {
		Items []scheduleRecord `json:"items"`
		Total int              `json:"total"`
	}
	if err := apiclient.DecodeBody(status, body, &data); err != nil {
		return err
	}
	sort.Slice(data.Items, func(i, j int) bool { return scheduleName(data.Items[i]) < scheduleName(data.Items[j]) })
	return printData(cmd, data.Items, func() string {
		var out strings.Builder
		writer := tabwriter.NewWriter(&out, 0, 4, 2, ' ', 0)
		for _, item := range data.Items {
			_, _ = writer.Write([]byte(scheduleID(item) + "\t" + scheduleName(item) + "\n"))
		}
		_ = writer.Flush()
		return "ID\tNAME\n" + strings.TrimSuffix(out.String(), "\n")
	})
}

func runScheduleGet(cmd *cobra.Command, env *environment, id string) error {
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.GetSchedule(ctx, id)
	if err != nil {
		return err
	}
	var record scheduleRecord
	if err := apiclient.DecodeBody(status, body, &record); err != nil {
		return err
	}
	return printData(cmd, record, func() string {
		raw, _ := json.MarshalIndent(record, "", "  ")
		return string(raw)
	})
}

func runScheduleCreate(cmd *cobra.Command, env *environment) error {
	document, err := readAutomationInput(cmd)
	if err != nil {
		return err
	}
	resolved, err := env.resolver(cmd).Resolve(true)
	if err != nil {
		return err
	}
	transport, ctx, cancel, err := env.transport(cmd, resolved)
	if err != nil {
		return err
	}
	defer cancel()
	status, body, err := transport.CreateSchedule(ctx, document)
	if err != nil {
		return err
	}
	var record scheduleRecord
	if err := apiclient.DecodeBody(status, body, &record); err != nil {
		return err
	}
	return printData(cmd, record, func() string {
		return fmt.Sprintf("created %s (%s)", scheduleName(record), scheduleID(record))
	})
}
