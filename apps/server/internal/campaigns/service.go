// Package campaigns models coordinated deployments as immutable release
// snapshots that materialize into Tilecast's ordinary scheduler rows. Players
// do not know that a schedule came from a Campaign.
package campaigns

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/editorial"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

var (
	ErrNotFound = errors.New("campaign not found")
	ErrConflict = errors.New("campaign conflict")
	ErrInvalid  = errors.New("campaign is invalid")
)

type Notifier interface{ ManifestChanged(uuid.UUID, int64) }

type PresentationChecker interface {
	ValidatePresentationInTx(context.Context, pgx.Tx, string, uuid.UUID, time.Time) error
}

type Destination struct {
	Type string    `json:"type"`
	ID   uuid.UUID `json:"id"`
}

type Block struct {
	ID              uuid.UUID  `json:"id"`
	Name            string     `json:"name"`
	ContentType     string     `json:"contentType"`
	ContentID       uuid.UUID  `json:"contentId"`
	ContentRevision int64      `json:"contentRevision,omitempty"`
	Priority        int        `json:"priority"`
	Type            string     `json:"type"`
	Timezone        string     `json:"timezone"`
	StartDate       *string    `json:"startDate,omitempty"`
	EndDate         *string    `json:"endDate,omitempty"`
	OneTimeStart    *time.Time `json:"oneTimeStart,omitempty"`
	OneTimeEnd      *time.Time `json:"oneTimeEnd,omitempty"`
	DailyStart      *string    `json:"dailyStart,omitempty"`
	DailyEnd        *string    `json:"dailyEnd,omitempty"`
	DaysOfWeek      []int      `json:"daysOfWeek,omitempty"`
	Enabled         bool       `json:"enabled"`
}

type Snapshot struct {
	Name          string        `json:"name"`
	Description   string        `json:"description"`
	OwnerID       *uuid.UUID    `json:"ownerId,omitempty"`
	Timezone      string        `json:"timezone"`
	CampaignStart *time.Time    `json:"campaignStart,omitempty"`
	CampaignEnd   *time.Time    `json:"campaignEnd,omitempty"`
	Destinations  []Destination `json:"destinations"`
	Blocks        []Block       `json:"blocks"`
}

type Campaign struct {
	ID            uuid.UUID     `json:"id"`
	Name          string        `json:"name"`
	Description   string        `json:"description"`
	OwnerID       *uuid.UUID    `json:"ownerId,omitempty"`
	Timezone      string        `json:"timezone"`
	CampaignStart *time.Time    `json:"campaignStart,omitempty"`
	CampaignEnd   *time.Time    `json:"campaignEnd,omitempty"`
	Destinations  []Destination `json:"destinations"`
	Draft         Snapshot      `json:"draft"`
	DraftRevision int64         `json:"draftRevision"`
	Status        string        `json:"status"`
	CreatedAt     time.Time     `json:"createdAt"`
	UpdatedAt     time.Time     `json:"updatedAt"`
}

