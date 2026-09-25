package scheduling

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
)

var (
	ErrNotFound = errors.New("schedule resource not found")
	ErrConflict = errors.New("schedule conflict")
	ErrLimit    = errors.New("schedule limit exceeded")
	// ErrDisplayControlUnsupported is returned instead of silently assigning a
	// display-only schedule to a platform that cannot execute it.
	ErrDisplayControlUnsupported = errors.New("display-control schedule is unsupported on this platform")
)

type Notifier interface{ ManifestChanged(uuid.UUID, int64) }
type Limits struct{ MaxSchedules, MaxTargetsPerSchedule, MaxGroupsPerScreen, PrefetchDays, ActivationGraceSeconds, ClockSkewWarningSeconds int }
type PresentationReadiness interface {
	ValidatePresentation(context.Context, string, uuid.UUID, time.Time) error
}
type OrganizationSettingsProvider interface {
	OrganizationValues(context.Context) (map[string]any, error)
}
type Service struct {
	db                 *pgxpool.Pool
	notifier           Notifier
	limits             Limits
	readiness          PresentationReadiness
	organizationValues OrganizationSettingsProvider
}

func NewService(db *pgxpool.Pool, n Notifier, l Limits) *Service {
	return &Service{db: db, notifier: n, limits: l}
}

func (s *Service) SetPresentationReadiness(readiness PresentationReadiness) {
	s.readiness = readiness
}

func (s *Service) SetOrganizationSettingsProvider(provider OrganizationSettingsProvider) {
	s.organizationValues = provider
}

