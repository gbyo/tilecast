// Package fleetops applies one change to many screens.
//
// The loop is the easy part. What this package exists for is the preview: a
// screen that belongs to a sync group shares that group's assignment, so
// assigning one member assigns every member. An operator selecting six screens
// can change sixty. Showing that before the change, and being able to put it
// back afterwards, is the whole feature.
package fleetops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
)

// Actions this package can apply.
const (
	ActionAssignPlaylist  = "assign_playlist"
	ActionAssignLayout    = "assign_layout"
	ActionClearAssignment = "clear_assignment"
	ActionSetEnabled      = "set_enabled"
	ActionSendCommand     = "send_command"
)

// UndoWindow is how long an operation can be reversed.
const UndoWindow = 15 * time.Minute

// MaxScreensPerOperation bounds one operation. A request larger than this is
// refused rather than run, because a half-applied change across a whole
// installation is worse than a rejected one.
const MaxScreensPerOperation = 500

var (
	// ErrValidation marks a bad request.
	ErrValidation = errors.New("bulk operation is not valid")
	// ErrStale means the fleet changed between preview and apply.
	ErrStale = errors.New("the preview no longer matches the fleet")
	// ErrNotReversible marks an action that cannot be undone.
	ErrNotReversible = errors.New("this operation cannot be undone")
	// ErrNotFound is returned for an unknown operation.
	ErrNotFound = errors.New("not found")
)

func validationError(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrValidation, fmt.Sprintf(format, args...))
}

// Assigner is the part of the playlist service this package uses. Assignment
// is not reimplemented here: the manifest bump, the group fan-out, the
// player-version compatibility check, and the audit entry all live in one
// place and must keep living there.
type Assigner interface {
	AssignPresentation(ctx context.Context, screenID uuid.UUID, playlistID, layoutID *uuid.UUID, userID uuid.UUID) (playlists.Assignment, error)
	Unassign(ctx context.Context, screenID, userID uuid.UUID) (playlists.Assignment, error)
}

// EnabledSetter is the part of the devices service this package uses.
type EnabledSetter interface {
	SetEnabled(ctx context.Context, id, userID uuid.UUID, enabled bool) error
}

// CommandEnqueuer sends one typed player command. It is implemented by the
// HTTP layer, where command validation and the pending-command limit already
// live, so bulk sending cannot drift away from single sending.
type CommandEnqueuer interface {
	EnqueueCommand(ctx context.Context, screenID, userID uuid.UUID, commandType string, payload json.RawMessage) error
}

// Service previews and applies bulk operations.
type Service struct {
	db           *pgxpool.Pool
	assigner     Assigner
	enabler      EnabledSetter
	commands     CommandEnqueuer
	approvalGate func(ctx context.Context, contentType string, id uuid.UUID) error
	// commandSupported says whether a screen's platform can run a command type.
	// It is injected so this package stays free of the devices service.
	commandSupported func(platform, commandType string) bool
	// scopes enforces the caller's screen scope. It is applied to the
	// operation-id paths as well as to preview and apply, so an operation id
	// cannot be used to reach a screen the caller may not touch.
	scopes ScopeAuthorizer
	logger *slog.Logger
}

// ScopeAuthorizer refuses screens outside an account's scope. It is the devices
// service; the interface keeps the dependency one-way and testable.
type ScopeAuthorizer interface {
	AuthorizeScreens(ctx context.Context, user uuid.UUID, role string, screens []uuid.UUID) error
}

// NewService builds the fleet operations service.
func NewService(db *pgxpool.Pool, assigner Assigner, enabler EnabledSetter, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{db: db, assigner: assigner, enabler: enabler, logger: logger}
}

// SetScopeAuthorizer installs the screen-scope check used by the operation-id
// paths. Without it, scope is enforced only where the caller names screens.
func (s *Service) SetScopeAuthorizer(authorizer ScopeAuthorizer) { s.scopes = authorizer }

// SetApprovalGate installs the content review check. It is applied during
// preview so unreviewed content is refused once, by name, rather than failing
// separately on every screen in the selection.
func (s *Service) SetApprovalGate(gate func(ctx context.Context, contentType string, id uuid.UUID) error) {
	s.approvalGate = gate
}

// SetCommandEnqueuer installs the command path. Bulk commands are unavailable
// until it is set.
func (s *Service) SetCommandEnqueuer(enqueuer CommandEnqueuer) { s.commands = enqueuer }