type Release struct {
	ID             uuid.UUID       `json:"id"`
	CampaignID     uuid.UUID       `json:"campaignId"`
	ReleaseNumber  int64           `json:"releaseNumber"`
	SubmissionID   *uuid.UUID      `json:"submissionId,omitempty"`
	Snapshot       json.RawMessage `json:"snapshot"`
	SnapshotSHA256 string          `json:"snapshotSha256"`
	Status         string          `json:"status"`
	BasedReleaseID *uuid.UUID      `json:"basedReleaseId,omitempty"`
	PublishedBy    *uuid.UUID      `json:"publishedBy,omitempty"`
	PublishedAt    *time.Time      `json:"publishedAt,omitempty"`
	RequestedAt    *time.Time      `json:"requestedPublicationAt,omitempty"`
	FailureReason  string          `json:"failureReason,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
}

type PreflightIssue struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	BlockID  string `json:"blockId,omitempty"`
}

const maxPreflightPreviewScreens = 10

type Preflight struct {
	Valid                bool             `json:"valid"`
	Issues               []PreflightIssue `json:"issues"`
	BlockCount           int              `json:"blockCount"`
	DestinationCount     int              `json:"destinationCount"`
	ScreenCount          int              `json:"screenCount"`
	LocationCount        int              `json:"locationCount"`
	PreviewedScreenCount int              `json:"previewedScreenCount"`
	PreviewScreenLimit   int              `json:"previewScreenLimit"`
}

type Service struct {
	db        *pgxpool.Pool
	notifier  Notifier
	checker   PresentationChecker
	scheduler *scheduling.Service
	limits    scheduling.Limits
}

func NewService(db *pgxpool.Pool, notifier Notifier) *Service {
	return &Service{db: db, notifier: notifier}
}

func (s *Service) SetPresentationChecker(checker PresentationChecker) { s.checker = checker }

func (s *Service) SetScheduler(scheduler *scheduling.Service) { s.scheduler = scheduler }

func (s *Service) SetSchedulingLimits(limits scheduling.Limits) { s.limits = limits }

func defaultSnapshot(name, description, timezone string, owner uuid.UUID) Snapshot {
	if strings.TrimSpace(timezone) == "" {
		timezone = "UTC"
	}
	return Snapshot{Name: strings.TrimSpace(name), Description: strings.TrimSpace(description), OwnerID: &owner, Timezone: timezone, Destinations: []Destination{}, Blocks: []Block{}}
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, name, description, timezone string) (Campaign, error) {
	draft := defaultSnapshot(name, description, timezone, userID)
	if err := validateCampaignMetadata(draft); err != nil {
		return Campaign{}, err
	}
	raw, _ := json.Marshal(draft)
	id := ids.New(ctx)
	_, err := s.db.Exec(ctx, `INSERT INTO campaigns(id,organization_id,name,description,owner_id,timezone,campaign_start,campaign_end,destinations,draft,draft_revision,created_by,updated_by) SELECT $1,id,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,1,$4,$4 FROM organization_settings WHERE singleton`, id, draft.Name, draft.Description, userID, draft.Timezone, draft.CampaignStart, draft.CampaignEnd, `[]`, string(raw))
	if err != nil {
		return Campaign{}, err
	}
	_ = s.audit(ctx, userID, "campaign.created", id)
	return s.Get(ctx, id)
}

func (s *Service) List(ctx context.Context, search string, page, pageSize int) ([]Campaign, int, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 50
	}
	search = strings.TrimSpace(search)
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM campaigns WHERE archived_at IS NULL AND ($1='' OR name ILIKE '%'||$1||'%')`, search).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT c.id,c.name,c.description,c.owner_id,c.timezone,c.campaign_start,c.campaign_end,
		       c.draft,c.draft_revision,c.created_at,c.updated_at,r.snapshot
		FROM campaigns c
		LEFT JOIN LATERAL (
			SELECT snapshot FROM campaign_releases
			WHERE campaign_id=c.id AND status='published'
			ORDER BY release_number DESC LIMIT 1
		) r ON TRUE
		WHERE c.archived_at IS NULL AND ($1='' OR c.name ILIKE '%'||$1||'%')
		ORDER BY c.updated_at DESC,c.id LIMIT $2 OFFSET $3`, search, pageSize, (page-1)*pageSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Campaign{}
	now := time.Now().UTC()
	for rows.Next() {
		var item Campaign
		var raw, publishedRaw []byte
		if err = rows.Scan(&item.ID, &item.Name, &item.Description, &item.OwnerID, &item.Timezone, &item.CampaignStart, &item.CampaignEnd, &raw, &item.DraftRevision, &item.CreatedAt, &item.UpdatedAt, &publishedRaw); err != nil {
			return nil, 0, err
		}
		if err = json.Unmarshal(raw, &item.Draft); err != nil {
			return nil, 0, err
		}
		item.Destinations = item.Draft.Destinations
		item.Status, err = campaignLifecycle(false, publishedRaw, now)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Campaign, error) {
	var c Campaign
	var raw, publishedRaw []byte
	var archived bool
	err := s.db.QueryRow(ctx, `
		SELECT c.id,c.name,c.description,c.owner_id,c.timezone,c.campaign_start,c.campaign_end,
		       c.draft,c.draft_revision,c.created_at,c.updated_at,c.archived_at IS NOT NULL,r.snapshot
		FROM campaigns c
		LEFT JOIN LATERAL (
			SELECT snapshot FROM campaign_releases
			WHERE campaign_id=c.id AND status='published'
			ORDER BY release_number DESC LIMIT 1
		) r ON TRUE
		WHERE c.id=$1`, id).Scan(&c.ID, &c.Name, &c.Description, &c.OwnerID, &c.Timezone, &c.CampaignStart, &c.CampaignEnd, &raw, &c.DraftRevision, &c.CreatedAt, &c.UpdatedAt, &archived, &publishedRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Campaign{}, ErrNotFound
	}
	if err != nil {
		return Campaign{}, err
	}
	if err = json.Unmarshal(raw, &c.Draft); err != nil {
		return Campaign{}, err
	}
	c.Destinations = c.Draft.Destinations
	c.Status, err = campaignLifecycle(archived, publishedRaw, time.Now().UTC())
	return c, err
}

func (s *Service) UpdateDraft(ctx context.Context, id, userID uuid.UUID, expected int64, draft Snapshot) (Campaign, error) {
	draft.Name = strings.TrimSpace(draft.Name)
	draft.Description = strings.TrimSpace(draft.Description)
	normalizeSnapshot(&draft)
	if err := validateSnapshotShape(draft); err != nil {
		return Campaign{}, err
	}
	raw, err := json.Marshal(draft)
	if err != nil {
		return Campaign{}, err
	}
	tag, err := s.db.Exec(ctx, `UPDATE campaigns SET name=$2,description=$3,owner_id=$4,timezone=$5,campaign_start=$6,campaign_end=$7,destinations=$8::jsonb,draft=$9::jsonb,draft_revision=draft_revision+1,updated_by=$10,updated_at=now() WHERE id=$1 AND archived_at IS NULL AND draft_revision=$11`, id, draft.Name, draft.Description, draft.OwnerID, draft.Timezone, draft.CampaignStart, draft.CampaignEnd, string(mustJSON(draft.Destinations)), string(raw), userID, expected)
	if err != nil {
		return Campaign{}, err
	}
	if tag.RowsAffected() == 0 {
		return Campaign{}, ErrConflict
	}
	_ = s.audit(ctx, userID, "campaign.draft_updated", id)
	return s.Get(ctx, id)
}

func (s *Service) SnapshotTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (editorial.Snapshot, error) {
	var raw []byte
	var working int64
	var c Snapshot
	if err := tx.QueryRow(ctx, `SELECT draft,draft_revision FROM campaigns WHERE id=$1 AND archived_at IS NULL FOR SHARE`, id).Scan(&raw, &working); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return editorial.Snapshot{}, ErrNotFound
		}
		return editorial.Snapshot{}, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return editorial.Snapshot{}, err
	}
	normalizeSnapshot(&c)
	if err := s.populateContentRevisionsTx(ctx, tx, &c); err != nil {
		return editorial.Snapshot{}, err
	}
	canonical, err := json.Marshal(c)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	sum := sha256.Sum256(canonical)
	var release int64
	_ = tx.QueryRow(ctx, `SELECT COALESCE(max(release_number),0) FROM campaign_releases WHERE campaign_id=$1 AND status='published'`, id).Scan(&release)
	return editorial.Snapshot{WorkingRevision: working, PublishedRevision: &release, Document: canonical, Digest: hex.EncodeToString(sum[:])}, nil
}

func (s *Service) populateContentRevisionsTx(ctx context.Context, tx pgx.Tx, snapshot *Snapshot) error {
	for i := range snapshot.Blocks {
		block := &snapshot.Blocks[i]
		var revision int64
		if block.ContentType == "playlist" {
			err := tx.QueryRow(ctx, `SELECT revision FROM playlists WHERE id=$1 AND deleted_at IS NULL`, block.ContentID).Scan(&revision)
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("%w: content block playlist is missing", ErrInvalid)
			}
			if err != nil {
				return err
			}
		} else if block.ContentType == "layout" {
			err := tx.QueryRow(ctx, `SELECT r.revision FROM layouts l JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL`, block.ContentID).Scan(&revision)
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("%w: content block Layout is missing or unpublished", ErrInvalid)
			}
			if err != nil {
				return err
			}
		} else {
			return fmt.Errorf("%w: content blocks must reference a playlist or Layout", ErrInvalid)
		}
		block.ContentRevision = revision
	}
	return nil
}

func (s *Service) ValidateSnapshotTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, raw json.RawMessage) error {
	var snapshot Snapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	if err := validateSnapshotShape(snapshot); err != nil {
		return err
	}
	if len(snapshot.Blocks) == 0 {
		return fmt.Errorf("%w: campaign needs at least one content block", ErrInvalid)
	}
	if len(snapshot.Destinations) == 0 {
		return fmt.Errorf("%w: campaign needs at least one destination", ErrInvalid)
	}
	if _, err := time.LoadLocation(snapshot.Timezone); err != nil {
		return fmt.Errorf("%w: timezone is invalid", ErrInvalid)
	}
	if s.limits.MaxTargetsPerSchedule > 0 && len(snapshot.Destinations) > s.limits.MaxTargetsPerSchedule {
		return fmt.Errorf("%w: campaign blocks may target at most %d screens or groups", ErrInvalid, s.limits.MaxTargetsPerSchedule)
	}
	if s.limits.MaxSchedules > 0 {
		var activeSchedules int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM schedules WHERE deleted_at IS NULL AND (campaign_id IS NULL OR campaign_id<>$1)`, id).Scan(&activeSchedules); err != nil {
			return err
		}
		if activeSchedules+len(snapshot.Blocks) > s.limits.MaxSchedules {
			return fmt.Errorf("%w: publishing this campaign would exceed the %d-schedule limit", ErrInvalid, s.limits.MaxSchedules)
		}
	}
	if s.checker != nil {
		for _, block := range snapshot.Blocks {
			if err := s.checker.ValidatePresentationInTx(ctx, tx, block.ContentType, block.ContentID, time.Now().UTC()); err != nil {
				return fmt.Errorf("%w: block %s: %v", ErrInvalid, block.ID, err)
			}
		}
	}
	for _, block := range snapshot.Blocks {
		if err := s.validatePublishedRootTx(ctx, tx, block); err != nil {
			return err
		}
		if err := scheduling.Validate(scheduling.Schedule{PlaylistID: playlistID(block), LayoutID: layoutID(block), Type: scheduling.Kind(block.Type), Timezone: block.Timezone, Priority: block.Priority, Enabled: block.Enabled, StartDate: block.StartDate, EndDate: block.EndDate, OneTimeStart: block.OneTimeStart, OneTimeEnd: block.OneTimeEnd, DailyStart: block.DailyStart, DailyEnd: block.DailyEnd, DaysOfWeek: block.DaysOfWeek}); err != nil {
			return fmt.Errorf("%w: block %s: %v", ErrInvalid, block.ID, err)
		}
	}
	return s.validateDestinationsTx(ctx, tx, snapshot.Destinations)
}