type Group struct {
	ID                          uuid.UUID     `json:"id"`
	Name                        string        `json:"name"`
	Description                 string        `json:"description"`
	DisplayMode                 string        `json:"displayMode"`
	PresentationGatewayScreenID *uuid.UUID    `json:"presentationGatewayScreenId,omitempty"`
	PlaylistID                  *uuid.UUID    `json:"playlistId,omitempty"`
	PlaylistName                *string       `json:"playlistName,omitempty"`
	LayoutID                    *uuid.UUID    `json:"layoutId,omitempty"`
	LayoutName                  *string       `json:"layoutName,omitempty"`
	PresentationType            *string       `json:"presentationType,omitempty"`
	PlaybackEpoch               time.Time     `json:"playbackEpoch"`
	MembershipCount             int           `json:"membershipCount"`
	Screens                     []GroupScreen `json:"screens"`
	CreatedAt                   time.Time     `json:"createdAt"`
	UpdatedAt                   time.Time     `json:"updatedAt"`
}
type GroupScreen struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Location string    `json:"location"`
}
type GroupList struct {
	Items    []Group `json:"items"`
	Total    int     `json:"total"`
	Page     int     `json:"page"`
	PageSize int     `json:"pageSize"`
}
type Target struct {
	Type string    `json:"type"`
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name,omitempty"`
}
type Record struct {
	Schedule
	Name             string    `json:"name"`
	Description      string    `json:"description"`
	PlaylistName     string    `json:"playlistName"`
	LayoutName       *string   `json:"layoutName,omitempty"`
	PresentationType string    `json:"presentationType"`
	Targets          []Target  `json:"targets"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}
type List struct {
	Items           []Record `json:"items"`
	Total           int      `json:"total"`
	Page            int      `json:"page"`
	PageSize        int      `json:"pageSize"`
	DefaultTimezone string   `json:"defaultTimezone"`
}
type Input struct {
	Name          string                 `json:"name"`
	Description   string                 `json:"description"`
	PlaylistID    uuid.UUID              `json:"playlistId"`
	LayoutID      *uuid.UUID             `json:"layoutId,omitempty"`
	DisplayAction *displaycontrol.Action `json:"displayAction,omitempty"`
	Type          Kind                   `json:"type"`
	Timezone      string                 `json:"timezone"`
	Priority      int                    `json:"priority"`
	Enabled       bool                   `json:"enabled"`
	StartDate     *string                `json:"startDate"`
	EndDate       *string                `json:"endDate"`
	OneTimeStart  *time.Time             `json:"oneTimeStart"`
	OneTimeEnd    *time.Time             `json:"oneTimeEnd"`
	DailyStart    *string                `json:"dailyStart"`
	DailyEnd      *string                `json:"dailyEnd"`
	DaysOfWeek    []int                  `json:"daysOfWeek"`
	Targets       []Target               `json:"targets"`
}

func (s *Service) ListGroups(ctx context.Context, search string, page, size int) (GroupList, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 50
	}
	var out GroupList
	out.Page, out.PageSize = page, size
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM screen_groups WHERE deleted_at IS NULL AND ($1='' OR name ILIKE '%'||$1||'%')`, strings.TrimSpace(search)).Scan(&out.Total); err != nil {
		return out, err
	}
	rows, err := s.db.Query(ctx, `SELECT g.id,g.name,g.description,g.display_mode,g.presentation_gateway_screen_id,a.playlist_id,p.name,a.layout_id,l.name,CASE WHEN a.layout_id IS NOT NULL THEN 'layout' WHEN a.playlist_id IS NOT NULL THEN 'playlist' END,g.playback_epoch,g.created_at,g.updated_at,count(m.screen_id) FROM screen_groups g LEFT JOIN screen_group_memberships m ON m.screen_group_id=g.id LEFT JOIN screen_group_playlist_assignments a ON a.screen_group_id=g.id LEFT JOIN playlists p ON p.id=a.playlist_id LEFT JOIN layouts l ON l.id=a.layout_id WHERE g.deleted_at IS NULL AND ($1='' OR g.name ILIKE '%'||$1||'%') GROUP BY g.id,g.display_mode,g.presentation_gateway_screen_id,a.playlist_id,p.name,a.layout_id,l.name ORDER BY lower(g.name),g.id LIMIT $2 OFFSET $3`, strings.TrimSpace(search), size, (page-1)*size)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	out.Items = []Group{}
	for rows.Next() {
		var g Group
		if err = rows.Scan(&g.ID, &g.Name, &g.Description, &g.DisplayMode, &g.PresentationGatewayScreenID, &g.PlaylistID, &g.PlaylistName, &g.LayoutID, &g.LayoutName, &g.PresentationType, &g.PlaybackEpoch, &g.CreatedAt, &g.UpdatedAt, &g.MembershipCount); err != nil {
			return out, err
		}
		g.DisplayMode = normalizeDisplayMode(g.DisplayMode)
		g.Screens = []GroupScreen{}
		out.Items = append(out.Items, g)
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	rows.Close()
	if len(out.Items) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, 0, len(out.Items))
	byID := make(map[uuid.UUID]*Group, len(out.Items))
	for index := range out.Items {
		ids = append(ids, out.Items[index].ID)
		byID[out.Items[index].ID] = &out.Items[index]
	}
	members, err := s.db.Query(ctx, `SELECT m.screen_group_id,sc.id,sc.name,COALESCE(l.name,'') FROM screen_group_memberships m JOIN screens sc ON sc.id=m.screen_id LEFT JOIN locations l ON l.id=sc.location_id WHERE m.screen_group_id=ANY($1) ORDER BY lower(sc.name),sc.id`, ids)
	if err != nil {
		return out, err
	}
	defer members.Close()
	for members.Next() {
		var groupID uuid.UUID
		var screen GroupScreen
		if err = members.Scan(&groupID, &screen.ID, &screen.Name, &screen.Location); err != nil {
			return out, err
		}
		if group := byID[groupID]; group != nil {
			group.Screens = append(group.Screens, screen)
		}
	}
	return out, members.Err()
}
func validateGroup(name, description string) error {
	if n := len(strings.TrimSpace(name)); n < 1 || n > 180 {
		return errors.New("group name must be between 1 and 180 characters")
	}
	if len(description) > 2000 {
		return errors.New("group description must be at most 2000 characters")
	}
	return nil
}
func (s *Service) CreateGroup(ctx context.Context, user uuid.UUID, name, description string) (Group, error) {
	if err := validateGroup(name, description); err != nil {
		return Group{}, err
	}
	id := ids.New(ctx)
	_, err := s.db.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,description,created_by)SELECT $1,id,$2,$3,$4 FROM organization_settings WHERE singleton`, id, strings.TrimSpace(name), description, user)
	if err != nil {
		return Group{}, err
	}
	_ = s.audit(ctx, user, "screen_group.created", "screen_group", id)
	return s.GetGroup(ctx, id)
}
func (s *Service) GetGroup(ctx context.Context, id uuid.UUID) (Group, error) {
	var g Group
	err := s.db.QueryRow(ctx, `SELECT g.id,g.name,g.description,g.display_mode,g.presentation_gateway_screen_id,a.playlist_id,p.name,a.layout_id,l.name,CASE WHEN a.layout_id IS NOT NULL THEN 'layout' WHEN a.playlist_id IS NOT NULL THEN 'playlist' END,g.playback_epoch,g.created_at,g.updated_at,count(m.screen_id) FROM screen_groups g LEFT JOIN screen_group_memberships m ON m.screen_group_id=g.id LEFT JOIN screen_group_playlist_assignments a ON a.screen_group_id=g.id LEFT JOIN playlists p ON p.id=a.playlist_id LEFT JOIN layouts l ON l.id=a.layout_id WHERE g.id=$1 AND g.deleted_at IS NULL GROUP BY g.id,g.display_mode,g.presentation_gateway_screen_id,a.playlist_id,p.name,a.layout_id,l.name`, id).Scan(&g.ID, &g.Name, &g.Description, &g.DisplayMode, &g.PresentationGatewayScreenID, &g.PlaylistID, &g.PlaylistName, &g.LayoutID, &g.LayoutName, &g.PresentationType, &g.PlaybackEpoch, &g.CreatedAt, &g.UpdatedAt, &g.MembershipCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return g, ErrNotFound
	}
	if err != nil {
		return g, err
	}
	g.DisplayMode = normalizeDisplayMode(g.DisplayMode)
	rows, err := s.db.Query(ctx, `SELECT sc.id,sc.name,COALESCE(l.name,'') FROM screen_group_memberships m JOIN screens sc ON sc.id=m.screen_id LEFT JOIN locations l ON l.id=sc.location_id WHERE m.screen_group_id=$1 ORDER BY lower(sc.name),sc.id`, id)
	if err != nil {
		return g, err
	}
	defer rows.Close()
	g.Screens = []GroupScreen{}
	for rows.Next() {
		var x GroupScreen
		if err = rows.Scan(&x.ID, &x.Name, &x.Location); err != nil {
			return g, err
		}
		g.Screens = append(g.Screens, x)
	}
	return g, rows.Err()
}
func (s *Service) UpdateGroup(ctx context.Context, id, user uuid.UUID, name, description string, presentationGatewayScreenID *uuid.UUID, clearPresentationGateway bool) (Group, error) {
	if err := validateGroup(name, description); err != nil {
		return Group{}, err
	}
	if presentationGatewayScreenID != nil {
		var member bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_group_memberships WHERE screen_group_id=$1 AND screen_id=$2)`, id, *presentationGatewayScreenID).Scan(&member); err != nil {
			return Group{}, err
		}
		if !member {
			return Group{}, fmt.Errorf("presentation gateway must be a member of the screen group: %w", ErrConflict)
		}
	}
	presentationGatewayAssignment := "presentation_gateway_screen_id=COALESCE($4,presentation_gateway_screen_id)"
	if clearPresentationGateway {
		presentationGatewayAssignment = "presentation_gateway_screen_id=$4"
	}
	tag, err := s.db.Exec(ctx, `UPDATE screen_groups SET name=$2,description=$3,`+presentationGatewayAssignment+`,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, strings.TrimSpace(name), description, presentationGatewayScreenID)
	if err != nil {
		return Group{}, err
	}
	if tag.RowsAffected() == 0 {
		return Group{}, ErrNotFound
	}
	_ = s.audit(ctx, user, "screen_group.updated", "screen_group", id)
	return s.GetGroup(ctx, id)
}
func (s *Service) DeleteGroup(ctx context.Context, id, user uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	notes, err := bumpGroupScreens(ctx, tx, id, "screen_group.deleted")
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE screen_groups SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	for _, n := range notes {
		if err = restoreScreenSnapshot(ctx, tx, id, n.id, user); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM screen_group_playlist_assignments WHERE screen_group_id=$1`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM alert_rule_targets WHERE target_type='group' AND screen_group_id=$1`, id); err != nil {
		return err
	}
	configRevisions := map[uuid.UUID]int64{}
	for _, note := range notes {
		_, _ = tx.Exec(ctx, `INSERT INTO screen_config_state(screen_id)VALUES($1)ON CONFLICT DO NOTHING`, note.id)
		var revision int64
		_ = tx.QueryRow(ctx, `UPDATE screen_config_state SET config_revision=config_revision+1,changed_at=now(),change_reason='screen_group.deleted' WHERE screen_id=$1 RETURNING config_revision`, note.id).Scan(&revision)
		configRevisions[note.id] = revision
	}
	if _, err = tx.Exec(ctx, `DELETE FROM screen_group_memberships WHERE screen_group_id=$1`, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	if notifier, ok := s.notifier.(interface{ ConfigChanged(uuid.UUID, int64) }); ok {
		for screen, revision := range configRevisions {
			notifier.ConfigChanged(screen, revision)
		}
	}
	_ = s.audit(ctx, user, "screen_group.deleted", "screen_group", id)
	return nil
}
func (s *Service) AddScreen(ctx context.Context, group, screen, user uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// A group-targeted display-control schedule follows every member. Check the
	// new member before changing membership so an Android Player cannot acquire
	// a schedule it has no way to execute after the schedule itself was created
	// for an all-Linux group.
	var unsupported bool
	if err = tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM screens sc
			JOIN screen_groups g ON g.id=$1 AND g.organization_id=sc.organization_id AND g.deleted_at IS NULL
			WHERE sc.id=$2 AND sc.platform<>'linux'
			  AND EXISTS(
				SELECT 1
				FROM schedules schedule
				JOIN schedule_targets target ON target.schedule_id=schedule.id
				WHERE target.target_type='group'
				  AND target.screen_group_id=$1
				  AND schedule.deleted_at IS NULL
				  AND schedule.display_action IS NOT NULL
			  )
		)`, group, screen).Scan(&unsupported); err != nil {
		return err
	}
	if unsupported {
		return fmt.Errorf("%w: display-control schedules are supported only on Linux Players", ErrDisplayControlUnsupported)
	}
	tag, err := tx.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) SELECT g.id,sc.id,$3 FROM screen_groups g JOIN screens sc ON sc.organization_id=g.organization_id WHERE g.id=$1 AND sc.id=$2 AND g.deleted_at IS NULL`, group, screen, user)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && (databaseError.ConstraintName == "screen_group_memberships_one_group_per_screen" || databaseError.ConstraintName == "screen_group_memberships_pkey") {
			return fmt.Errorf("%w: screen already belongs to a sync group", ErrConflict)
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `INSERT INTO screen_group_playlist_assignments(screen_group_id,playlist_id,assigned_by,assigned_at) SELECT $1,a.playlist_id,$3,a.assigned_at FROM screen_playlist_assignments a WHERE a.screen_id=$2 ON CONFLICT(screen_group_id)DO NOTHING`, group, screen, user); err != nil {
		return err
	}
	// Snapshot the screen's own assignment and schedule targets so leaving the
	// group can restore them instead of inheriting the group's content.
	if _, err = tx.Exec(ctx, `DELETE FROM screen_group_membership_snapshots WHERE screen_id=$1`, screen); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM screen_group_membership_schedule_snapshots WHERE screen_id=$1`, screen); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO screen_group_membership_snapshots(screen_id,playlist_id,assigned_by,assigned_at) SELECT sc.id,a.playlist_id,a.assigned_by,a.assigned_at FROM screens sc LEFT JOIN screen_playlist_assignments a ON a.screen_id=sc.id WHERE sc.id=$1`, screen); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO screen_group_membership_schedule_snapshots(screen_id,schedule_id) SELECT screen_id,schedule_id FROM schedule_targets WHERE target_type='screen' AND screen_id=$1`, screen); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM screen_playlist_assignments WHERE screen_id=$1`, screen); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_group_id) SELECT schedule_id,'group',$1 FROM schedule_targets WHERE target_type='screen' AND screen_id=$2 ON CONFLICT(schedule_id,screen_group_id)DO NOTHING`, group, screen); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM schedule_targets WHERE target_type='screen' AND screen_id=$1`, screen); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE screen_groups SET playback_epoch=now(),updated_at=now() WHERE id=$1`, group); err != nil {
		return err
	}
	memberRows, err := tx.Query(ctx, `SELECT screen_id FROM screen_group_memberships WHERE screen_group_id=$1`, group)
	if err != nil {
		return err
	}
	memberIDs := []uuid.UUID{}
	for memberRows.Next() {
		var id uuid.UUID
		if err = memberRows.Scan(&id); err != nil {
			memberRows.Close()
			return err
		}
		memberIDs = append(memberIDs, id)
	}
	memberRows.Close()
	notes, err := bumpScreens(ctx, tx, memberIDs, "sync_group.membership_changed")
	if err != nil {
		return err
	}
	var configRevision int64
	_, _ = tx.Exec(ctx, `INSERT INTO screen_config_state(screen_id)VALUES($1)ON CONFLICT DO NOTHING`, screen)
	_ = tx.QueryRow(ctx, `UPDATE screen_config_state SET config_revision=config_revision+1,changed_at=now(),change_reason='screen_group.membership_changed' WHERE screen_id=$1 RETURNING config_revision`, screen).Scan(&configRevision)
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	if notifier, ok := s.notifier.(interface{ ConfigChanged(uuid.UUID, int64) }); ok {
		notifier.ConfigChanged(screen, configRevision)
	}
	_ = s.audit(ctx, user, "screen_group.screen_added", "screen_group", group)
	return nil
}