// SetCommandApplicability installs the check that skips a screen whose player
// cannot run the command, so the preview says so instead of a failure later.
func (s *Service) SetCommandApplicability(supported func(platform, commandType string) bool) {
	s.commandSupported = supported
}

// Request is one bulk operation.
type Request struct {
	ScreenIDs      []uuid.UUID     `json:"screenIds"`
	Action         string          `json:"action"`
	PlaylistID     *uuid.UUID      `json:"playlistId,omitempty"`
	LayoutID       *uuid.UUID      `json:"layoutId,omitempty"`
	Enabled        *bool           `json:"enabled,omitempty"`
	CommandType    string          `json:"commandType,omitempty"`
	CommandPayload json.RawMessage `json:"commandPayload,omitempty"`
}

// Validate checks the request shape before anything reads the database.
func (r Request) Validate() error {
	if len(r.ScreenIDs) == 0 {
		return validationError("select at least one screen")
	}
	if len(r.ScreenIDs) > MaxScreensPerOperation {
		return validationError("no more than %d screens in one operation", MaxScreensPerOperation)
	}
	switch r.Action {
	case ActionAssignPlaylist:
		if r.PlaylistID == nil {
			return validationError("assigning a playlist needs a playlist")
		}
		if r.LayoutID != nil {
			return validationError("choose a playlist or a Layout, not both")
		}
	case ActionAssignLayout:
		if r.LayoutID == nil {
			return validationError("assigning a Layout needs a Layout")
		}
		if r.PlaylistID != nil {
			return validationError("choose a playlist or a Layout, not both")
		}
	case ActionClearAssignment:
	case ActionSetEnabled:
		if r.Enabled == nil {
			return validationError("say whether playback should be enabled or disabled")
		}
	case ActionSendCommand:
		if r.CommandType == "" {
			return validationError("choose a command")
		}
	default:
		return validationError("unknown action %q", r.Action)
	}
	return nil
}

// Reversible reports whether this action can be undone. A command that a
// Player may already have collected cannot be recalled.
func (r Request) Reversible() bool {
	return r.Action != ActionSendCommand
}