func (s *Service) validatePublishedRootTx(ctx context.Context, tx pgx.Tx, block Block) error {
	var revision int64
	var contentType string
	if block.ContentType == "playlist" {
		contentType = "playlist"
		if err := tx.QueryRow(ctx, `SELECT revision FROM playlists WHERE id=$1 AND deleted_at IS NULL`, block.ContentID).Scan(&revision); err != nil {
			return fmt.Errorf("%w: playlist block %s is missing", ErrInvalid, block.ID)
		}
	} else if block.ContentType == "layout" {
		contentType = "layout"
		if err := tx.QueryRow(ctx, `SELECT r.revision FROM layouts l JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL`, block.ContentID).Scan(&revision); err != nil {
			return fmt.Errorf("%w: Layout block %s is missing or unpublished", ErrInvalid, block.ID)
		}
	}
	var authorized bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM publication_history WHERE content_type=$1 AND content_id=$2 AND content_revision=$3) OR EXISTS(SELECT 1 FROM content_reviews WHERE content_type=$1 AND content_id=$2 AND revision=$3 AND decision='approved')`, contentType, block.ContentID, revision).Scan(&authorized); err != nil {
		return err
	}
	if !authorized {
		return fmt.Errorf("%w: %s block %s has no authorized published revision", ErrInvalid, contentType, block.ID)
	}
	return nil
}

func playlistID(block Block) uuid.UUID {
	if block.ContentType == "playlist" {
		return block.ContentID
	}
	return uuid.Nil
}
func layoutID(block Block) *uuid.UUID {
	if block.ContentType == "layout" {
		value := block.ContentID
		return &value
	}
	return nil
}

func (s *Service) validateDestinationsTx(ctx context.Context, tx pgx.Tx, destinations []Destination) error {
	if len(destinations) == 0 {
		return fmt.Errorf("%w: campaign needs at least one destination", ErrInvalid)
	}
	for _, destination := range destinations {
		var exists bool
		if destination.Type == "screen" {
			exists = false
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens WHERE id=$1 AND archived_at IS NULL)`, destination.ID).Scan(&exists); err != nil {
				return err
			}
		} else if destination.Type == "group" {
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_groups WHERE id=$1 AND deleted_at IS NULL)`, destination.ID).Scan(&exists); err != nil {
				return err
			}
		} else {
			return fmt.Errorf("%w: destination type is invalid", ErrInvalid)
		}
		if !exists {
			return fmt.Errorf("%w: destination %s is missing", ErrInvalid, destination.ID)
		}
	}
	return nil
}

func (s *Service) PublishSnapshotTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, raw json.RawMessage, _ int64, userID uuid.UUID) (editorial.Published, error) {
	if err := s.ValidateSnapshotTx(ctx, tx, id, raw); err != nil {
		return editorial.Published{}, err
	}
	var snapshot Snapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return editorial.Published{}, err
	}
	// Verify root revision drift at the publication boundary. The reviewed
	// deployment cannot silently pick up a later Playlist/Layout publication.
	var lockedID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM campaigns WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, id).Scan(&lockedID); err != nil {
		return editorial.Published{}, ErrNotFound
	}
	for _, block := range snapshot.Blocks {
		var revision int64
		if block.ContentType == "playlist" {
			if err := tx.QueryRow(ctx, `SELECT revision FROM playlists WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, block.ContentID).Scan(&revision); err != nil {
				return editorial.Published{}, err
			}
		} else if err := tx.QueryRow(ctx, `SELECT r.revision FROM layouts l JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL FOR SHARE OF l`, block.ContentID).Scan(&revision); err != nil {
			return editorial.Published{}, err
		}
		if block.ContentRevision != revision {
			return editorial.Published{}, fmt.Errorf("%w: content block %s changed after submission; refresh and resubmit", ErrConflict, block.ID)
		}
	}
	var submissionID *uuid.UUID
	var releaseID uuid.UUID
	var releaseNumber int64
	var basedReleaseID *uuid.UUID
	_ = tx.QueryRow(ctx, `SELECT id FROM campaign_releases WHERE campaign_id=$1 AND status='published' ORDER BY release_number DESC LIMIT 1`, id).Scan(&basedReleaseID)
	if err := tx.QueryRow(ctx, `SELECT id FROM content_submissions WHERE content_type='campaign' AND content_id=$1 AND snapshot=$2::jsonb AND status IN ('approved','scheduled','in_review') ORDER BY submitted_at DESC LIMIT 1`, id, string(raw)).Scan(&submissionID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return editorial.Published{}, err
	}
	if submissionID == nil {
		return editorial.Published{}, fmt.Errorf("%w: campaign publication requires a content submission", ErrConflict)
	}
	if err := tx.QueryRow(ctx, `SELECT id,release_number FROM campaign_releases WHERE campaign_id=$1 AND submission_id=$2`, id, *submissionID).Scan(&releaseID, &releaseNumber); errors.Is(err, pgx.ErrNoRows) {
		releaseNumber = 1
		_ = tx.QueryRow(ctx, `SELECT COALESCE(max(release_number),0)+1 FROM campaign_releases WHERE campaign_id=$1`, id).Scan(&releaseNumber)
		releaseID = uuid.New()
		if _, err = tx.Exec(ctx, `INSERT INTO campaign_releases(id,campaign_id,release_number,submission_id,snapshot,snapshot_sha256,status,based_release_id,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,'published',$7,$8)`, releaseID, id, releaseNumber, *submissionID, mustJSON(snapshot), snapshotDigest(snapshot), basedReleaseID, userID); err != nil {
			return editorial.Published{}, err
		}
	} else if err != nil {
		return editorial.Published{}, err
	}
	oldScreens, err := campaignAffectedScreens(ctx, tx, id)
	if err != nil {
		return editorial.Published{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE schedules SET deleted_at=now(),enabled=FALSE,updated_at=now() WHERE campaign_id=$1 AND deleted_at IS NULL`, id); err != nil {
		return editorial.Published{}, err
	}
	for _, block := range snapshot.Blocks {
		if block.ID == uuid.Nil {
			block.ID = uuid.New()
		}
		scheduleID := uuid.New()
		if _, err = tx.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,description,playlist_id,layout_id,type,timezone,priority,enabled,start_date,end_date,one_time_start,one_time_end,daily_start,daily_end,days_of_week,created_by,campaign_id,campaign_release_id,campaign_block_id) SELECT $1,organization_id,$2,$3,NULLIF($4,'00000000-0000-0000-0000-000000000000'::uuid),$5,$6,$7,$8,$9,COALESCE($10::date,campaign_start::date),COALESCE($11::date,campaign_end::date),$12,$13,$14::time,$15::time,COALESCE($16::smallint[],'{}'::smallint[]),$17,$18,$19,$20 FROM campaigns WHERE id=$18`, scheduleID, block.Name, snapshot.Description, playlistID(block), layoutID(block), block.Type, block.Timezone, block.Priority, block.Enabled, block.StartDate, block.EndDate, block.OneTimeStart, block.OneTimeEnd, block.DailyStart, block.DailyEnd, block.DaysOfWeek, userID, id, releaseID, block.ID); err != nil {
			return editorial.Published{}, err
		}
		for _, destination := range snapshot.Destinations {
			if destination.Type == "screen" {
				_, err = tx.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_id) VALUES($1,'screen',$2)`, scheduleID, destination.ID)
			} else {
				_, err = tx.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_group_id) VALUES($1,'group',$2)`, scheduleID, destination.ID)
			}
			if err != nil {
				return editorial.Published{}, err
			}
		}
	}
	newScreens, err := campaignDestinationScreens(ctx, tx, snapshot.Destinations)
	if err != nil {
		return editorial.Published{}, err
	}
	changes, err := bumpScreens(ctx, tx, unionScreens(oldScreens, newScreens), "campaign.published")
	if err != nil {
		return editorial.Published{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE campaign_releases SET status='published',published_by=$2,published_at=now() WHERE id=$1`, releaseID, userID); err != nil {
		return editorial.Published{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE campaign_releases SET status='superseded' WHERE campaign_id=$1 AND id<>$2 AND status='published'`, id, releaseID); err != nil {
		return editorial.Published{}, err
	}
	return editorial.Published{Revision: releaseNumber, RevisionID: &releaseID, Changes: changes, AffectedScreens: len(changes)}, nil
}