// restoreScreenSnapshot reinstates the playlist assignment and screen-targeted
// schedules a screen had before it joined a sync group, then discards the
// snapshot. Memberships created before snapshots existed have no snapshot row
// and fall back to inheriting the group's playlist.
func restoreScreenSnapshot(ctx context.Context, tx pgx.Tx, group, screen, user uuid.UUID) error {
	if _, err := tx.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by,assigned_at,updated_at) SELECT gen_random_uuid(),snap.screen_id,snap.playlist_id,COALESCE(snap.assigned_by,$2),COALESCE(snap.assigned_at,now()),now() FROM screen_group_membership_snapshots snap WHERE snap.screen_id=$1 AND snap.playlist_id IS NOT NULL ON CONFLICT(screen_id)DO UPDATE SET playlist_id=EXCLUDED.playlist_id,assigned_by=EXCLUDED.assigned_by,updated_at=now()`, screen, user); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by,assigned_at,updated_at) SELECT gen_random_uuid(),$2,a.playlist_id,$3,now(),now() FROM screen_group_playlist_assignments a WHERE a.screen_group_id=$1 AND NOT EXISTS(SELECT 1 FROM screen_group_membership_snapshots WHERE screen_id=$2) ON CONFLICT(screen_id)DO UPDATE SET playlist_id=EXCLUDED.playlist_id,assigned_by=EXCLUDED.assigned_by,updated_at=now()`, group, screen, user); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_id) SELECT snap.schedule_id,'screen',snap.screen_id FROM screen_group_membership_schedule_snapshots snap JOIN schedules s ON s.id=snap.schedule_id AND s.deleted_at IS NULL WHERE snap.screen_id=$1 ON CONFLICT(schedule_id,screen_id)DO NOTHING`, screen); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM screen_group_membership_snapshots WHERE screen_id=$1`, screen); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM screen_group_membership_schedule_snapshots WHERE screen_id=$1`, screen); err != nil {
		return err
	}
	return nil
}

func (s *Service) RemoveScreen(ctx context.Context, group, screen, user uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = restoreScreenSnapshot(ctx, tx, group, screen, user); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM screen_group_memberships WHERE screen_group_id=$1 AND screen_id=$2`, group, screen)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// A preferred AirPlay gateway must remain a member of the group. Clear the
	// preference as part of the same membership transaction so the next session
	// does not carry a stale identity into deterministic fallback selection.
	if _, err = tx.Exec(ctx, `UPDATE screen_groups SET presentation_gateway_screen_id=NULL,updated_at=now() WHERE id=$1 AND presentation_gateway_screen_id=$2`, group, screen); err != nil {
		return err
	}
	notes, err := bumpScreens(ctx, tx, []uuid.UUID{screen}, "screen_group.membership_changed")
	if err != nil {
		return err
	}
	var configRevision int64
	_, _ = tx.Exec(ctx, `INSERT INTO screen_config_state(screen_id)VALUES($1)ON CONFLICT DO NOTHING`, screen)
	_ = tx.QueryRow(ctx, `UPDATE screen_config_state SET config_revision=config_revision+1,changed_at=now(),change_reason='screen_group.membership_changed' WHERE screen_id=$1 RETURNING config_revision`, screen).Scan(&configRevision)
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	if notifier, ok := s.notifier.(interface{ ConfigChanged(uuid.UUID, int64) }); ok {
		notifier.ConfigChanged(screen, configRevision)
	}
	_ = s.audit(ctx, user, "screen_group.screen_removed", "screen_group", group)
	return nil
}

