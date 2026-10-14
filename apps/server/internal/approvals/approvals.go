// Package approvals owns the server-side Draft -> Review -> Publish workflow.
//
// Submissions freeze complete snapshots while the mutable authoring draft may
// continue to change. Publication and assignment gates still check the exact
// published revision in the same transaction, so an approval cannot silently
// drift onto a later edit.
package approvals

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
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/editorial"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// Content types that can be reviewed. These are the two things that can be
// assigned to a screen; everything else in the library reaches a screen only
// through one of them.
const (
	TypePlaylist = "playlist"
	TypeLayout   = "layout"
	TypeCampaign = "campaign"
)

var (
	// ErrNotApproved means the content may not be assigned yet.
	ErrNotApproved = errors.New("content is waiting for review")
	// ErrValidation marks a bad request.
	ErrValidation = errors.New("review request is not valid")
	// ErrNotFound is returned for unknown content.
	ErrNotFound       = errors.New("not found")
	ErrConflict       = errors.New("editorial workflow conflict")
	ErrReviewRequired = errors.New("content requires an approved submission before publication")
)

type ReviewPolicy string

const (
	PolicyOff          ReviewPolicy = "off"
	PolicyContributors ReviewPolicy = "contributors"
	PolicyEveryone     ReviewPolicy = "everyone"
)

// SettingsReader is the part of the settings service this package needs.
type SettingsReader interface {
	Organization(ctx context.Context) (settings.Document, error)
}

// Querier is the part of pgx that both a pool and a transaction satisfy, so the
// gate can run on its own or inside a caller's assignment transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Service records review decisions and answers whether content may be used.
type Service struct {
	db        *pgxpool.Pool
	settings  SettingsReader
	providers map[string]editorial.Provider
}

// NewService builds the approvals service.
func NewService(db *pgxpool.Pool, reader SettingsReader) *Service {
	return &Service{db: db, settings: reader, providers: map[string]editorial.Provider{}}
}

func (s *Service) SetProvider(contentType string, provider editorial.Provider) {
	if s.providers == nil {
		s.providers = map[string]editorial.Provider{}
	}
	s.providers[contentType] = provider
}

func (s *Service) provider(contentType string) (editorial.Provider, error) {
	provider := s.providers[contentType]
	if provider == nil {
		return nil, fmt.Errorf("%w: content type %q is not configured", ErrNotFound, contentType)
	}
	return provider, nil
}

// Required reports whether this installation gates assignment on review.
//
// Off by default. An existing installation that upgrades must not suddenly find
// every playlist unassignable.
func (s *Service) Required(ctx context.Context) bool {
	return s.Policy(ctx) != PolicyOff
}

// Policy translates the new registry value and the pre-00095 boolean. An
// unreadable policy is deliberately treated as off so an outage cannot take
// an installation's fleet offline.
func (s *Service) Policy(ctx context.Context) ReviewPolicy {
	document, err := s.settings.Organization(ctx)
	if err != nil {
		return PolicyOff
	}
	if value, ok := document.Values["content.review_policy"].(string); ok {
		switch ReviewPolicy(value) {
		case PolicyContributors, PolicyEveryone:
			return ReviewPolicy(value)
		case PolicyOff:
			return PolicyOff
		}
	}
	if required, ok := document.Values["content.approval_required"].(bool); ok && required {
		return PolicyEveryone
	}
	return PolicyOff
}

func (s *Service) AllowSelfApproval(ctx context.Context) bool {
	document, err := s.settings.Organization(ctx)
	if err != nil {
		return true
	}
	if value, ok := document.Values["content.allow_self_approval"].(bool); ok {
		return value
	}
	return true
}

func (s *Service) AutoPublishOnApproval(ctx context.Context) bool {
	document, err := s.settings.Organization(ctx)
	if err != nil {
		return false
	}
	value, _ := document.Values["content.auto_publish_on_approval"].(bool)
	return value
}

// Gate returns nil when the content may be assigned to a screen.
//
// This is the advisory form, for a caller that only reports what would happen —
// the bulk preview. A caller that is about to write the assignment must use
// GateTx instead, so the answer cannot go stale before it commits.
func (s *Service) Gate(ctx context.Context, contentType string, id uuid.UUID) error {
	return s.gate(ctx, s.db, contentType, id, false)
}

// GateTx is the gate inside the caller's assignment transaction, and it is what
// every path that actually writes an assignment uses. Being in the assignment
// path rather than the HTTP layer is what makes single assignment, bulk
// assignment, and anything added later share one check.
//
// Reading the revision without a lock leaves a window: an edit that lands
// between the check and the assignment's commit puts content on a screen whose
// approval names the revision before the edit. The share lock closes it. A
// concurrent edit blocks until the assignment commits and then bumps the
// revision, which re-opens review the same way any other edit does. Share
// rather than exclusive, so two assignments of the same playlist still proceed
// together — they are not what has to be serialized here.
func (s *Service) GateTx(ctx context.Context, tx pgx.Tx, contentType string, id uuid.UUID) error {
	return s.gate(ctx, tx, contentType, id, true)
}

func (s *Service) gate(ctx context.Context, q Querier, contentType string, id uuid.UUID, lock bool) error {
	if !s.Required(ctx) {
		return nil
	}
	revision, err := s.currentRevision(ctx, q, contentType, id, lock)
	if errors.Is(err, ErrNotFound) {
		// Existence is the assignment path's business, not this one's.
		return nil
	}
	if err != nil {
		return err
	}
	var approved bool
	if err := q.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM publication_history
			WHERE content_type=$1 AND content_id=$2 AND content_revision=$3)
		OR EXISTS(
			SELECT 1 FROM content_reviews
			WHERE content_type=$1 AND content_id=$2 AND revision=$3 AND decision='approved')`,
		contentType, id, revision).Scan(&approved); err != nil {
		return err
	}
	if approved {
		return nil
	}
	return errUnapproved(contentType)
}

func errUnapproved(contentType string) error {
	return fmt.Errorf("%w: this %s has not been approved at its current revision",
		ErrNotApproved, contentType)
}

// currentRevision reads the revision a decision would apply to. For a Layout
// that is the published revision: an unpublished draft cannot be assigned in
// the first place, so there is nothing to review.
//
// With lock set it takes a share lock on the one row an edit writes: the
// playlists row, whose revision an edit bumps, or the layouts row, whose
// published_revision_id a publish moves. Locking the revision row instead would
// lock nothing useful, because a publish leaves the old revision untouched and
// points elsewhere.
func (s *Service) currentRevision(ctx context.Context, q Querier, contentType string, id uuid.UUID, lock bool) (int64, error) {
	query, err := revisionQuery(contentType, lock)
	if err != nil {
		return 0, err
	}
	var revision int64
	err = q.QueryRow(ctx, query, id).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return revision, err
}

func revisionQuery(contentType string, lock bool) (string, error) {
	switch contentType {
	case TypePlaylist:
		query := `SELECT revision FROM playlists WHERE id=$1 AND deleted_at IS NULL`
		if lock {
			query += ` FOR SHARE`
		}
		return query, nil
	case TypeLayout:
		query := `SELECT r.revision FROM layouts l
		         JOIN layout_revisions r ON r.id=l.published_revision_id
		         WHERE l.id=$1 AND l.deleted_at IS NULL`
		if lock {
			// OF l, not the revision row: a publish leaves the old revision
			// untouched and moves layouts.published_revision_id, so the layouts row
			// is the one an assignment has to hold.
			query += ` FOR SHARE OF l`
		}
		return query, nil
	default:
		return "", fmt.Errorf("%w: unknown content type %q", ErrValidation, contentType)
	}
}

// Decide records an approval or a rejection for the content's current revision.
//
// The revision is read here rather than taken from the caller, so a decision
// can never be recorded against a revision the reviewer did not see. If the
// content changed while the review was open, the reviewer is told.
func (s *Service) Decide(ctx context.Context, reviewer uuid.UUID, contentType string, id uuid.UUID, approve bool, note string, expectedRevision int64) (Review, error) {
	// Unlocked on purpose. An edit that lands after this read leaves the decision
	// recorded against the revision the reviewer saw, which is exactly a
	// superseded decision: the content reads as pending again. The failure mode of
	// locking here would be a reviewer holding an editor's save open.
	revision, err := s.currentRevision(ctx, s.db, contentType, id, false)
	if err != nil {
		return Review{}, err
	}
	if expectedRevision > 0 && expectedRevision != revision {
		return Review{}, fmt.Errorf("%w: this %s changed while you were reviewing it. Look at it again.",
			ErrValidation, contentType)
	}
	note = strings.TrimSpace(note)
	if !approve && note == "" {
		// A rejection with no reason leaves the author with nothing to act on.
		return Review{}, fmt.Errorf("%w: say why it is being sent back", ErrValidation)
	}
	decision := "rejected"
	if approve {
		decision = "approved"
	}

	review := Review{
		ID: uuid.New(), ContentType: contentType, ContentID: id,
		Revision: revision, Decision: decision, Note: note,
		ReviewedBy: &reviewer, ReviewedAt: time.Now().UTC(),
	}
	// Re-deciding the same revision replaces the decision, which is how a
	// rejection is reversed without inventing a third state.
	if _, err := s.db.Exec(ctx, `
		INSERT INTO content_reviews(id,content_type,content_id,revision,decision,note,reviewed_by)
		VALUES($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (content_type,content_id,revision) DO UPDATE SET
			decision=EXCLUDED.decision, note=EXCLUDED.note,
			reviewed_by=EXCLUDED.reviewed_by, reviewed_at=now()`,
		review.ID, contentType, id, revision, decision, note, reviewer); err != nil {
		return Review{}, err
	}
	return review, nil
}

// Review is one recorded decision.
type Review struct {
	ID          uuid.UUID  `json:"id"`
	ContentType string     `json:"contentType"`
	ContentID   uuid.UUID  `json:"contentId"`
	Revision    int64      `json:"revision"`
	Decision    string     `json:"decision"`
	Note        string     `json:"note,omitempty"`
	ReviewedBy  *uuid.UUID `json:"reviewedBy,omitempty"`
	ReviewedAt  time.Time  `json:"reviewedAt"`
}

// QueueItem is one piece of content and where it stands.
type QueueItem struct {
	ContentType string    `json:"contentType"`
	ContentID   uuid.UUID `json:"contentId"`
	Name        string    `json:"name"`
	Revision    int64     `json:"revision"`
	// State is pending, approved, or rejected, derived from whether a decision
	// exists for this exact revision.
	State string `json:"state"`
	// AssignedScreens is why a reviewer should care: content already on screens
	// that has since been edited is more urgent than a new draft.
	AssignedScreens int        `json:"assignedScreens"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	AuthorName      string     `json:"authorName,omitempty"`
	LastNote        string     `json:"lastNote,omitempty"`
	LastReviewedAt  *time.Time `json:"lastReviewedAt,omitempty"`
}