func snapshotDigest(snapshot Snapshot) string {
	raw, _ := json.Marshal(snapshot)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (s *Service) RestoreDraftTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, raw json.RawMessage, userID uuid.UUID) error {
	var snapshot Snapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	normalizeSnapshot(&snapshot)
	raw = mustJSON(snapshot)
	if err := s.ValidateSnapshotTx(ctx, tx, id, raw); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE campaigns SET name=$2,description=$3,owner_id=$4,timezone=$5,campaign_start=$6,campaign_end=$7,destinations=$8::jsonb,draft=$9::jsonb,draft_revision=draft_revision+1,updated_by=$10,updated_at=now() WHERE id=$1 AND archived_at IS NULL`, id, snapshot.Name, snapshot.Description, snapshot.OwnerID, snapshot.Timezone, snapshot.CampaignStart, snapshot.CampaignEnd, string(mustJSON(snapshot.Destinations)), string(raw), userID)
	return err
}

func (s *Service) NotifyPublication(changes []manifestchanges.Change) {
	for _, change := range changes {
		if s.notifier != nil {
			s.notifier.ManifestChanged(change.ScreenID, change.Version)
		}
	}
}

func (s *Service) Preflight(ctx context.Context, id uuid.UUID) (Preflight, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Preflight{}, err
	}
	defer tx.Rollback(ctx)
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT draft FROM campaigns WHERE id=$1 AND archived_at IS NULL`, id).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Preflight{}, ErrNotFound
		}
		return Preflight{}, err
	}
	var snapshot Snapshot
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		return Preflight{}, err
	}
	normalizeSnapshot(&snapshot)
	result := Preflight{Valid: true, Issues: []PreflightIssue{}, BlockCount: len(snapshot.Blocks), DestinationCount: len(snapshot.Destinations), PreviewScreenLimit: maxPreflightPreviewScreens}
	var screens []uuid.UUID
	// Resolve the exact root revisions that a submission would freeze. This is
	// intentionally the same provider path used by Submit, rather than a
	// shallow read of the mutable campaign draft.
	if err = s.populateContentRevisionsTx(ctx, tx, &snapshot); err != nil {
		result.Valid = false
		result.Issues = append(result.Issues, PreflightIssue{Severity: "error", Code: "content_reference", Message: err.Error()})
	} else if canonical, marshalErr := json.Marshal(snapshot); marshalErr != nil {
		result.Valid = false
		result.Issues = append(result.Issues, PreflightIssue{Severity: "error", Code: "invalid", Message: marshalErr.Error()})
	} else if err = s.ValidateSnapshotTx(ctx, tx, id, canonical); err != nil {
		result.Valid = false
		result.Issues = append(result.Issues, PreflightIssue{Severity: "error", Code: "invalid", Message: err.Error()})
	}
	if resolvedScreens, screenErr := campaignDestinationScreens(ctx, tx, snapshot.Destinations); screenErr != nil {
		result.Valid = false
		result.Issues = append(result.Issues, PreflightIssue{Severity: "error", Code: "destination", Message: screenErr.Error()})
	} else {
		screens = resolvedScreens
		result.ScreenCount = len(resolvedScreens)
		if len(resolvedScreens) > 0 {
			if countErr := tx.QueryRow(ctx, `SELECT count(DISTINCT location_id) FROM screens WHERE id=ANY($1::uuid[]) AND location_id IS NOT NULL AND archived_at IS NULL`, resolvedScreens).Scan(&result.LocationCount); countErr != nil {
				return Preflight{}, countErr
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Preflight{}, err
	}
	if s.scheduler != nil && len(screens) > 0 && len(snapshot.Blocks) > 0 {
		previewScreens := screens
		if len(previewScreens) > maxPreflightPreviewScreens {
			previewScreens = previewScreens[:maxPreflightPreviewScreens]
			result.Issues = append(result.Issues, PreflightIssue{
				Severity: "warning",
				Code:     "schedule_preview_sampled",
				Message:  fmt.Sprintf("Schedule overlap checks sampled %d of %d target screens; all destinations and content references were still validated.", len(previewScreens), len(screens)),
			})
		}
		result.PreviewedScreenCount = len(previewScreens)
		seenConflicts := map[string]bool{}
		now := time.Now().UTC()
		for _, screen := range previewScreens {
			for _, block := range snapshot.Blocks {
				input := scheduling.Input{
					Name: block.Name, Description: snapshot.Description, PlaylistID: playlistID(block), LayoutID: layoutID(block), Type: scheduling.Kind(block.Type), Timezone: block.Timezone,
					Priority: block.Priority, Enabled: block.Enabled, StartDate: block.StartDate, EndDate: block.EndDate, OneTimeStart: block.OneTimeStart, OneTimeEnd: block.OneTimeEnd,
					DailyStart: block.DailyStart, DailyEnd: block.DailyEnd, DaysOfWeek: block.DaysOfWeek,
				}
				for _, destination := range snapshot.Destinations {
					input.Targets = append(input.Targets, scheduling.Target{Type: destination.Type, ID: destination.ID})
				}
				preview, previewErr := s.scheduler.Preview(ctx, screen, now, &input)
				if previewErr != nil {
					key := "preview:" + previewErr.Error()
					if !seenConflicts[key] {
						seenConflicts[key] = true
						result.Issues = append(result.Issues, PreflightIssue{Severity: "warning", Code: "schedule_preview", Message: previewErr.Error(), BlockID: block.ID.String()})
					}
					continue
				}
				for _, conflict := range preview.Conflicts {
					key := screen.String() + ":" + block.ID.String() + ":" + conflict
					if seenConflicts[key] {
						continue
					}
					seenConflicts[key] = true
					result.Issues = append(result.Issues, PreflightIssue{Severity: "warning", Code: "schedule_overlap", Message: conflict, BlockID: block.ID.String()})
				}
			}
		}
	}
	return result, nil
}

func (s *Service) Archive(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var archivedAt *time.Time
	if err = tx.QueryRow(ctx, `SELECT archived_at FROM campaigns WHERE id=$1 FOR UPDATE`, id).Scan(&archivedAt); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if archivedAt != nil {
		return ErrNotFound
	}
	oldScreens, err := campaignAffectedScreens(ctx, tx, id)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE campaigns SET archived_at=now(),updated_by=$2,updated_at=now() WHERE id=$1`, id, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE schedules SET enabled=FALSE,deleted_at=now(),updated_at=now() WHERE campaign_id=$1 AND deleted_at IS NULL`, id); err != nil {
		return err
	}
	changes, err := bumpScreens(ctx, tx, oldScreens, "campaign.archived")
	if err != nil {
		return err
	}
	if err = auditTx(ctx, tx, userID, "campaign.archived", id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.NotifyPublication(changes)
	return nil
}

func (s *Service) Releases(ctx context.Context, id uuid.UUID) ([]Release, error) {
	rows, err := s.db.Query(ctx, `SELECT id,campaign_id,release_number,submission_id,snapshot,snapshot_sha256,status,based_release_id,published_by,published_at,requested_publication_at,failure_reason,created_at FROM campaign_releases WHERE campaign_id=$1 ORDER BY release_number DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Release{}
	for rows.Next() {
		var item Release
		if err = rows.Scan(&item.ID, &item.CampaignID, &item.ReleaseNumber, &item.SubmissionID, &item.Snapshot, &item.SnapshotSHA256, &item.Status, &item.BasedReleaseID, &item.PublishedBy, &item.PublishedAt, &item.RequestedAt, &item.FailureReason, &item.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Service) RestoreReleaseToDraft(ctx context.Context, id, releaseID, userID uuid.UUID) (Campaign, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Campaign{}, err
	}
	defer tx.Rollback(ctx)
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT snapshot FROM campaign_releases WHERE id=$1 AND campaign_id=$2`, releaseID, id).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Campaign{}, ErrNotFound
		}
		return Campaign{}, err
	}
	if err = s.RestoreDraftTx(ctx, tx, id, raw, userID); err != nil {
		return Campaign{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Campaign{}, err
	}
	_ = s.audit(ctx, userID, "campaign.version_restored_to_draft", id)
	return s.Get(ctx, id)
}