func (s *Service) validateInput(ctx context.Context, in Input) error {
	if len(strings.TrimSpace(in.Name)) < 1 || len(in.Name) > 180 {
		return errors.New("schedule name must be between 1 and 180 characters")
	}
	if len(in.Description) > 2000 {
		return errors.New("schedule description must be at most 2000 characters")
	}
	if len(in.Targets) < 1 {
		return errors.New("schedule must have at least one target")
	}
	if len(in.Targets) > s.limits.MaxTargetsPerSchedule {
		return ErrLimit
	}
	presentations := 0
	if in.PlaylistID != uuid.Nil {
		presentations++
	}
	if in.LayoutID != nil {
		presentations++
	}
	if in.DisplayAction != nil {
		presentations++
	}
	if presentations != 1 {
		return errors.New("schedule requires exactly one presentation or display action")
	}
	if in.DisplayAction != nil {
		if err := in.DisplayAction.Validate(); err != nil {
			return err
		}
	}
	if err := Validate(Schedule{PlaylistID: in.PlaylistID, LayoutID: in.LayoutID, Type: in.Type, Timezone: in.Timezone, Priority: in.Priority, Enabled: in.Enabled, StartDate: in.StartDate, EndDate: in.EndDate, OneTimeStart: in.OneTimeStart, OneTimeEnd: in.OneTimeEnd, DailyStart: in.DailyStart, DailyEnd: in.DailyEnd, DaysOfWeek: in.DaysOfWeek}); err != nil {
		return err
	}
	var ok bool
	var presentationErr error
	if in.DisplayAction != nil {
		ok = true
	} else if in.LayoutID != nil {
		presentationErr = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM layouts WHERE id=$1 AND deleted_at IS NULL AND published_revision_id IS NOT NULL)`, in.LayoutID).Scan(&ok)
	} else {
		presentationErr = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM playlists WHERE id=$1 AND deleted_at IS NULL)`, in.PlaylistID).Scan(&ok)
	}
	if presentationErr != nil {
		return presentationErr
	}
	if !ok {
		return errors.New("presentation is unpublished, deleted, or invalid")
	}
	if s.readiness != nil {
		contentType, contentID := "layout", in.LayoutID
		if in.PlaylistID != uuid.Nil {
			contentType, contentID = "playlist", &in.PlaylistID
		}
		if err := s.readiness.ValidatePresentation(ctx, contentType, *contentID, time.Now().UTC()); err != nil {
			return err
		}
	}
	seen := map[string]bool{}
	for _, t := range in.Targets {
		if t.Type != "screen" && t.Type != "group" {
			return errors.New("target type is invalid")
		}
		k := t.Type + t.ID.String()
		if seen[k] {
			return errors.New("duplicate schedule target")
		}
		seen[k] = true
		var targetOK bool
		var targetErr error
		if t.Type == "screen" {
			targetErr = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens sc JOIN organization_settings o ON o.id=sc.organization_id AND o.singleton WHERE sc.id=$1)`, t.ID).Scan(&targetOK)
		} else {
			targetErr = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_groups g JOIN organization_settings o ON o.id=g.organization_id AND o.singleton WHERE g.id=$1 AND g.deleted_at IS NULL)`, t.ID).Scan(&targetOK)
		}
		if targetErr != nil {
			return targetErr
		}
		if !targetOK {
			return errors.New("schedule target is invalid or belongs to another organization")
		}
		if in.DisplayAction != nil {
			var unsupported bool
			if t.Type == "screen" {
				if err := s.db.QueryRow(ctx, `SELECT platform<>'linux' FROM screens WHERE id=$1`, t.ID).Scan(&unsupported); err != nil {
					return err
				}
			} else if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_group_memberships m JOIN screens sc ON sc.id=m.screen_id WHERE m.screen_group_id=$1 AND sc.platform<>'linux')`, t.ID).Scan(&unsupported); err != nil {
				return err
			}
			if unsupported {
				return fmt.Errorf("%w: display-control schedules are supported only on Linux Players", ErrDisplayControlUnsupported)
			}
		}
	}
	return nil
}

func (s *Service) applyOrganizationDefaults(ctx context.Context, in Input) (Input, error) {
	if in.Type != OneTime || in.OneTimeStart == nil || in.OneTimeEnd != nil || s.organizationValues == nil {
		return in, nil
	}
	values, err := s.organizationValues.OrganizationValues(ctx)
	if err != nil {
		return in, err
	}
	minutes := settingInt(values, "scheduling.default_one_time_duration_minutes", 60)
	if minutes < 1 {
		minutes = 60
	}
	in.OneTimeEnd = ptrTime(in.OneTimeStart.Add(time.Duration(minutes) * time.Minute))
	return in, nil
}

func ptrTime(value time.Time) *time.Time { return &value }

func settingInt(values map[string]any, key string, fallback int) int {
	switch value := values[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	}
	return fallback
}
func (s *Service) withDefaultTimezone(ctx context.Context, in Input) (Input, error) {
	if strings.TrimSpace(in.Timezone) != "" {
		return in, nil
	}
	err := s.db.QueryRow(ctx, `SELECT default_timezone FROM organization_settings WHERE singleton`).Scan(&in.Timezone)
	return in, err
}
func (s *Service) normalizeSyncGroupTargets(ctx context.Context, in Input) (Input, error) {
	normalized := make([]Target, 0, len(in.Targets))
	seen := map[string]bool{}
	for _, target := range in.Targets {
		if target.Type == "screen" {
			var groupID *uuid.UUID
			if err := s.db.QueryRow(ctx, `SELECT m.screen_group_id FROM screens sc LEFT JOIN screen_group_memberships m ON m.screen_id=sc.id WHERE sc.id=$1`, target.ID).Scan(&groupID); err != nil {
				return in, err
			}
			if groupID != nil {
				target.Type = "group"
				target.ID = *groupID
			}
		}
		key := target.Type + target.ID.String()
		if seen[key] {
			continue
		}
		seen[key] = true
		normalized = append(normalized, target)
	}
	in.Targets = normalized
	return in, nil
}
func (s *Service) Create(ctx context.Context, user uuid.UUID, in Input) (Record, error) {
	var err error
	in, err = s.withDefaultTimezone(ctx, in)
	if err != nil {
		return Record{}, err
	}
	in, err = s.normalizeSyncGroupTargets(ctx, in)
	if err != nil {
		return Record{}, err
	}
	in, err = s.applyOrganizationDefaults(ctx, in)
	if err != nil {
		return Record{}, err
	}
	if err := s.validateInput(ctx, in); err != nil {
		return Record{}, err
	}
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM schedules WHERE deleted_at IS NULL`).Scan(&count); err != nil {
		return Record{}, err
	}
	if count >= s.limits.MaxSchedules {
		return Record{}, ErrLimit
	}
	id := ids.New(ctx)
	if err := s.write(ctx, id, user, in, true); err != nil {
		return Record{}, err
	}
	return s.Get(ctx, id)
}
func (s *Service) Update(ctx context.Context, id, user uuid.UUID, in Input) (Record, error) {
	previous, previousErr := s.Get(ctx, id)
	if previousErr != nil {
		return Record{}, previousErr
	}
	var err error
	in, err = s.withDefaultTimezone(ctx, in)
	if err != nil {
		return Record{}, err
	}
	in, err = s.normalizeSyncGroupTargets(ctx, in)
	if err != nil {
		return Record{}, err
	}
	in, err = s.applyOrganizationDefaults(ctx, in)
	if err != nil {
		return Record{}, err
	}
	if err := s.validateInput(ctx, in); err != nil {
		return Record{}, err
	}
	if err := s.write(ctx, id, user, in, false); err != nil {
		return Record{}, err
	}
	if previous.Priority != in.Priority {
		_ = s.audit(ctx, user, "schedule.priority_changed", "schedule", id)
	}
	if previous.Enabled != in.Enabled {
		action := "schedule.disabled"
		if in.Enabled {
			action = "schedule.enabled"
		}
		_ = s.audit(ctx, user, action, "schedule", id)
	}
	if !sameTargets(previous.Targets, in.Targets) {
		_ = s.audit(ctx, user, "schedule.targets_changed", "schedule", id)
	}
	return s.Get(ctx, id)
}
func sameTargets(a, b []Target) bool {
	if len(a) != len(b) {
		return false
	}
	m := map[string]bool{}
	for _, x := range a {
		m[x.Type+x.ID.String()] = true
	}
	for _, x := range b {
		if !m[x.Type+x.ID.String()] {
			return false
		}
	}
	return true
}
func (s *Service) write(ctx context.Context, id, user uuid.UUID, in Input, create bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	old, err := affectedForSchedule(ctx, tx, id)
	if err != nil {
		return err
	}
	if create {
		_, err = tx.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,description,playlist_id,layout_id,display_action,type,timezone,priority,enabled,start_date,end_date,one_time_start,one_time_end,daily_start,daily_end,days_of_week,created_by)SELECT $1,id,$2,$3,NULLIF($4,$19::uuid),$5,$6::jsonb,$7,$8,$9,$10,$11::date,$12::date,$13,$14,$15::time,$16::time,COALESCE($17::smallint[],'{}'::smallint[]),$18 FROM organization_settings WHERE singleton`, id, strings.TrimSpace(in.Name), in.Description, in.PlaylistID, in.LayoutID, displayActionJSON(in.DisplayAction), in.Type, in.Timezone, in.Priority, in.Enabled, in.StartDate, in.EndDate, in.OneTimeStart, in.OneTimeEnd, in.DailyStart, in.DailyEnd, in.DaysOfWeek, user, uuid.Nil)
	} else {
		tag, e := tx.Exec(ctx, `UPDATE schedules SET name=$2,description=$3,playlist_id=NULLIF($4,$18::uuid),layout_id=$5,display_action=$6::jsonb,type=$7,timezone=$8,priority=$9,enabled=$10,start_date=$11::date,end_date=$12::date,one_time_start=$13,one_time_end=$14,daily_start=$15::time,daily_end=$16::time,days_of_week=COALESCE($17::smallint[],'{}'::smallint[]),updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, strings.TrimSpace(in.Name), in.Description, in.PlaylistID, in.LayoutID, displayActionJSON(in.DisplayAction), in.Type, in.Timezone, in.Priority, in.Enabled, in.StartDate, in.EndDate, in.OneTimeStart, in.OneTimeEnd, in.DailyStart, in.DailyEnd, in.DaysOfWeek, uuid.Nil)
		err = e
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM schedule_targets WHERE schedule_id=$1`, id); err != nil {
		return err
	}
	for _, t := range in.Targets {
		var tag pgconn.CommandTag
		if t.Type == "screen" {
			tag, err = tx.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_id)SELECT $1,'screen',sc.id FROM screens sc JOIN schedules s ON s.id=$1 AND s.organization_id=sc.organization_id WHERE sc.id=$2`, id, t.ID)
		} else {
			tag, err = tx.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_group_id)SELECT $1,'group',g.id FROM screen_groups g JOIN schedules s ON s.id=$1 AND s.organization_id=g.organization_id WHERE g.id=$2 AND g.deleted_at IS NULL`, id, t.ID)
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("schedule target is invalid or belongs to another organization")
		}
	}
	now, err := affectedForSchedule(ctx, tx, id)
	if err != nil {
		return err
	}
	notes, err := bumpScreens(ctx, tx, union(old, now), "schedule.changed")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	action := "schedule.updated"
	if create {
		action = "schedule.created"
	}
	_ = s.audit(ctx, user, action, "schedule", id)
	return nil
}
func (s *Service) Delete(ctx context.Context, id, user uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ids, err := affectedForSchedule(ctx, tx, id)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE schedules SET deleted_at=now(),enabled=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	notes, err := bumpScreens(ctx, tx, ids, "schedule.deleted")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	_ = s.audit(ctx, user, "schedule.deleted", "schedule", id)
	return nil
}
func (s *Service) SetEnabled(ctx context.Context, id, user uuid.UUID, enabled bool) (Record, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback(ctx)
	ids, err := affectedForSchedule(ctx, tx, id)
	if err != nil {
		return Record{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE schedules SET enabled=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, enabled)
	if err != nil {
		return Record{}, err
	}
	if tag.RowsAffected() == 0 {
		return Record{}, ErrNotFound
	}
	notes, err := bumpScreens(ctx, tx, ids, "schedule.enabled_changed")
	if err != nil {
		return Record{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Record{}, err
	}
	s.notify(notes)
	action := "schedule.disabled"
	if enabled {
		action = "schedule.enabled"
	}
	_ = s.audit(ctx, user, action, "schedule", id)
	return s.Get(ctx, id)
}

const recordSelect = `SELECT s.id,s.name,s.description,COALESCE(s.playlist_id,'00000000-0000-0000-0000-000000000000'::uuid),COALESCE(p.name,l.name,''),s.layout_id,l.name,CASE WHEN s.display_action IS NOT NULL THEN 'display_control' WHEN s.layout_id IS NOT NULL THEN 'layout' ELSE 'playlist' END,s.display_action,s.type,s.timezone,s.priority,s.enabled,to_char(s.start_date,'YYYY-MM-DD'),to_char(s.end_date,'YYYY-MM-DD'),s.one_time_start,s.one_time_end,to_char(s.daily_start,'HH24:MI'),to_char(s.daily_end,'HH24:MI'),s.days_of_week,s.created_at,s.updated_at FROM schedules s LEFT JOIN playlists p ON p.id=s.playlist_id LEFT JOIN layouts l ON l.id=s.layout_id`

func scanRecord(row pgx.Row) (Record, error) {
	var r Record
	var actionJSON []byte
	err := row.Scan(&r.ID, &r.Name, &r.Description, &r.PlaylistID, &r.PlaylistName, &r.LayoutID, &r.LayoutName, &r.PresentationType, &actionJSON, &r.Type, &r.Timezone, &r.Priority, &r.Enabled, &r.StartDate, &r.EndDate, &r.OneTimeStart, &r.OneTimeEnd, &r.DailyStart, &r.DailyEnd, &r.DaysOfWeek, &r.CreatedAt, &r.UpdatedAt)
	if err == nil && len(actionJSON) > 0 {
		var action displaycontrol.Action
		if e := json.Unmarshal(actionJSON, &action); e != nil {
			return r, e
		}
		r.DisplayAction = &action
	}
	r.Targets = []Target{}
	return r, err
}

func displayActionJSON(action *displaycontrol.Action) any {
	if action == nil {
		return nil
	}
	raw, err := json.Marshal(action)
	if err != nil {
		return nil
	}
	return string(raw)
}
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Record, error) {
	r, err := scanRecord(s.db.QueryRow(ctx, recordSelect+` WHERE s.id=$1 AND s.deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	r.Targets, err = s.targets(ctx, id)
	return r, err
}
func (s *Service) List(ctx context.Context, search string, page, size int) (List, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 50
	}
	var out List
	out.Page, out.PageSize = page, size
	if err := s.db.QueryRow(ctx, `SELECT default_timezone FROM organization_settings WHERE singleton`).Scan(&out.DefaultTimezone); err != nil {
		return out, err
	}
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM schedules WHERE deleted_at IS NULL AND ($1='' OR name ILIKE '%'||$1||'%')`, strings.TrimSpace(search)).Scan(&out.Total); err != nil {
		return out, err
	}
	rows, err := s.db.Query(ctx, recordSelect+` WHERE s.deleted_at IS NULL AND ($1='' OR s.name ILIKE '%'||$1||'%') ORDER BY s.updated_at DESC,s.id LIMIT $2 OFFSET $3`, strings.TrimSpace(search), size, (page-1)*size)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	out.Items = []Record{}
	for rows.Next() {
		r, er := scanRecord(rows)
		if er != nil {
			return out, er
		}
		r.Targets, er = s.targets(ctx, r.ID)
		if er != nil {
			return out, er
		}
		out.Items = append(out.Items, r)
	}
	return out, rows.Err()
}
func (s *Service) targets(ctx context.Context, id uuid.UUID) ([]Target, error) {
	rows, err := s.db.Query(ctx, `SELECT t.target_type,COALESCE(t.screen_id,t.screen_group_id),COALESCE(sc.name,g.name) FROM schedule_targets t LEFT JOIN screens sc ON sc.id=t.screen_id LEFT JOIN screen_groups g ON g.id=t.screen_group_id WHERE t.schedule_id=$1 ORDER BY t.target_type,COALESCE(sc.name,g.name),COALESCE(t.screen_id,t.screen_group_id)`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Target{}
	for rows.Next() {
		var t Target
		if err = rows.Scan(&t.Type, &t.ID, &t.Name); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
func (s *Service) Relevant(ctx context.Context, screen uuid.UUID) ([]Record, error) {
	rows, err := s.db.Query(ctx, recordSelect+` WHERE s.deleted_at IS NULL AND s.enabled AND EXISTS(SELECT 1 FROM schedule_targets t WHERE t.schedule_id=s.id AND (t.screen_id=$1 OR EXISTS(SELECT 1 FROM screen_group_memberships m WHERE m.screen_group_id=t.screen_group_id AND m.screen_id=$1))) ORDER BY s.id`, screen)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		r, er := scanRecord(rows)
		if er != nil {
			return nil, er
		}
		var direct bool
		if er = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schedule_targets WHERE schedule_id=$1 AND screen_id=$2)`, r.ID, screen).Scan(&direct); er != nil {
			return nil, er
		}
		if direct {
			r.Specificity = 1
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type Preview struct {
	ScreenID                 uuid.UUID  `json:"screenId"`
	At                       time.Time  `json:"at"`
	WinningSchedule          *Record    `json:"winningSchedule,omitempty"`
	WinningPlaylistID        *uuid.UUID `json:"winningPlaylistId,omitempty"`
	DirectFallbackPlaylistID *uuid.UUID `json:"directFallbackPlaylistId,omitempty"`
	Applicable               []Record   `json:"applicableSchedules"`
	NextTransition           *time.Time `json:"nextTransition,omitempty"`
	Conflicts                []string   `json:"conflicts"`
}

func (s *Service) Preview(ctx context.Context, screen uuid.UUID, at time.Time, proposed *Input) (Preview, error) {
	var screenOK bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens sc JOIN organization_settings o ON o.id=sc.organization_id AND o.singleton WHERE sc.id=$1)`, screen).Scan(&screenOK); err != nil {
		return Preview{}, err
	}
	if !screenOK {
		return Preview{}, ErrNotFound
	}
	records, err := s.Relevant(ctx, screen)
	if err != nil {
		return Preview{}, err
	}
	if proposed != nil {
		normalized, normalizeErr := s.normalizeSyncGroupTargets(ctx, *proposed)
		if normalizeErr != nil {
			return Preview{}, normalizeErr
		}
		proposed = &normalized
		*proposed, err = s.applyOrganizationDefaults(ctx, *proposed)
		if err != nil {
			return Preview{}, err
		}
		if err = s.validateInput(ctx, *proposed); err != nil {
			return Preview{}, err
		}
		specificity := -1
		for _, t := range proposed.Targets {
			if t.Type == "screen" && t.ID == screen {
				specificity = 1
			}
			if t.Type == "group" {
				var member bool
				_ = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_group_memberships WHERE screen_group_id=$1 AND screen_id=$2)`, t.ID, screen).Scan(&member)
				if member && specificity < 0 {
					specificity = 0
				}
			}
		}
		if specificity >= 0 {
			records = append(records, Record{Schedule: Schedule{ID: uuid.Nil, PlaylistID: proposed.PlaylistID, LayoutID: proposed.LayoutID, DisplayAction: proposed.DisplayAction, Type: proposed.Type, Timezone: proposed.Timezone, Priority: proposed.Priority, Specificity: specificity, Enabled: proposed.Enabled, StartDate: proposed.StartDate, EndDate: proposed.EndDate, OneTimeStart: proposed.OneTimeStart, OneTimeEnd: proposed.OneTimeEnd, DailyStart: proposed.DailyStart, DailyEnd: proposed.DailyEnd, DaysOfWeek: proposed.DaysOfWeek}, Name: proposed.Name})
		}
	}
	base := make([]Schedule, len(records))
	for i := range records {
		base[i] = records[i].Schedule
	}
	resolved := Resolve(at, base)
	out := Preview{ScreenID: screen, At: at, Applicable: []Record{}, NextTransition: resolved.NextTransition, Conflicts: []string{}}
	var fallback uuid.UUID
	if e := s.db.QueryRow(ctx, `SELECT COALESCE(group_assignment.playlist_id,screen_assignment.playlist_id) FROM screens sc LEFT JOIN screen_group_memberships membership ON membership.screen_id=sc.id LEFT JOIN screen_group_playlist_assignments group_assignment ON group_assignment.screen_group_id=membership.screen_group_id LEFT JOIN screen_playlist_assignments screen_assignment ON screen_assignment.screen_id=sc.id WHERE sc.id=$1`, screen).Scan(&fallback); e == nil {
		out.DirectFallbackPlaylistID = &fallback
		out.WinningPlaylistID = &fallback
	}
	for _, a := range resolved.Applicable {
		for _, r := range records {
			if r.ID == a.Schedule.ID {
				out.Applicable = append(out.Applicable, r)
				break
			}
		}
	}
	if resolved.Winner != nil {
		for _, r := range records {
			if r.ID == resolved.Winner.Schedule.ID {
				x := r
				out.WinningSchedule = &x
				out.WinningPlaylistID = &x.PlaylistID
				break
			}
		}
	}
	if len(out.Applicable) > 1 {
		out.Conflicts = append(out.Conflicts, fmt.Sprintf("%d active schedules overlap; precedence selects %s", len(out.Applicable), out.Applicable[0].Name))
	}
	return out, nil
}