// ScreenChange is what will happen, or did happen, to one screen.
type ScreenChange struct {
	ScreenID uuid.UUID `json:"screenId"`
	Name     string    `json:"name"`
	Location string    `json:"location,omitempty"`
	// Current and Next are written for a person to read, not parsed.
	Current string `json:"current"`
	Next    string `json:"next"`
	Changes bool   `json:"changes"`
	// Blocked explains why this screen will be skipped. Empty means it is fine.
	Blocked string `json:"blocked,omitempty"`
	// FromGroup names the sync group that pulled this screen in when the
	// operator did not select it.
	FromGroup string `json:"fromGroup,omitempty"`
	Selected  bool   `json:"selected"`
	// Applied and Error are filled in by Apply.
	Applied bool   `json:"applied,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Preview is what an operator confirms.
type Preview struct {
	Action  string         `json:"action"`
	Screens []ScreenChange `json:"screens"`
	// Counts are what the confirmation reads from, so they must add up to the
	// list above and never be computed twice.
	ChangeCount       int      `json:"changeCount"`
	UnchangedCount    int      `json:"unchangedCount"`
	BlockedCount      int      `json:"blockedCount"`
	GroupAddedCount   int      `json:"groupAddedCount"`
	Warnings          []string `json:"warnings"`
	Reversible        bool     `json:"reversible"`
	UndoWindowMinutes int      `json:"undoWindowMinutes"`
}

type screenRow struct {
	id           uuid.UUID
	name         string
	location     string
	enabled      bool
	archived     bool
	revoked      bool
	platform     string
	groupID      *uuid.UUID
	groupName    string
	playlistID   *uuid.UUID
	playlistName string
	layoutID     *uuid.UUID
	layoutName   string
	selected     bool
}

// currentLabel describes what this screen plays now, in the same words the
// preview uses for the next state.
func (row screenRow) currentLabel() string {
	switch {
	case row.playlistID != nil:
		return "Playlist: " + row.playlistName
	case row.layoutID != nil:
		return "Layout: " + row.layoutName
	default:
		return "Nothing assigned"
	}
}

// Build produces the preview.
func (s *Service) Build(ctx context.Context, request Request) (Preview, error) {
	if err := request.Validate(); err != nil {
		return Preview{}, err
	}
	rows, err := s.expand(ctx, request.ScreenIDs)
	if err != nil {
		return Preview{}, err
	}
	if len(rows) == 0 {
		return Preview{}, validationError("none of the selected screens exist")
	}
	// The cap applies to what will actually change, not to what was selected.
	// Sync-group fan-out happens after Validate, and a screen may belong to
	// several groups, so a legal selection can expand past the limit the
	// constant exists to enforce.
	if len(rows) > MaxScreensPerOperation {
		return Preview{}, validationError(
			"sync groups expand this selection to %d screens; no more than %d in one operation",
			len(rows), MaxScreensPerOperation)
	}

	nextLabel, err := s.nextLabel(ctx, request)
	if err != nil {
		return Preview{}, err
	}
	if s.approvalGate != nil {
		switch {
		case request.PlaylistID != nil:
			if err := s.approvalGate(ctx, "playlist", *request.PlaylistID); err != nil {
				return Preview{}, validationError("%s", err.Error())
			}
		case request.LayoutID != nil:
			if err := s.approvalGate(ctx, "layout", *request.LayoutID); err != nil {
				return Preview{}, validationError("%s", err.Error())
			}
		}
	}

	preview := Preview{
		Action:            request.Action,
		Reversible:        request.Reversible(),
		UndoWindowMinutes: int(UndoWindow / time.Minute),
		Warnings:          []string{},
		Screens:           make([]ScreenChange, 0, len(rows)),
	}
	groupsSeen := map[string]bool{}
	for _, row := range rows {
		change := ScreenChange{
			ScreenID: row.id, Name: row.name, Location: row.location,
			Selected: row.selected, Current: row.currentLabel(), Next: nextLabel,
		}
		if !row.selected && row.groupName != "" {
			change.FromGroup = row.groupName
			groupsSeen[row.groupName] = true
			preview.GroupAddedCount++
		}
		change.Blocked = blockedReason(row, request)
		if change.Blocked == "" {
			change.Blocked = s.unsupportedReason(row, request)
		}
		if change.Blocked == "" {
			change.Changes = changes(row, request)
		}
		switch {
		case change.Blocked != "":
			preview.BlockedCount++
		case change.Changes:
			preview.ChangeCount++
		default:
			preview.UnchangedCount++
		}
		if request.Action == ActionSetEnabled {
			change.Current = enabledLabel(row.enabled)
		}
		preview.Screens = append(preview.Screens, change)
	}

	if preview.GroupAddedCount > 0 {
		names := make([]string, 0, len(groupsSeen))
		for name := range groupsSeen {
			names = append(names, name)
		}
		sort.Strings(names)
		subject := "screens are"
		if preview.GroupAddedCount == 1 {
			subject = "screen is"
		}
		preview.Warnings = append(preview.Warnings, fmt.Sprintf(
			"%d more %s included because they share a sync group (%s). A sync group plays one assignment on every member.",
			preview.GroupAddedCount, subject, joinNames(names)))
	}
	if !request.Reversible() {
		preview.Warnings = append(preview.Warnings,
			"Sending a command cannot be undone. A Player may collect it immediately.")
	}
	return preview, nil
}

// expand reads the selected screens and pulls in the rest of any sync group
// they belong to, because that is what assignment actually does.
func (s *Service) expand(ctx context.Context, selected []uuid.UUID) ([]screenRow, error) {
	rows, err := s.db.Query(ctx, `
		WITH selected AS (SELECT unnest($1::uuid[]) AS id),
		groups AS (
			SELECT DISTINCT m.screen_group_id
			FROM screen_group_memberships m JOIN selected ON selected.id=m.screen_id
		),
		involved AS (
			SELECT id FROM selected
			UNION
			SELECT m.screen_id FROM screen_group_memberships m
			JOIN groups g ON g.screen_group_id=m.screen_group_id
		)
		SELECT DISTINCT ON (sc.id)
		       sc.id, sc.name, COALESCE(l.name,''), sc.enabled,
		       sc.archived_at IS NOT NULL,
		       NOT EXISTS(SELECT 1 FROM device_credentials c
		                  WHERE c.screen_id=sc.id AND c.revoked_at IS NULL),
		       sc.platform,
		       m.screen_group_id, COALESCE(g.name,''),
		       COALESCE(sa.playlist_id, ga.playlist_id),
		       COALESCE(sp.name, gp.name, ''),
		       COALESCE(sa.layout_id, ga.layout_id),
		       COALESCE(sl.name, gl.name, ''),
		       EXISTS(SELECT 1 FROM selected WHERE selected.id=sc.id)
		FROM screens sc
		JOIN involved ON involved.id=sc.id
		LEFT JOIN locations l ON l.id=sc.location_id
		LEFT JOIN screen_group_memberships m ON m.screen_id=sc.id
		LEFT JOIN screen_groups g ON g.id=m.screen_group_id
		LEFT JOIN screen_playlist_assignments sa ON sa.screen_id=sc.id
		LEFT JOIN screen_group_playlist_assignments ga ON ga.screen_group_id=m.screen_group_id
		LEFT JOIN playlists sp ON sp.id=sa.playlist_id
		LEFT JOIN playlists gp ON gp.id=ga.playlist_id
		LEFT JOIN layouts sl ON sl.id=sa.layout_id
		LEFT JOIN layouts gl ON gl.id=ga.layout_id
		WHERE sc.deleted_at IS NULL
		-- DISTINCT ON needs sc.id leading; the caller-facing order is restored
		-- by the sort below. Without this a screen in several groups appears
		-- once per membership and inflates every count in the preview.
		ORDER BY sc.id, g.name`, selected)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []screenRow
	for rows.Next() {
		var row screenRow
		if err := rows.Scan(&row.id, &row.name, &row.location, &row.enabled,
			&row.archived, &row.revoked, &row.platform, &row.groupID, &row.groupName,
			&row.playlistID, &row.playlistName, &row.layoutID, &row.layoutName,
			&row.selected); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].name != out[j].name {
			return out[i].name < out[j].name
		}
		return out[i].id.String() < out[j].id.String()
	})
	return out, nil
}

func (s *Service) nextLabel(ctx context.Context, request Request) (string, error) {
	switch request.Action {
	case ActionAssignPlaylist:
		var name string
		err := s.db.QueryRow(ctx,
			`SELECT name FROM playlists WHERE id=$1 AND deleted_at IS NULL`, request.PlaylistID).Scan(&name)
		if err != nil {
			return "", validationError("that playlist no longer exists")
		}
		return "Playlist: " + name, nil
	case ActionAssignLayout:
		var name string
		err := s.db.QueryRow(ctx,
			`SELECT name FROM layouts
			 WHERE id=$1 AND deleted_at IS NULL AND published_revision_id IS NOT NULL`,
			request.LayoutID).Scan(&name)
		if err != nil {
			return "", validationError("that Layout no longer exists or is not published")
		}
		return "Layout: " + name, nil
	case ActionClearAssignment:
		return "Nothing assigned", nil
	case ActionSetEnabled:
		return enabledLabel(*request.Enabled), nil
	default:
		return "Command: " + request.CommandType, nil
	}
}

func enabledLabel(enabled bool) string {
	if enabled {
		return "Playback enabled"
	}
	return "Playback disabled"
}

// blockedReason names why a screen will be skipped, in words an operator can
// act on. A skipped screen is reported, never silently dropped.
func blockedReason(row screenRow, request Request) string {
	if row.archived {
		return "Archived"
	}
	if row.revoked {
		return "No active player credential"
	}
	if request.Action == ActionSendCommand && !row.enabled {
		return "Playback is disabled"
	}
	return ""
}

// unsupportedReason skips a screen whose player cannot run the command, so the
// preview says so before anything is queued.
func (s *Service) unsupportedReason(row screenRow, request Request) string {
	if request.Action == ActionSendCommand && s.commandSupported != nil &&
		!s.commandSupported(row.platform, request.CommandType) {
		return "This player cannot run that command"
	}
	return ""
}

// changes reports whether this screen would actually end up different. A
// no-change row is shown so the count an operator confirms is the number of
// screens that move, not the number they clicked.
func changes(row screenRow, request Request) bool {
	switch request.Action {
	case ActionAssignPlaylist:
		return row.playlistID == nil || *row.playlistID != *request.PlaylistID
	case ActionAssignLayout:
		return row.layoutID == nil || *row.layoutID != *request.LayoutID
	case ActionClearAssignment:
		return row.playlistID != nil || row.layoutID != nil
	case ActionSetEnabled:
		return row.enabled != *request.Enabled
	default:
		// A command is always work: it is an instruction, not a state.
		return true
	}
}

func joinNames(names []string) string {
	if len(names) <= 3 {
		return joinWithCommas(names)
	}
	return joinWithCommas(names[:3]) + fmt.Sprintf(" and %d more", len(names)-3)
}

func joinWithCommas(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	case 2:
		return names[0] + " and " + names[1]
	default:
		out := ""
		for i, name := range names[:len(names)-1] {
			if i > 0 {
				out += ", "
			}
			out += name
		}
		return out + ", and " + names[len(names)-1]
	}
}