func validateSnapshotShape(snapshot Snapshot) error {
	if err := validateCampaignMetadata(snapshot); err != nil {
		return err
	}
	if _, err := time.LoadLocation(snapshot.Timezone); err != nil {
		return fmt.Errorf("%w: timezone is invalid", ErrInvalid)
	}
	seenDestinations := map[string]bool{}
	for _, destination := range snapshot.Destinations {
		key := destination.Type + ":" + destination.ID.String()
		if seenDestinations[key] {
			return fmt.Errorf("%w: destination %s is listed more than once", ErrInvalid, destination.ID)
		}
		seenDestinations[key] = true
	}
	seenBlocks := map[uuid.UUID]bool{}
	for _, block := range snapshot.Blocks {
		if block.ID == uuid.Nil {
			return fmt.Errorf("%w: every content block needs an id", ErrInvalid)
		}
		if seenBlocks[block.ID] {
			return fmt.Errorf("%w: content block %s is listed more than once", ErrInvalid, block.ID)
		}
		seenBlocks[block.ID] = true
		if len(strings.TrimSpace(block.Name)) < 1 || len(block.Name) > 180 {
			return fmt.Errorf("%w: content block names must be between 1 and 180 characters", ErrInvalid)
		}
		if block.ContentType != "playlist" && block.ContentType != "layout" {
			return fmt.Errorf("%w: content block %s has invalid content type %q", ErrInvalid, block.ID, block.ContentType)
		}
		if block.ContentID == uuid.Nil {
			return fmt.Errorf("%w: content block %s has no content", ErrInvalid, block.ID)
		}
		if _, err := time.LoadLocation(block.Timezone); err != nil {
			return fmt.Errorf("%w: block %s timezone is invalid", ErrInvalid, block.ID)
		}
	}
	return nil
}