// Queue lists reviewable content with its current state.
//
// Both playlists and published Layouts appear. An unpublished Layout draft is
// left out: it cannot reach a screen, so there is nothing to decide yet.
func (s *Service) Queue(ctx context.Context, state string) ([]QueueItem, error) {
	rows, err := s.db.Query(ctx, `
		WITH reviewable AS (
			SELECT 'playlist'::text AS content_type, p.id, p.name, p.revision, p.updated_at,
			       p.created_by,
			       (SELECT count(*) FROM screen_playlist_assignments a WHERE a.playlist_id=p.id)
			     + (SELECT count(*) FROM screen_group_memberships m
			        JOIN screen_group_playlist_assignments g ON g.screen_group_id=m.screen_group_id
			        WHERE g.playlist_id=p.id) AS assigned
			FROM playlists p WHERE p.deleted_at IS NULL
			UNION ALL
			SELECT 'layout', l.id, l.name, r.revision, l.updated_at, l.created_by,
			       (SELECT count(*) FROM screen_playlist_assignments a WHERE a.layout_id=l.id)
			     + (SELECT count(*) FROM screen_group_memberships m
			        JOIN screen_group_playlist_assignments g ON g.screen_group_id=m.screen_group_id
			        WHERE g.layout_id=l.id)
			FROM layouts l
			JOIN layout_revisions r ON r.id=l.published_revision_id
			WHERE l.deleted_at IS NULL
		)
		SELECT v.content_type, v.id, v.name, v.revision, v.updated_at,
		       COALESCE(u.name,''), v.assigned,
		       COALESCE(cr.decision,'pending'), COALESCE(cr.note,''), cr.reviewed_at
		FROM reviewable v
		LEFT JOIN users u ON u.id=v.created_by
		LEFT JOIN content_reviews cr
			ON cr.content_type=v.content_type AND cr.content_id=v.id AND cr.revision=v.revision
		WHERE $1='' OR COALESCE(cr.decision,'pending')=$1
		ORDER BY v.assigned DESC, v.updated_at DESC
		LIMIT 200`, state)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QueueItem{}
	for rows.Next() {
		var item QueueItem
		if err := rows.Scan(&item.ContentType, &item.ContentID, &item.Name, &item.Revision,
			&item.UpdatedAt, &item.AuthorName, &item.AssignedScreens,
			&item.State, &item.LastNote, &item.LastReviewedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// PendingCount is what Studio shows as a badge.
func (s *Service) PendingCount(ctx context.Context) (int, error) {
	items, err := s.Queue(ctx, "pending")
	return len(items), err
}

// Submission is an immutable reviewable snapshot.  WorkingRevision is the
// author's draft number at submission time; it is intentionally not used to
// re-read the content during approval or publication.
type Submission struct {
	ID                       uuid.UUID       `json:"id"`
	ContentType              string          `json:"contentType"`
	ContentID                uuid.UUID       `json:"contentId"`
	ContentName              string          `json:"contentName,omitempty"`
	WorkingRevision          int64           `json:"workingRevision"`
	Snapshot                 json.RawMessage `json:"snapshot"`
	SnapshotSHA256           string          `json:"snapshotSha256"`
	SubmittedBy              *uuid.UUID      `json:"submittedBy,omitempty"`
	SubmitterName            string          `json:"submitterName,omitempty"`
	SubmittedAt              time.Time       `json:"submittedAt"`
	BasedPublishedRevision   *int64          `json:"basedPublishedRevision,omitempty"`
	BasedPublishedRevisionID *uuid.UUID      `json:"basedPublishedRevisionId,omitempty"`
	Status                   string          `json:"status"`
	ReviewRequired           bool            `json:"reviewRequired"`
	AllowSelfApproval        bool            `json:"allowSelfApproval"`
	ReviewNote               string          `json:"reviewNote,omitempty"`
	ReviewedBy               *uuid.UUID      `json:"reviewedBy,omitempty"`
	ReviewerName             string          `json:"reviewerName,omitempty"`
	ReviewedAt               *time.Time      `json:"reviewedAt,omitempty"`
	RequestedPublicationAt   *time.Time      `json:"requestedPublicationAt,omitempty"`
	PublicationFailureReason string          `json:"publicationFailureReason,omitempty"`
	PublishedAt              *time.Time      `json:"publishedAt,omitempty"`
	NewerWorkingDraft        bool            `json:"newerWorkingDraft"`
	CurrentPublishedRevision *int64          `json:"currentPublishedRevision,omitempty"`
	AffectedScreenCount      int             `json:"affectedScreenCount"`
	AffectedLocationCount    int             `json:"affectedLocationCount"`
}

type SubmissionList struct {
	Items []Submission `json:"items"`
}

type PublicationResult struct {
	Submission Submission          `json:"submission"`
	Published  editorial.Published `json:"published"`
}

type PublicationHistoryItem struct {
	ID                      uuid.UUID  `json:"id"`
	Revision                int64      `json:"revision"`
	NativeRevisionID        *uuid.UUID `json:"nativeRevisionId,omitempty"`
	SubmissionID            *uuid.UUID `json:"submissionId,omitempty"`
	CampaignReleaseID       *uuid.UUID `json:"campaignReleaseId,omitempty"`
	PublishedBy             *uuid.UUID `json:"publishedBy,omitempty"`
	PublisherName           string     `json:"publisherName"`
	PublishedAt             time.Time  `json:"publishedAt"`
	SupersedesPublicationID *uuid.UUID `json:"supersedesPublicationId,omitempty"`
	Method                  string     `json:"method"`
	AffectedScreenCount     int        `json:"affectedScreenCount"`
	SnapshotSHA256          *string    `json:"snapshotSha256,omitempty"`
}

type SemanticChange struct {
	Kind        string `json:"kind"`
	Path        string `json:"path"`
	Description string `json:"description"`
}

type PublicationComparison struct {
	FromPublicationID uuid.UUID        `json:"fromPublicationId"`
	ToPublicationID   uuid.UUID        `json:"toPublicationId"`
	Changed           bool             `json:"changed"`
	Changes           []SemanticChange `json:"changes"`
}

// Rollback publishes the exact snapshot represented by a previous
// publication. It never moves a pointer backward: the provider creates a new
// native revision and publication_history records method=rollback. Review
// policy is evaluated again, so rollback cannot become an approval bypass.
func (s *Service) Rollback(ctx context.Context, userID uuid.UUID, authority Authority, contentType string, contentID, publicationID uuid.UUID) (PublicationResult, error) {
	if !canPublishContent(contentType, authority) {
		return PublicationResult{}, fmt.Errorf("%w: this role cannot roll back %s content", ErrValidation, contentType)
	}
	provider, err := s.provider(contentType)
	if err != nil {
		return PublicationResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PublicationResult{}, err
	}
	defer tx.Rollback(ctx)
	var historyContentType string
	var historyContentID uuid.UUID
	var nativeRevisionID, sourceSubmissionID, campaignReleaseID *uuid.UUID
	var sourceDigest *string
	if err = tx.QueryRow(ctx, `SELECT content_type,content_id,native_revision_id,submission_id,campaign_release_id,snapshot_sha256 FROM publication_history WHERE id=$1 FOR SHARE`, publicationID).Scan(&historyContentType, &historyContentID, &nativeRevisionID, &sourceSubmissionID, &campaignReleaseID, &sourceDigest); errors.Is(err, pgx.ErrNoRows) {
		return PublicationResult{}, ErrNotFound
	} else if err != nil {
		return PublicationResult{}, err
	}
	if historyContentType != contentType || historyContentID != contentID {
		return PublicationResult{}, fmt.Errorf("%w: publication belongs to a different content object", ErrConflict)
	}
	raw, err := rollbackSnapshotTx(ctx, tx, contentType, nativeRevisionID, sourceSubmissionID, campaignReleaseID, true)
	if err != nil {
		return PublicationResult{}, err
	}
	current, err := provider.SnapshotTx(ctx, tx, contentID)
	if err != nil {
		return PublicationResult{}, err
	}
	if err = provider.ValidateSnapshotTx(ctx, tx, contentID, raw); err != nil {
		return PublicationResult{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	if err = lockEditorialDraftTx(ctx, tx, contentType, contentID); err != nil {
		return PublicationResult{}, err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content_submissions WHERE content_type=$1 AND content_id=$2 AND status IN ('in_review','approved','scheduled'))`, contentType, contentID).Scan(&active); err != nil {
		return PublicationResult{}, err
	}
	if active {
		return PublicationResult{}, fmt.Errorf("%w: an active submission already exists", ErrConflict)
	}
	canonical, digest, err := canonicalSnapshot(raw)
	if err != nil {
		return PublicationResult{}, err
	}
	// A publication created by the editorial workflow already has the
	// provider's canonical digest. Reuse it for the new submission so a
	// rollback does not manufacture a different hash merely because a generic
	// JSON map was used while loading the historical snapshot.
	if sourceDigest != nil && *sourceDigest != "" {
		digest = *sourceDigest
	}
	requiresReview := reviewRequiredFor(s.Policy(ctx), authority, contentType)
	status := "approved"
	if requiresReview {
		status = "in_review"
	}
	submissionID := uuid.New()
	allowSelf := s.AllowSelfApproval(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO content_submissions(id,content_type,content_id,working_revision,snapshot,snapshot_sha256,submitted_by,submitted_at,based_published_revision,based_published_revision_id,status,review_required,allow_self_approval,review_note) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,now(),$8,$9,$10,$11,$12,$13)`, submissionID, contentType, contentID, current.WorkingRevision, string(canonical), digest, userID, current.PublishedRevision, current.PublishedRevisionID, status, requiresReview, allowSelf, "Rollback requested from publication "+publicationID.String()); err != nil {
		return PublicationResult{}, err
	}
	if requiresReview {
		if err = auditTx(ctx, tx, userID, "content.rollback_submitted", contentType, contentID, map[string]any{"submissionId": submissionID.String(), "sourcePublicationId": publicationID.String()}); err != nil {
			return PublicationResult{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return PublicationResult{}, err
		}
		return PublicationResult{Submission: Submission{ID: submissionID, ContentType: contentType, ContentID: contentID, Status: status, ReviewRequired: true}}, nil
	}
	result, err := s.publishLockedTxPreservingDraft(ctx, tx, provider, submissionID, userID, "rollback")
	if err != nil {
		return PublicationResult{}, err
	}
	if err = auditTx(ctx, tx, userID, rollbackPublishedAction(contentType), contentType, contentID, map[string]any{"submissionId": submissionID.String(), "sourcePublicationId": publicationID.String(), "revision": result.Published.Revision}); err != nil {
		return PublicationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PublicationResult{}, err
	}
	provider.NotifyPublication(result.Published.Changes)
	return result, nil
}

func rollbackPublishedAction(contentType string) string {
	switch contentType {
	case TypeCampaign:
		return "campaign.rolled_back"
	case TypePlaylist:
		return "playlist.rolled_back"
	case TypeLayout:
		return "layout.rolled_back"
	}
	return contentPublishedAction(contentType)
}

func canonicalSnapshot(raw json.RawMessage) ([]byte, string, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, "", err
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(canonical)
	return canonical, hex.EncodeToString(sum[:]), nil
}

func rollbackSnapshotTx(ctx context.Context, tx pgx.Tx, contentType string, nativeRevisionID, sourceSubmissionID, campaignReleaseID *uuid.UUID, materializePlaylistItemIDs bool) (json.RawMessage, error) {
	if sourceSubmissionID != nil {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT snapshot FROM content_submissions WHERE id=$1`, *sourceSubmissionID).Scan(&raw); err == nil {
			return raw, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	if campaignReleaseID != nil {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT snapshot FROM campaign_releases WHERE id=$1`, *campaignReleaseID).Scan(&raw); err == nil {
			return raw, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	if nativeRevisionID == nil {
		return nil, ErrNotFound
	}
	if contentType == TypeLayout {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT document FROM layout_revisions WHERE id=$1`, *nativeRevisionID).Scan(&raw); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
		return raw, nil
	}
	if contentType == TypeCampaign {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT snapshot FROM campaign_releases WHERE id=$1`, *nativeRevisionID).Scan(&raw); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
		return raw, nil
	}
	var name, description, sourceType, tagMatch string
	var tagDuration int64
	var items, tagIDs []byte
	if err := tx.QueryRow(ctx, `SELECT name,description,source_type,tag_match,tag_image_duration_ms,items,tag_ids FROM playlist_revisions WHERE id=$1`, *nativeRevisionID).Scan(&name, &description, &sourceType, &tagMatch, &tagDuration, &items, &tagIDs); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var decodedItems []map[string]any
	if err := json.Unmarshal(items, &decodedItems); err != nil {
		return nil, err
	}
	if materializePlaylistItemIDs {
		for _, item := range decodedItems {
			if id, ok := item["id"].(string); !ok || id == "" {
				item["id"] = uuid.New()
			}
		}
	}
	var decodedTags any
	if err := json.Unmarshal(tagIDs, &decodedTags); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"name": name, "description": description, "sourceType": sourceType, "tagMatch": tagMatch, "tagImageDurationMs": tagDuration, "items": decodedItems, "tagIds": decodedTags})
}

// Authority is the caller's management authority: the capabilities of the
// live role. auth.Principal satisfies it. Review rules ask what the caller
// may do, never which role name they hold.
type Authority interface {
	Can(capability auth.Capability) bool
}

// editCapability, publishCapability name the per-type authoring and
// publication capabilities for each reviewable content type.
func editCapability(contentType string) auth.Capability {
	switch contentType {
	case TypeCampaign:
		return auth.CapCampaignEdit
	case TypeLayout:
		return auth.CapLayoutEdit
	default:
		return auth.CapPlaylistEdit
	}
}

func publishCapability(contentType string) auth.Capability {
	switch contentType {
	case TypeCampaign:
		return auth.CapCampaignPublish
	case TypeLayout:
		return auth.CapLayoutPublish
	default:
		return auth.CapPlaylistPublish
	}
}

// reviewRequiredFor decides whether a submission must wait for a reviewer.
// "contributors" policy reviews anyone who cannot publish that content type
// themselves, which among the built-in roles is exactly the Contributor.
func reviewRequiredFor(policy ReviewPolicy, authority Authority, contentType string) bool {
	if policy == PolicyEveryone {
		return true
	}
	return policy == PolicyContributors && !authority.Can(publishCapability(contentType))
}

// canPublishAny reports whether the caller may publish some content type.
func canPublishAny(authority Authority) bool {
	return authority.Can(auth.CapPlaylistPublish) || authority.Can(auth.CapLayoutPublish) || authority.Can(auth.CapCampaignPublish)
}

func canReview(authority Authority) bool { return authority.Can(auth.CapContentReview) }

func canAuthor(contentType string, authority Authority) bool {
	return authority.Can(editCapability(contentType))
}

func canPublishContent(contentType string, authority Authority) bool {
	return authority.Can(publishCapability(contentType))
}

func (s *Service) Submit(ctx context.Context, userID uuid.UUID, authority Authority, contentType string, contentID uuid.UUID, requestedAt *time.Time) (Submission, error) {
	return s.submit(ctx, userID, authority, contentType, contentID, requestedAt, 0)
}

// SubmitExpected is the optimistic-concurrency form used by editor publish
// buttons. The reviewer workflow can also submit without an expected value
// when the caller is deliberately asking the server to snapshot the current
// draft.
func (s *Service) SubmitExpected(ctx context.Context, userID uuid.UUID, authority Authority, contentType string, contentID uuid.UUID, requestedAt *time.Time, expectedRevision int64) (Submission, error) {
	return s.submit(ctx, userID, authority, contentType, contentID, requestedAt, expectedRevision)
}

func (s *Service) submit(ctx context.Context, userID uuid.UUID, authority Authority, contentType string, contentID uuid.UUID, requestedAt *time.Time, expectedRevision int64) (Submission, error) {
	if !canAuthor(contentType, authority) {
		return Submission{}, fmt.Errorf("%w: this role cannot author %s content", ErrValidation, contentType)
	}
	provider, err := s.provider(contentType)
	if err != nil {
		return Submission{}, err
	}
	policy := s.Policy(ctx)
	requiresReview := reviewRequiredFor(policy, authority, contentType)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer tx.Rollback(ctx)
	snapshot, err := provider.SnapshotTx(ctx, tx, contentID)
	if err != nil {
		return Submission{}, err
	}
	if expectedRevision > 0 && snapshot.WorkingRevision != expectedRevision {
		return Submission{}, fmt.Errorf("%w: the working draft changed", ErrConflict)
	}
	if err = provider.ValidateSnapshotTx(ctx, tx, contentID, snapshot.Document); err != nil {
		return Submission{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	if err = lockEditorialDraftTx(ctx, tx, contentType, contentID); err != nil {
		return Submission{}, err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content_submissions WHERE content_type=$1 AND content_id=$2 AND status IN ('in_review','approved','scheduled'))`, contentType, contentID).Scan(&active); err != nil {
		return Submission{}, err
	}
	if active {
		return Submission{}, fmt.Errorf("%w: an active submission already exists", ErrConflict)
	}
	// A fresh submission replaces only an older changes-requested attempt. The
	// old immutable snapshot remains in history, but it must not still be
	// approvable after the author has sent a newer draft back to the queue.
	if _, err = tx.Exec(ctx, `UPDATE content_submissions SET status='superseded',updated_at=now() WHERE content_type=$1 AND content_id=$2 AND status='changes_requested'`, contentType, contentID); err != nil {
		return Submission{}, err
	}
	status := "in_review"
	if !requiresReview {
		status = "approved"
	}
	id := uuid.New()
	allowSelf := s.AllowSelfApproval(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO content_submissions(id,content_type,content_id,working_revision,snapshot,snapshot_sha256,submitted_by,submitted_at,based_published_revision,based_published_revision_id,status,review_required,allow_self_approval,requested_publication_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,now(),$8,$9,$10,$11,$12,$13)`, id, contentType, contentID, snapshot.WorkingRevision, string(snapshot.Document), snapshot.Digest, userID, snapshot.PublishedRevision, snapshot.PublishedRevisionID, status, requiresReview, allowSelf, requestedAt)
	if err != nil {
		return Submission{}, err
	}
	if err = auditTx(ctx, tx, userID, "content.submitted", contentType, contentID, map[string]any{"workingRevision": snapshot.WorkingRevision, "reviewRequired": requiresReview}); err != nil {
		return Submission{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Submission{}, err
	}
	return s.GetSubmission(ctx, id)
}

func (s *Service) SubmitAndPublish(ctx context.Context, userID uuid.UUID, authority Authority, contentType string, contentID uuid.UUID, expectedRevision int64) (PublicationResult, error) {
	if !canPublishContent(contentType, authority) {
		return PublicationResult{}, fmt.Errorf("%w: this role cannot publish content", ErrValidation)
	}
	if reviewRequiredFor(s.Policy(ctx), authority, contentType) {
		return PublicationResult{}, ErrReviewRequired
	}
	provider, err := s.provider(contentType)
	if err != nil {
		return PublicationResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PublicationResult{}, err
	}
	defer tx.Rollback(ctx)
	snapshot, err := provider.SnapshotTx(ctx, tx, contentID)
	if err != nil {
		return PublicationResult{}, err
	}
	if expectedRevision > 0 && snapshot.WorkingRevision != expectedRevision {
		return PublicationResult{}, fmt.Errorf("%w: the working draft changed", ErrConflict)
	}
	if err = provider.ValidateSnapshotTx(ctx, tx, contentID, snapshot.Document); err != nil {
		return PublicationResult{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	submissionID := uuid.New()
	allowSelf := s.AllowSelfApproval(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO content_submissions(id,content_type,content_id,working_revision,snapshot,snapshot_sha256,submitted_by,submitted_at,based_published_revision,based_published_revision_id,status,review_required,allow_self_approval) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,now(),$8,$9,'approved',FALSE,$10)`, submissionID, contentType, contentID, snapshot.WorkingRevision, string(snapshot.Document), snapshot.Digest, userID, snapshot.PublishedRevision, snapshot.PublishedRevisionID, allowSelf); err != nil {
		return PublicationResult{}, err
	}
	publication, err := s.publishLockedTx(ctx, tx, provider, submissionID, userID, "manual")
	if err != nil {
		return PublicationResult{}, err
	}
	if err = auditTx(ctx, tx, userID, contentPublishedAction(contentType), contentType, contentID, map[string]any{"revision": publication.Published.Revision, "method": "manual"}); err != nil {
		return PublicationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PublicationResult{}, err
	}
	provider.NotifyPublication(publication.Published.Changes)
	return publication, nil
}

func (s *Service) GetSubmission(ctx context.Context, id uuid.UUID) (Submission, error) {
	var item Submission
	err := s.db.QueryRow(ctx, `SELECT c.id,c.content_type,c.content_id,c.working_revision,c.snapshot,c.snapshot_sha256,c.submitted_by,COALESCE(su.name,''),c.submitted_at,c.based_published_revision,c.based_published_revision_id,c.status,c.review_required,c.allow_self_approval,c.review_note,c.reviewed_by,COALESCE(ru.name,''),c.reviewed_at,c.requested_publication_at,COALESCE(c.publication_failure_reason,''),c.published_at FROM content_submissions c LEFT JOIN users su ON su.id=c.submitted_by LEFT JOIN users ru ON ru.id=c.reviewed_by WHERE c.id=$1`, id).Scan(&item.ID, &item.ContentType, &item.ContentID, &item.WorkingRevision, &item.Snapshot, &item.SnapshotSHA256, &item.SubmittedBy, &item.SubmitterName, &item.SubmittedAt, &item.BasedPublishedRevision, &item.BasedPublishedRevisionID, &item.Status, &item.ReviewRequired, &item.AllowSelfApproval, &item.ReviewNote, &item.ReviewedBy, &item.ReviewerName, &item.ReviewedAt, &item.RequestedPublicationAt, &item.PublicationFailureReason, &item.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Submission{}, ErrNotFound
	}
	if err != nil {
		return Submission{}, err
	}
	if err = s.enrichSubmission(ctx, &item); err != nil {
		return Submission{}, err
	}
	return item, nil
}

func providerSnapshot(ctx context.Context, db *pgxpool.Pool, provider editorial.Provider, id uuid.UUID) (editorial.Snapshot, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	defer tx.Rollback(ctx)
	snapshot, err := provider.SnapshotTx(ctx, tx, id)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return editorial.Snapshot{}, err
	}
	return snapshot, nil
}

func (s *Service) enrichSubmission(ctx context.Context, item *Submission) error {
	if provider, providerErr := s.provider(item.ContentType); providerErr == nil {
		current, currentErr := providerSnapshot(ctx, s.db, provider, item.ContentID)
		if currentErr == nil {
			item.NewerWorkingDraft = current.WorkingRevision > item.WorkingRevision
			item.CurrentPublishedRevision = current.PublishedRevision
		}
	}
	var name string
	switch item.ContentType {
	case TypePlaylist:
		if err := s.db.QueryRow(ctx, `SELECT COALESCE(d.name,p.name) FROM playlists p LEFT JOIN playlist_drafts d ON d.playlist_id=p.id WHERE p.id=$1`, item.ContentID).Scan(&name); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	case TypeLayout:
		if err := s.db.QueryRow(ctx, `SELECT name FROM layouts WHERE id=$1`, item.ContentID).Scan(&name); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	case TypeCampaign:
		if err := s.db.QueryRow(ctx, `SELECT name FROM campaigns WHERE id=$1`, item.ContentID).Scan(&name); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	item.ContentName = name
	return s.populateImpact(ctx, item)
}

func (s *Service) populateImpact(ctx context.Context, item *Submission) error {
	var screenQuery string
	var impactArg any = item.ContentID
	switch item.ContentType {
	case TypePlaylist:
		screenQuery = `SELECT count(DISTINCT x.screen_id) FROM (
			SELECT screen_id FROM screen_playlist_assignments WHERE playlist_id=$1
			UNION SELECT m.screen_id FROM screen_group_playlist_assignments a JOIN screen_group_memberships m ON m.screen_group_id=a.screen_group_id WHERE a.playlist_id=$1
			UNION SELECT t.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id WHERE s.playlist_id=$1 AND s.deleted_at IS NULL AND t.screen_id IS NOT NULL
			UNION SELECT m.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE s.playlist_id=$1 AND s.deleted_at IS NULL
		)x`
	case TypeLayout:
		screenQuery = `SELECT count(DISTINCT x.screen_id) FROM (
			SELECT screen_id FROM screen_playlist_assignments WHERE layout_id=$1
			UNION SELECT m.screen_id FROM screen_group_playlist_assignments a JOIN screen_group_memberships m ON m.screen_group_id=a.screen_group_id WHERE a.layout_id=$1
			UNION SELECT t.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id WHERE s.layout_id=$1 AND s.deleted_at IS NULL AND t.screen_id IS NOT NULL
			UNION SELECT m.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE s.layout_id=$1 AND s.deleted_at IS NULL
		)x`
	case TypeCampaign:
		// A campaign submission may not have materialized schedules yet. Its
		// frozen destinations are the impact being reviewed, so calculate the
		// preview from the snapshot rather than only from the current release.
		screenQuery = `WITH destinations AS (
			SELECT type,id FROM jsonb_to_recordset(($1::jsonb)->'destinations') AS destination(type text,id uuid)
		) SELECT count(DISTINCT x.screen_id) FROM (
			SELECT d.id AS screen_id FROM destinations d JOIN screens sc ON sc.id=d.id AND sc.archived_at IS NULL WHERE d.type='screen'
			UNION SELECT m.screen_id FROM destinations d JOIN screen_group_memberships m ON m.screen_group_id=d.id JOIN screens sc ON sc.id=m.screen_id AND sc.archived_at IS NULL WHERE d.type='group'
		)x`
		impactArg = item.Snapshot
	default:
		return nil
	}
	if err := s.db.QueryRow(ctx, screenQuery, impactArg).Scan(&item.AffectedScreenCount); err != nil {
		return err
	}
	var locationQuery string
	if item.ContentType == TypeCampaign {
		locationQuery = `WITH destinations AS (
			SELECT type,id FROM jsonb_to_recordset(($1::jsonb)->'destinations') AS destination(type text,id uuid)
		), affected AS (
			SELECT d.id AS screen_id FROM destinations d WHERE d.type='screen'
			UNION SELECT m.screen_id FROM destinations d JOIN screen_group_memberships m ON m.screen_group_id=d.id WHERE d.type='group'
		) SELECT count(DISTINCT sc.location_id) FROM screens sc JOIN affected a ON a.screen_id=sc.id WHERE sc.archived_at IS NULL AND sc.location_id IS NOT NULL`
	} else if item.ContentType == TypePlaylist {
		locationQuery = `SELECT count(DISTINCT sc.location_id) FROM screens sc WHERE sc.archived_at IS NULL AND sc.location_id IS NOT NULL AND sc.id IN (SELECT screen_id FROM screen_playlist_assignments WHERE playlist_id=$1 UNION SELECT m.screen_id FROM screen_group_playlist_assignments a JOIN screen_group_memberships m ON m.screen_group_id=a.screen_group_id WHERE a.playlist_id=$1 UNION SELECT t.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id WHERE s.playlist_id=$1 AND s.deleted_at IS NULL AND t.screen_id IS NOT NULL UNION SELECT m.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE s.playlist_id=$1 AND s.deleted_at IS NULL)`
	} else {
		locationQuery = `SELECT count(DISTINCT sc.location_id) FROM screens sc WHERE sc.archived_at IS NULL AND sc.location_id IS NOT NULL AND sc.id IN (SELECT screen_id FROM screen_playlist_assignments WHERE layout_id=$1 UNION SELECT m.screen_id FROM screen_group_playlist_assignments a JOIN screen_group_memberships m ON m.screen_group_id=a.screen_group_id WHERE a.layout_id=$1 UNION SELECT t.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id WHERE s.layout_id=$1 AND s.deleted_at IS NULL AND t.screen_id IS NOT NULL UNION SELECT m.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE s.layout_id=$1 AND s.deleted_at IS NULL)`
	}
	return s.db.QueryRow(ctx, locationQuery, impactArg).Scan(&item.AffectedLocationCount)
}

func (s *Service) ListSubmissions(ctx context.Context, state string) (SubmissionList, error) {
	args := []any{}
	where := ""
	if state != "" {
		where = " WHERE c.status=$1"
		args = append(args, state)
	}
	rows, err := s.db.Query(ctx, `SELECT c.id,c.content_type,c.content_id,c.working_revision,c.snapshot,c.snapshot_sha256,c.submitted_by,COALESCE(su.name,''),c.submitted_at,c.based_published_revision,c.based_published_revision_id,c.status,c.review_required,c.allow_self_approval,c.review_note,c.reviewed_by,COALESCE(ru.name,''),c.reviewed_at,c.requested_publication_at,COALESCE(c.publication_failure_reason,''),c.published_at FROM content_submissions c LEFT JOIN users su ON su.id=c.submitted_by LEFT JOIN users ru ON ru.id=c.reviewed_by`+where+` ORDER BY c.submitted_at DESC LIMIT 200`, args...)
	if err != nil {
		return SubmissionList{}, err
	}
	result := SubmissionList{Items: []Submission{}}
	for rows.Next() {
		var item Submission
		if err = rows.Scan(&item.ID, &item.ContentType, &item.ContentID, &item.WorkingRevision, &item.Snapshot, &item.SnapshotSHA256, &item.SubmittedBy, &item.SubmitterName, &item.SubmittedAt, &item.BasedPublishedRevision, &item.BasedPublishedRevisionID, &item.Status, &item.ReviewRequired, &item.AllowSelfApproval, &item.ReviewNote, &item.ReviewedBy, &item.ReviewerName, &item.ReviewedAt, &item.RequestedPublicationAt, &item.PublicationFailureReason, &item.PublishedAt); err != nil {
			rows.Close()
			return SubmissionList{}, err
		}
		result.Items = append(result.Items, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return SubmissionList{}, err
	}
	rows.Close()
	if err = s.enrichSubmissionList(ctx, result.Items); err != nil {
		return SubmissionList{}, err
	}
	return result, nil
}

func (s *Service) enrichSubmissionList(ctx context.Context, items []Submission) error {
	type contentIndexes map[uuid.UUID][]int
	indexesFor := func(contentType string) (contentIndexes, []uuid.UUID) {
		indexes := contentIndexes{}
		ids := []uuid.UUID{}
		seen := map[uuid.UUID]bool{}
		for index := range items {
			if items[index].ContentType != contentType {
				continue
			}
			contentID := items[index].ContentID
			indexes[contentID] = append(indexes[contentID], index)
			if !seen[contentID] {
				seen[contentID] = true
				ids = append(ids, contentID)
			}
		}
		return indexes, ids
	}
	copyPublished := func(value *int64) *int64 {
		if value == nil {
			return nil
		}
		copy := *value
		return &copy
	}

	playlistIndexes, playlistIDs := indexesFor(TypePlaylist)
	if len(playlistIDs) > 0 {
		rows, err := s.db.Query(ctx, `
			WITH requested AS (SELECT unnest($1::uuid[]) AS content_id),
			affected AS (
				SELECT a.playlist_id AS content_id,a.screen_id FROM screen_playlist_assignments a WHERE a.playlist_id=ANY($1::uuid[])
				UNION SELECT a.playlist_id,m.screen_id FROM screen_group_playlist_assignments a JOIN screen_group_memberships m ON m.screen_group_id=a.screen_group_id WHERE a.playlist_id=ANY($1::uuid[])
				UNION SELECT s.playlist_id,t.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id WHERE s.playlist_id=ANY($1::uuid[]) AND s.deleted_at IS NULL AND t.screen_id IS NOT NULL
				UNION SELECT s.playlist_id,m.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE s.playlist_id=ANY($1::uuid[]) AND s.deleted_at IS NULL
			)
			SELECT r.content_id,COALESCE(d.name,p.name,''),COALESCE(d.revision,p.revision,0),p.revision,
			       count(DISTINCT sc.id)::int,count(DISTINCT sc.location_id)::int
			FROM requested r
			LEFT JOIN playlists p ON p.id=r.content_id
			LEFT JOIN playlist_drafts d ON d.playlist_id=r.content_id
			LEFT JOIN affected a ON a.content_id=r.content_id
			LEFT JOIN screens sc ON sc.id=a.screen_id AND sc.archived_at IS NULL
			GROUP BY r.content_id,d.name,p.name,d.revision,p.revision`, playlistIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id uuid.UUID
			var name string
			var working int64
			var published *int64
			var screens, locations int
			if err = rows.Scan(&id, &name, &working, &published, &screens, &locations); err != nil {
				rows.Close()
				return err
			}
			for _, index := range playlistIndexes[id] {
				items[index].ContentName = name
				items[index].NewerWorkingDraft = working > items[index].WorkingRevision
				items[index].CurrentPublishedRevision = copyPublished(published)
				items[index].AffectedScreenCount = screens
				items[index].AffectedLocationCount = locations
			}
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}

	layoutIndexes, layoutIDs := indexesFor(TypeLayout)
	if len(layoutIDs) > 0 {
		rows, err := s.db.Query(ctx, `
			WITH requested AS (SELECT unnest($1::uuid[]) AS content_id),
			affected AS (
				SELECT a.layout_id AS content_id,a.screen_id FROM screen_playlist_assignments a WHERE a.layout_id=ANY($1::uuid[])
				UNION SELECT a.layout_id,m.screen_id FROM screen_group_playlist_assignments a JOIN screen_group_memberships m ON m.screen_group_id=a.screen_group_id WHERE a.layout_id=ANY($1::uuid[])
				UNION SELECT s.layout_id,t.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id WHERE s.layout_id=ANY($1::uuid[]) AND s.deleted_at IS NULL AND t.screen_id IS NOT NULL
				UNION SELECT s.layout_id,m.screen_id FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id WHERE s.layout_id=ANY($1::uuid[]) AND s.deleted_at IS NULL
			)
			SELECT r.content_id,COALESCE(l.name,''),COALESCE(l.draft_revision,0),lr.revision,
			       count(DISTINCT sc.id)::int,count(DISTINCT sc.location_id)::int
			FROM requested r
			LEFT JOIN layouts l ON l.id=r.content_id
			LEFT JOIN layout_revisions lr ON lr.id=l.published_revision_id
			LEFT JOIN affected a ON a.content_id=r.content_id
			LEFT JOIN screens sc ON sc.id=a.screen_id AND sc.archived_at IS NULL
			GROUP BY r.content_id,l.name,l.draft_revision,lr.revision`, layoutIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id uuid.UUID
			var name string
			var working int64
			var published *int64
			var screens, locations int
			if err = rows.Scan(&id, &name, &working, &published, &screens, &locations); err != nil {
				rows.Close()
				return err
			}
			for _, index := range layoutIndexes[id] {
				items[index].ContentName = name
				items[index].NewerWorkingDraft = working > items[index].WorkingRevision
				items[index].CurrentPublishedRevision = copyPublished(published)
				items[index].AffectedScreenCount = screens
				items[index].AffectedLocationCount = locations
			}
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}

	campaignSubmissionIndexes := map[uuid.UUID]int{}
	campaignSubmissionIDs := []uuid.UUID{}
	for index := range items {
		if items[index].ContentType == TypeCampaign {
			campaignSubmissionIndexes[items[index].ID] = index
			campaignSubmissionIDs = append(campaignSubmissionIDs, items[index].ID)
		}
	}
	if len(campaignSubmissionIDs) > 0 {
		rows, err := s.db.Query(ctx, `
			WITH requested AS (
				SELECT id AS submission_id,content_id,snapshot FROM content_submissions WHERE id=ANY($1::uuid[])
			), destinations AS (
				SELECT r.submission_id,d.type,d.id
				FROM requested r
				CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(r.snapshot->'destinations')='array' THEN r.snapshot->'destinations' ELSE '[]'::jsonb END) AS d(type text,id uuid)
			), affected AS (
				SELECT d.submission_id,d.id AS screen_id FROM destinations d WHERE d.type='screen'
				UNION SELECT d.submission_id,m.screen_id FROM destinations d JOIN screen_group_memberships m ON m.screen_group_id=d.id WHERE d.type='group'
			)
			SELECT r.submission_id,COALESCE(c.name,''),COALESCE(c.draft_revision,0),release.release_number,
			       count(DISTINCT sc.id)::int,count(DISTINCT sc.location_id)::int
			FROM requested r
			LEFT JOIN campaigns c ON c.id=r.content_id
			LEFT JOIN LATERAL (SELECT release_number FROM campaign_releases WHERE campaign_id=r.content_id AND status='published' ORDER BY release_number DESC LIMIT 1) release ON TRUE
			LEFT JOIN affected a ON a.submission_id=r.submission_id
			LEFT JOIN screens sc ON sc.id=a.screen_id AND sc.archived_at IS NULL
			GROUP BY r.submission_id,c.name,c.draft_revision,release.release_number`, campaignSubmissionIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var submissionID uuid.UUID
			var name string
			var working int64
			var published *int64
			var screens, locations int
			if err = rows.Scan(&submissionID, &name, &working, &published, &screens, &locations); err != nil {
				rows.Close()
				return err
			}
			index := campaignSubmissionIndexes[submissionID]
			items[index].ContentName = name
			items[index].NewerWorkingDraft = working > items[index].WorkingRevision
			items[index].CurrentPublishedRevision = copyPublished(published)
			items[index].AffectedScreenCount = screens
			items[index].AffectedLocationCount = locations
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}
	return nil
}

func (s *Service) Approve(ctx context.Context, reviewerID uuid.UUID, authority Authority, submissionID uuid.UUID, note string) (PublicationResult, error) {
	if !canReview(authority) {
		return PublicationResult{}, fmt.Errorf("%w: this role cannot review content", ErrValidation)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PublicationResult{}, err
	}
	defer tx.Rollback(ctx)
	var sub Submission
	if err = scanSubmissionTx(ctx, tx, submissionID, &sub); err != nil {
		return PublicationResult{}, err
	}
	if sub.Status != "in_review" {
		return PublicationResult{}, fmt.Errorf("%w: submission is no longer awaiting a decision", ErrConflict)
	}
	if !sub.AllowSelfApproval && sub.SubmittedBy != nil && *sub.SubmittedBy == reviewerID {
		return PublicationResult{}, fmt.Errorf("%w: self-approval is disabled", ErrValidation)
	}
	provider, err := s.provider(sub.ContentType)
	if err != nil {
		return PublicationResult{}, err
	}
	note = strings.TrimSpace(note)
	var scheduledAt *time.Time
	status := "approved"
	if s.AutoPublishOnApproval(ctx) && canPublishContent(sub.ContentType, authority) {
		if sub.RequestedPublicationAt != nil && sub.RequestedPublicationAt.After(time.Now().UTC()) {
			scheduledAt = sub.RequestedPublicationAt
			status = "scheduled"
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE content_submissions SET status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now(),requested_publication_at=COALESCE($5,requested_publication_at),updated_at=now() WHERE id=$1`, submissionID, status, note, reviewerID, scheduledAt); err != nil {
		return PublicationResult{}, err
	}
	if err = auditTx(ctx, tx, reviewerID, "content.review_approved", sub.ContentType, sub.ContentID, map[string]any{"submissionId": submissionID.String()}); err != nil {
		return PublicationResult{}, err
	}
	result := PublicationResult{}
	if status == "approved" && s.AutoPublishOnApproval(ctx) && canPublishContent(sub.ContentType, authority) {
		result, err = s.publishLockedTx(ctx, tx, provider, submissionID, reviewerID, "automatic_after_approval")
		if err != nil {
			return PublicationResult{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return PublicationResult{}, err
	}
	if result.Submission.ID != uuid.Nil {
		provider.NotifyPublication(result.Published.Changes)
		return result, nil
	}
	updated, updateErr := s.GetSubmission(ctx, submissionID)
	return PublicationResult{Submission: updated}, updateErr
}

func (s *Service) RequestChanges(ctx context.Context, reviewerID uuid.UUID, authority Authority, submissionID uuid.UUID, note string) (Submission, error) {
	if !canReview(authority) {
		return Submission{}, fmt.Errorf("%w: this role cannot review content", ErrValidation)
	}
	note = strings.TrimSpace(note)
	if note == "" {
		return Submission{}, fmt.Errorf("%w: a changes-request note is required", ErrValidation)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer tx.Rollback(ctx)
	var sub Submission
	if err = scanSubmissionTx(ctx, tx, submissionID, &sub); err != nil {
		return Submission{}, err
	}
	if sub.Status != "in_review" {
		return Submission{}, fmt.Errorf("%w: submission is no longer awaiting a decision", ErrConflict)
	}
	if _, err = tx.Exec(ctx, `UPDATE content_submissions SET status='changes_requested',review_note=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$1`, submissionID, note, reviewerID); err != nil {
		return Submission{}, err
	}
	if err = auditTx(ctx, tx, reviewerID, "content.changes_requested", sub.ContentType, sub.ContentID, map[string]any{"submissionId": submissionID.String()}); err != nil {
		return Submission{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Submission{}, err
	}
	return s.GetSubmission(ctx, submissionID)
}

func (s *Service) Schedule(ctx context.Context, userID uuid.UUID, authority Authority, submissionID uuid.UUID, when time.Time) (Submission, error) {
	if !canPublishAny(authority) {
		return Submission{}, fmt.Errorf("%w: this role cannot schedule publication", ErrValidation)
	}
	when = when.UTC()
	if !when.After(time.Now().UTC()) {
		return Submission{}, fmt.Errorf("%w: publication time must be in the future", ErrValidation)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer tx.Rollback(ctx)
	var sub Submission
	if err = scanSubmissionTx(ctx, tx, submissionID, &sub); err != nil {
		return Submission{}, err
	}
	if !canPublishContent(sub.ContentType, authority) {
		return Submission{}, fmt.Errorf("%w: this role cannot schedule %s content", ErrValidation, sub.ContentType)
	}
	if sub.Status != "approved" {
		return Submission{}, fmt.Errorf("%w: only an approved submission can be scheduled", ErrConflict)
	}
	if _, err = tx.Exec(ctx, `UPDATE content_submissions SET status='scheduled',requested_publication_at=$2,publication_failure_reason=NULL,updated_at=now() WHERE id=$1`, submissionID, when); err != nil {
		return Submission{}, err
	}
	if err = auditTx(ctx, tx, userID, "content.publication_scheduled", sub.ContentType, sub.ContentID, map[string]any{"submissionId": submissionID.String(), "requestedPublicationAt": when}); err != nil {
		return Submission{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Submission{}, err
	}
	return s.GetSubmission(ctx, submissionID)
}

func (s *Service) CancelSchedule(ctx context.Context, userID uuid.UUID, authority Authority, submissionID uuid.UUID) (Submission, error) {
	if !canPublishAny(authority) {
		return Submission{}, fmt.Errorf("%w: this role cannot cancel publication", ErrValidation)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer tx.Rollback(ctx)
	var sub Submission
	if err = scanSubmissionTx(ctx, tx, submissionID, &sub); err != nil {
		return Submission{}, err
	}
	if !canPublishContent(sub.ContentType, authority) {
		return Submission{}, fmt.Errorf("%w: this role cannot cancel %s publication", ErrValidation, sub.ContentType)
	}
	if sub.Status != "scheduled" {
		return Submission{}, fmt.Errorf("%w: submission is not scheduled", ErrConflict)
	}
	if _, err = tx.Exec(ctx, `UPDATE content_submissions SET status='approved',requested_publication_at=NULL,updated_at=now() WHERE id=$1`, submissionID); err != nil {
		return Submission{}, err
	}
	if err = auditTx(ctx, tx, userID, "content.publication_cancelled", sub.ContentType, sub.ContentID, map[string]any{"submissionId": submissionID.String()}); err != nil {
		return Submission{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Submission{}, err
	}
	return s.GetSubmission(ctx, submissionID)
}

func (s *Service) PublishSubmission(ctx context.Context, userID uuid.UUID, authority Authority, submissionID uuid.UUID) (PublicationResult, error) {
	if !canPublishAny(authority) {
		return PublicationResult{}, fmt.Errorf("%w: this role cannot publish content", ErrValidation)
	}
	return s.publishSubmission(ctx, userID, authority, submissionID, "manual", true)
}

func (s *Service) publishSubmission(ctx context.Context, userID uuid.UUID, authority Authority, submissionID uuid.UUID, method string, enforceRole bool) (PublicationResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PublicationResult{}, err
	}
	defer tx.Rollback(ctx)
	var sub Submission
	if err = scanSubmissionTx(ctx, tx, submissionID, &sub); err != nil {
		return PublicationResult{}, err
	}
	if sub.Status != "approved" && sub.Status != "scheduled" {
		return PublicationResult{}, fmt.Errorf("%w: submission is not approved", ErrReviewRequired)
	}
	if enforceRole && sub.ReviewRequired && !canPublishContent(sub.ContentType, authority) {
		return PublicationResult{}, fmt.Errorf("%w: this role cannot publish content", ErrValidation)
	}
	provider, err := s.provider(sub.ContentType)
	if err != nil {
		return PublicationResult{}, err
	}
	result, err := s.publishLockedTx(ctx, tx, provider, submissionID, userID, method)
	if err != nil {
		return PublicationResult{}, err
	}
	if err = auditTx(ctx, tx, userID, contentPublishedAction(sub.ContentType), sub.ContentType, sub.ContentID, map[string]any{"submissionId": submissionID.String(), "method": method, "revision": result.Published.Revision}); err != nil {
		return PublicationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PublicationResult{}, err
	}
	provider.NotifyPublication(result.Published.Changes)
	return result, nil
}

func contentPublishedAction(contentType string) string {
	if contentType == "playlist" {
		return "playlist.published"
	}
	if contentType == "layout" {
		return "layout.published"
	}
	if contentType == TypeCampaign {
		return "campaign.published"
	}
	return "content.published"
}

func (s *Service) publishLockedTx(ctx context.Context, tx pgx.Tx, provider editorial.Provider, submissionID, userID uuid.UUID, method string) (PublicationResult, error) {
	return s.publishLockedTxMode(ctx, tx, provider, submissionID, userID, method, false)
}

// publishLockedTxPreservingDraft is used by rollback. The historical snapshot
// becomes the new published revision, but the author's newer working draft is
// deliberately left untouched. Ordinary publication may close the draft when
// its working revision equals the submitted revision.
func (s *Service) publishLockedTxPreservingDraft(ctx context.Context, tx pgx.Tx, provider editorial.Provider, submissionID, userID uuid.UUID, method string) (PublicationResult, error) {
	return s.publishLockedTxMode(ctx, tx, provider, submissionID, userID, method, true)
}

func (s *Service) publishLockedTxMode(ctx context.Context, tx pgx.Tx, provider editorial.Provider, submissionID, userID uuid.UUID, method string, preserveDraft bool) (PublicationResult, error) {
	var sub Submission
	if err := scanSubmissionTx(ctx, tx, submissionID, &sub); err != nil {
		return PublicationResult{}, err
	}
	if err := provider.ValidateSnapshotTx(ctx, tx, sub.ContentID, sub.Snapshot); err != nil {
		return PublicationResult{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	workingRevision := sub.WorkingRevision
	if preserveDraft {
		workingRevision = 0
	}
	published, err := provider.PublishSnapshotTx(ctx, tx, sub.ContentID, sub.Snapshot, workingRevision, userID)
	if err != nil {
		return PublicationResult{}, err
	}
	var supersedes *uuid.UUID
	_ = tx.QueryRow(ctx, `SELECT id FROM publication_history WHERE content_type=$1 AND content_id=$2 ORDER BY published_at DESC,id DESC LIMIT 1`, sub.ContentType, sub.ContentID).Scan(&supersedes)
	var campaignReleaseID *uuid.UUID
	if sub.ContentType == TypeCampaign {
		campaignReleaseID = published.RevisionID
	}
	if _, err = tx.Exec(ctx, `INSERT INTO publication_history(id,content_type,content_id,content_revision,native_revision_id,submission_id,campaign_release_id,published_by,published_at,supersedes_publication_id,method,affected_screen_count,snapshot_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,$12)`, uuid.New(), sub.ContentType, sub.ContentID, published.Revision, published.RevisionID, submissionID, campaignReleaseID, userID, supersedes, method, published.AffectedScreens, sub.SnapshotSHA256); err != nil {
		return PublicationResult{}, err
	}
	publishedAt := time.Now().UTC()
	if _, err = tx.Exec(ctx, `UPDATE content_submissions SET status='published',published_at=$2,requested_publication_at=NULL,publication_failure_reason=NULL,updated_at=now() WHERE id=$1`, submissionID, publishedAt); err != nil {
		return PublicationResult{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE content_submissions SET status='superseded',updated_at=now() WHERE content_type=$1 AND content_id=$2 AND id<>$3 AND status IN ('in_review','changes_requested','approved','scheduled')`, sub.ContentType, sub.ContentID, submissionID); err != nil {
		return PublicationResult{}, err
	}
	sub.Status = "published"
	sub.PublishedAt = &publishedAt
	sub.RequestedPublicationAt = nil
	return PublicationResult{Submission: sub, Published: published}, nil
}

func scanSubmissionTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, item *Submission) error {
	err := tx.QueryRow(ctx, `SELECT c.id,c.content_type,c.content_id,c.working_revision,c.snapshot,c.snapshot_sha256,c.submitted_by,COALESCE(su.name,''),c.submitted_at,c.based_published_revision,c.based_published_revision_id,c.status,c.review_required,c.allow_self_approval,c.review_note,c.reviewed_by,COALESCE(ru.name,''),c.reviewed_at,c.requested_publication_at,COALESCE(c.publication_failure_reason,''),c.published_at FROM content_submissions c LEFT JOIN users su ON su.id=c.submitted_by LEFT JOIN users ru ON ru.id=c.reviewed_by WHERE c.id=$1 FOR UPDATE OF c`, id).Scan(&item.ID, &item.ContentType, &item.ContentID, &item.WorkingRevision, &item.Snapshot, &item.SnapshotSHA256, &item.SubmittedBy, &item.SubmitterName, &item.SubmittedAt, &item.BasedPublishedRevision, &item.BasedPublishedRevisionID, &item.Status, &item.ReviewRequired, &item.AllowSelfApproval, &item.ReviewNote, &item.ReviewedBy, &item.ReviewerName, &item.ReviewedAt, &item.RequestedPublicationAt, &item.PublicationFailureReason, &item.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (s *Service) ReconcileScheduled(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id FROM content_submissions WHERE status='scheduled' AND requested_publication_at IS NOT NULL AND requested_publication_at<=now() ORDER BY requested_publication_at,id LIMIT 50`)
	if err != nil {
		return err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		if err = s.publishScheduled(ctx, id); err != nil {
			// A due item is not retried forever.  The failure is durable and
			// visible in Studio for an operator to correct and resubmit.
			_, _ = s.db.Exec(ctx, `UPDATE content_submissions SET status='publication_failed',publication_failure_reason=$2,updated_at=now() WHERE id=$1 AND status='scheduled'`, id, err.Error())
		}
	}
	return nil
}

func (s *Service) publishScheduled(ctx context.Context, id uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var sub Submission
	if err = scanSubmissionTx(ctx, tx, id, &sub); err != nil {
		return err
	}
	if sub.Status != "scheduled" || sub.RequestedPublicationAt == nil || sub.RequestedPublicationAt.After(time.Now().UTC()) {
		return nil
	}
	provider, err := s.provider(sub.ContentType)
	if err != nil {
		return err
	}
	publisher := sub.ReviewedBy
	if publisher == nil {
		publisher = sub.SubmittedBy
	}
	if publisher == nil {
		publisher = new(uuid.UUID)
		*publisher = uuid.Nil
	}
	result, err := s.publishLockedTx(ctx, tx, provider, id, *publisher, "scheduled")
	if err != nil {
		return err
	}
	if err = auditTx(ctx, tx, *publisher, contentPublishedAction(sub.ContentType), sub.ContentType, sub.ContentID, map[string]any{"submissionId": id.String(), "method": "scheduled", "revision": result.Published.Revision}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	provider.NotifyPublication(result.Published.Changes)
	return nil
}

func (s *Service) GetPublicationHistory(ctx context.Context, contentType string, contentID uuid.UUID) ([]PublicationHistoryItem, error) {
	rows, err := s.db.Query(ctx, `SELECT h.id,h.content_revision,h.native_revision_id,h.submission_id,h.campaign_release_id,h.published_by,COALESCE(u.name,''),h.published_at,h.supersedes_publication_id,h.method,h.affected_screen_count,h.snapshot_sha256 FROM publication_history h LEFT JOIN users u ON u.id=h.published_by WHERE h.content_type=$1 AND h.content_id=$2 ORDER BY h.published_at DESC,h.id DESC`, contentType, contentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []PublicationHistoryItem{}
	for rows.Next() {
		var item PublicationHistoryItem
		if err = rows.Scan(&item.ID, &item.Revision, &item.NativeRevisionID, &item.SubmissionID, &item.CampaignReleaseID, &item.PublishedBy, &item.PublisherName, &item.PublishedAt, &item.SupersedesPublicationID, &item.Method, &item.AffectedScreenCount, &item.SnapshotSHA256); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// ComparePublications returns a compact semantic diff for two immutable
// publication checkpoints. The raw snapshots remain available through the
// submission/history endpoints, but Studio should lead with changes an
// operator can understand rather than JSON noise.
func (s *Service) ComparePublications(ctx context.Context, contentType string, contentID, fromID, toID uuid.UUID) (PublicationComparison, error) {
	if contentType != TypePlaylist && contentType != TypeLayout && contentType != TypeCampaign {
		return PublicationComparison{}, fmt.Errorf("%w: unknown content type %q", ErrValidation, contentType)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PublicationComparison{}, err
	}
	defer tx.Rollback(ctx)
	from, err := publicationSnapshotTx(ctx, tx, contentType, contentID, fromID)
	if err != nil {
		return PublicationComparison{}, err
	}
	to, err := publicationSnapshotTx(ctx, tx, contentType, contentID, toID)
	if err != nil {
		return PublicationComparison{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PublicationComparison{}, err
	}
	changes := semanticChanges(contentType, from, to)
	return PublicationComparison{FromPublicationID: fromID, ToPublicationID: toID, Changed: len(changes) > 0, Changes: changes}, nil
}

func publicationSnapshotTx(ctx context.Context, tx pgx.Tx, contentType string, contentID, publicationID uuid.UUID) (json.RawMessage, error) {
	var historyContentType string
	var historyContentID uuid.UUID
	var nativeRevisionID, sourceSubmissionID, campaignReleaseID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT content_type,content_id,native_revision_id,submission_id,campaign_release_id FROM publication_history WHERE id=$1`, publicationID).Scan(&historyContentType, &historyContentID, &nativeRevisionID, &sourceSubmissionID, &campaignReleaseID); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if historyContentType != contentType || historyContentID != contentID {
		return nil, fmt.Errorf("%w: publication belongs to a different content object", ErrConflict)
	}
	return rollbackSnapshotTx(ctx, tx, contentType, nativeRevisionID, sourceSubmissionID, campaignReleaseID, false)
}

func semanticChanges(contentType string, from, to json.RawMessage) []SemanticChange {
	var before, after map[string]any
	if json.Unmarshal(from, &before) != nil || json.Unmarshal(to, &after) != nil {
		return []SemanticChange{{Kind: "changed", Path: "/", Description: "The published snapshot changed."}}
	}
	changes := []SemanticChange{}
	add := func(kind, path, description string) {
		changes = append(changes, SemanticChange{Kind: kind, Path: path, Description: description})
	}
	if contentType == TypePlaylist {
		for _, key := range []string{"name", "description", "sourceType", "tagMatch", "tagImageDurationMs"} {
			if !jsonEqual(before[key], after[key]) {
				add("details_changed", "/"+key, fmt.Sprintf("Playlist %s changed.", key))
			}
		}
		if !jsonEqual(before["tagIds"], after["tagIds"]) {
			add("tags_changed", "/tagIds", "Playlist tags changed.")
		}
		playlistItemChanges(before["items"], after["items"], add)
		return changes
	}
	if contentType == TypeLayout {
		beforeCanvas, _ := before["canvas"].(map[string]any)
		afterCanvas, _ := after["canvas"].(map[string]any)
		if !jsonEqual(beforeCanvas, afterCanvas) {
			add("canvas_changed", "/canvas", "Canvas or orientation changed.")
		}
		placementChanges(before["placements"], after["placements"], add)
		if !jsonEqual(before["placements"], after["placements"]) && len(changes) == 0 {
			add("placements_changed", "/placements", "Layout placements changed.")
		}
		return changes
	}
	for _, key := range []string{"name", "description", "timezone", "campaignStart", "campaignEnd", "destinations", "blocks"} {
		if !jsonEqual(before[key], after[key]) {
			kind := "campaign_changed"
			if key == "blocks" {
				kind = "schedule_blocks_changed"
			} else if key == "destinations" {
				kind = "destinations_changed"
			}
			add(kind, "/"+key, fmt.Sprintf("Campaign %s changed.", key))
		}
	}
	return changes
}

func playlistItemChanges(beforeValue, afterValue any, add func(string, string, string)) {
	before := snapshotItems(beforeValue)
	after := snapshotItems(afterValue)
	beforeByID := map[string]map[string]any{}
	afterByID := map[string]map[string]any{}
	for index, item := range before {
		beforeByID[itemKey(item, index)] = item
	}
	for index, item := range after {
		afterByID[itemKey(item, index)] = item
	}
	for key := range beforeByID {
		if _, ok := afterByID[key]; !ok {
			add("item_removed", "/items", "A playlist item was removed.")
		}
	}
	for key := range afterByID {
		old, existed := beforeByID[key]
		if !existed {
			add("item_added", "/items", "A playlist item was added.")
			continue
		}
		if !jsonEqual(old["position"], afterByID[key]["position"]) {
			add("item_reordered", "/items", "Playlist item order changed.")
		}
		for _, field := range []string{"durationMs", "fitMode", "transition", "audioEnabled", "volume", "deliveryPolicy", "usePlayerDefaults", "assetId", "layoutId"} {
			if !jsonEqual(old[field], afterByID[key][field]) {
				add("item_changed", "/items", "A playlist item's playback or content settings changed.")
				break
			}
		}
	}
}

func snapshotItems(value any) []map[string]any {
	items, _ := value.([]any)
	result := make([]map[string]any, 0, len(items))
	for _, value := range items {
		if item, ok := value.(map[string]any); ok {
			result = append(result, item)
		}
	}
	return result
}

func itemKey(item map[string]any, index int) string {
	if id, ok := item["id"].(string); ok && id != "" {
		return id
	}
	return fmt.Sprintf("position:%d", index)
}

func placementChanges(beforeValue, afterValue any, add func(string, string, string)) {
	before := snapshotItems(beforeValue)
	after := snapshotItems(afterValue)
	if len(before) != len(after) {
		add("placements_changed", "/placements", "Layout placements were added or removed.")
		return
	}
	for index := range before {
		if !jsonEqual(before[index], after[index]) {
			add("placement_changed", "/placements", "A layout placement changed.")
		}
	}
}

func jsonEqual(left, right any) bool {
	leftRaw, leftErr := json.Marshal(left)
	rightRaw, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftRaw) == string(rightRaw)
}

// RestorePublicationToDraft copies a historical publication into the mutable
// working area. It is intentionally separate from Rollback: no runtime row or
// manifest changes are made, and the caller must still submit/publish the new
// draft through normal policy checks.
func (s *Service) RestorePublicationToDraft(ctx context.Context, userID uuid.UUID, authority Authority, contentType string, contentID, publicationID uuid.UUID) (editorial.Snapshot, error) {
	if !canAuthor(contentType, authority) {
		return editorial.Snapshot{}, fmt.Errorf("%w: this role cannot restore %s content", ErrValidation, contentType)
	}
	provider, err := s.provider(contentType)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	defer tx.Rollback(ctx)
	var historyContentType string
	var historyContentID uuid.UUID
	var nativeRevisionID, sourceSubmissionID, campaignReleaseID *uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT content_type,content_id,native_revision_id,submission_id,campaign_release_id FROM publication_history WHERE id=$1 FOR SHARE`, publicationID).Scan(&historyContentType, &historyContentID, &nativeRevisionID, &sourceSubmissionID, &campaignReleaseID); errors.Is(err, pgx.ErrNoRows) {
		return editorial.Snapshot{}, ErrNotFound
	} else if err != nil {
		return editorial.Snapshot{}, err
	}
	if historyContentType != contentType || historyContentID != contentID {
		return editorial.Snapshot{}, fmt.Errorf("%w: publication belongs to a different content object", ErrConflict)
	}
	if err = lockEditorialDraftTx(ctx, tx, contentType, contentID); err != nil {
		return editorial.Snapshot{}, err
	}
	raw, err := rollbackSnapshotTx(ctx, tx, contentType, nativeRevisionID, sourceSubmissionID, campaignReleaseID, true)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	if err = provider.ValidateSnapshotTx(ctx, tx, contentID, raw); err != nil {
		return editorial.Snapshot{}, fmt.Errorf("%w: historical publication is no longer valid: %v", ErrValidation, err)
	}
	if err = provider.RestoreDraftTx(ctx, tx, contentID, raw, userID); err != nil {
		return editorial.Snapshot{}, err
	}
	if err = auditTx(ctx, tx, userID, "content.version_restored_to_draft", contentType, contentID, map[string]any{"publicationId": publicationID.String()}); err != nil {
		return editorial.Snapshot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return editorial.Snapshot{}, err
	}
	return providerSnapshot(ctx, s.db, provider, contentID)
}

func lockEditorialDraftTx(ctx context.Context, tx pgx.Tx, contentType string, id uuid.UUID) error {
	var query string
	switch contentType {
	case TypePlaylist:
		query = `SELECT playlist_id FROM playlist_drafts WHERE playlist_id=$1 FOR UPDATE`
	case TypeLayout:
		query = `SELECT id FROM layouts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`
	case TypeCampaign:
		query = `SELECT id FROM campaigns WHERE id=$1 AND archived_at IS NULL FOR UPDATE`
	default:
		return fmt.Errorf("%w: unknown content type %q", ErrValidation, contentType)
	}
	var found uuid.UUID
	if err := tx.QueryRow(ctx, query, id).Scan(&found); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else {
		return err
	}
}

func auditTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action, resourceType string, resourceID uuid.UUID, metadata map[string]any) error {
	raw, _ := json.Marshal(metadata)
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,metadata) VALUES($1,$2,$3,$4,$5,'success',$6::jsonb)`, uuid.New(), userID, action, resourceType, resourceID.String(), string(raw))
	return err
}