type note struct {
	id      uuid.UUID
	version int64
}

func affectedForSchedule(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `SELECT DISTINCT x.screen_id FROM (SELECT t.screen_id FROM schedule_targets t WHERE t.schedule_id=$1 AND t.screen_id IS NOT NULL UNION SELECT m.screen_id FROM schedule_targets t JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE t.schedule_id=$1)x`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var x uuid.UUID
		if err = rows.Scan(&x); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
func bumpGroupScreens(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) ([]note, error) {
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason)SELECT screen_id,1,$2 FROM screen_group_memberships WHERE screen_group_id=$1 ON CONFLICT(screen_id)DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING screen_id,manifest_version`, id, reason)
	return scanNotes(rows, err)
}
func bumpScreens(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, reason string) ([]note, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason)SELECT unnest($1::uuid[]),1,$2 ON CONFLICT(screen_id)DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING screen_id,manifest_version`, ids, reason)
	return scanNotes(rows, err)
}
func scanNotes(rows pgx.Rows, err error) ([]note, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []note{}
	for rows.Next() {
		var n note
		if err = rows.Scan(&n.id, &n.version); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
func union(a, b []uuid.UUID) []uuid.UUID {
	m := map[uuid.UUID]bool{}
	for _, x := range append(a, b...) {
		m[x] = true
	}
	out := make([]uuid.UUID, 0, len(m))
	for x := range m {
		out = append(out, x)
	}
	return out
}
func (s *Service) notify(ns []note) {
	if s.notifier != nil {
		for _, n := range ns {
			s.notifier.ManifestChanged(n.id, n.version)
		}
	}
}
func (s *Service) audit(ctx context.Context, user uuid.UUID, action, resource string, id uuid.UUID) error {
	_, err := s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,$4,$5)`, uuid.New(), user, action, resource, id.String())
	return err
}
func (s *Service) Config() (int, int, int) {
	clock := s.limits.ClockSkewWarningSeconds
	if clock <= 0 {
		clock = 300
	}
	return s.limits.PrefetchDays, s.limits.ActivationGraceSeconds, clock
}

func (s *Service) ConfigFor(ctx context.Context) (int, int, int, error) {
	prefetch, grace, clock := s.Config()
	if s.organizationValues == nil {
		return prefetch, grace, clock, nil
	}
	values, err := s.organizationValues.OrganizationValues(ctx)
	if err != nil {
		return 0, 0, 0, err
	}
	if value := settingInt(values, "scheduling.prefetch_days", prefetch); value > 0 {
		prefetch = value
	}
	if value := settingInt(values, "scheduling.activation_grace_seconds", grace); value > 0 {
		grace = value
	}
	if value := settingInt(values, "scheduling.clock_skew_warning_seconds", clock); value > 0 {
		clock = value
	}
	return prefetch, grace, clock, nil
}