func validateCampaignMetadata(snapshot Snapshot) error {
	if len(snapshot.Name) < 1 || len(snapshot.Name) > 180 {
		return fmt.Errorf("%w: campaign name must be between 1 and 180 characters", ErrInvalid)
	}
	if len(snapshot.Description) > 2000 {
		return fmt.Errorf("%w: campaign description is too long", ErrInvalid)
	}
	if snapshot.Timezone == "" {
		snapshot.Timezone = "UTC"
	}
	if snapshot.CampaignStart != nil && snapshot.CampaignEnd != nil && !snapshot.CampaignEnd.After(*snapshot.CampaignStart) {
		return fmt.Errorf("%w: campaign end must be after its start", ErrInvalid)
	}
	return nil
}

func normalizeSnapshot(snapshot *Snapshot) {
	if snapshot.Timezone == "" {
		snapshot.Timezone = "UTC"
	}
	if snapshot.Destinations == nil {
		snapshot.Destinations = []Destination{}
	}
	if snapshot.Blocks == nil {
		snapshot.Blocks = []Block{}
	}
	for i := range snapshot.Blocks {
		snapshot.Blocks[i].Name = strings.TrimSpace(snapshot.Blocks[i].Name)
		if snapshot.Blocks[i].ID == uuid.Nil {
			snapshot.Blocks[i].ID = uuid.New()
		}
		if snapshot.Blocks[i].Name == "" {
			snapshot.Blocks[i].Name = fmt.Sprintf("Block %d", i+1)
		}
		if snapshot.Blocks[i].Timezone == "" {
			snapshot.Blocks[i].Timezone = snapshot.Timezone
		}
	}
}

func mustJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}

func campaignAffectedScreens(ctx context.Context, tx pgx.Tx, campaignID uuid.UUID) ([]uuid.UUID, error) {
	return queryScreens(ctx, tx, `SELECT DISTINCT x.screen_id FROM (SELECT t.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id WHERE s.campaign_id=$1 AND s.deleted_at IS NULL AND t.screen_id IS NOT NULL UNION SELECT m.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE s.campaign_id=$1 AND s.deleted_at IS NULL)x`, campaignID)
}

func campaignDestinationScreens(ctx context.Context, tx pgx.Tx, destinations []Destination) ([]uuid.UUID, error) {
	ids := []uuid.UUID{}
	for _, destination := range destinations {
		var rows pgx.Rows
		var err error
		if destination.Type == "screen" {
			rows, err = tx.Query(ctx, `SELECT id FROM screens WHERE id=$1 AND archived_at IS NULL`, destination.ID)
		} else {
			rows, err = tx.Query(ctx, `SELECT m.screen_id FROM screen_group_memberships m JOIN screens s ON s.id=m.screen_id AND s.archived_at IS NULL WHERE m.screen_group_id=$1`, destination.ID)
		}
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var screen uuid.UUID
			if err = rows.Scan(&screen); err != nil {
				rows.Close()
				return nil, err
			}
			ids = append(ids, screen)
		}
		rows.Close()
	}
	return unique(ids), nil
}

func queryScreens(ctx context.Context, tx pgx.Tx, query string, arg uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, query, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return unique(result), rows.Err()
}

func unique(input []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	result := []uuid.UUID{}
	for _, id := range input {
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	return result
}

func unionScreens(a, b []uuid.UUID) []uuid.UUID {
	return unique(append(append([]uuid.UUID{}, a...), b...))
}

func bumpScreens(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, reason string) ([]manifestchanges.Change, error) {
	if len(ids) == 0 {
		return []manifestchanges.Change{}, nil
	}
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,previous_manifest_version,changed_at,change_reason) SELECT DISTINCT unnest($1::uuid[]),1,NULL::bigint,now(),$2 ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING screen_id,manifest_version`, ids, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	changes := []manifestchanges.Change{}
	for rows.Next() {
		var change manifestchanges.Change
		if err = rows.Scan(&change.ScreenID, &change.Version); err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	return changes, rows.Err()
}

func campaignLifecycle(archived bool, publishedRaw []byte, now time.Time) (string, error) {
	if archived {
		return "Archived", nil
	}
	if len(publishedRaw) == 0 {
		return "Draft", nil
	}
	var published Snapshot
	if err := json.Unmarshal(publishedRaw, &published); err != nil {
		return "", err
	}
	if published.CampaignStart != nil && now.Before(*published.CampaignStart) {
		return "Scheduled", nil
	}
	if published.CampaignEnd != nil && !now.Before(*published.CampaignEnd) {
		return "Ended", nil
	}
	return "Live", nil
}

func (s *Service) audit(ctx context.Context, userID uuid.UUID, action string, id uuid.UUID) error {
	_, err := s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,$3,'campaign',$4)`, uuid.New(), userID, action, id.String())
	return err
}

func auditTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action string, id uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,$3,'campaign',$4)`, uuid.New(), userID, action, id.String())
	return err
}
