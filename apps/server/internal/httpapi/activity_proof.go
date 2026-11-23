package httpapi

import (
	"encoding/csv"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/activityreport"
	"github.com/tilecast/tilecast/apps/server/internal/keyset"
)

// proofExportLimit bounds one CSV export.
const proofExportLimit = 50000

func (s *server) listProofOfPlay(w http.ResponseWriter, r *http.Request) {
	visibility, ok := activityVisibilityOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	window, err := parseActivityWindow(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	page, err := parseActivityPage(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_page_invalid", err.Error())
		return
	}
	filter, err := proofFilterOf(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "proof_filter_invalid", err.Error())
		return
	}
	var after *keyset.After
	if page.Cursor != nil {
		after = &keyset.After{At: page.Cursor.Time, ID: page.Cursor.ID}
	}
	sessions, err := activityreport.New(s.db).ListProof(r.Context(), filter, window, after, page.Limit+1)
	if errors.Is(err, activityreport.ErrInvalidFilter) {
		writeError(w, http.StatusUnprocessableEntity, "proof_filter_invalid", err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	items := make([]proofOfPlayRecord, 0, len(sessions))
	for _, session := range sessions {
		items = append(items, proofRecord(session, visibility))
	}
	result := proofOfPlayPage{Items: items}
	if len(items) > page.Limit {
		last := items[page.Limit-1]
		result.Items = items[:page.Limit]
		result.NextCursor = encodeActivityCursor(activityCursor{Time: last.StartedAt, ID: last.ID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

// proofSelectSQL and the scan are owned by activityreport; this route adds
// the viewer's redaction of the stored metadata.
const proofSelectSQL = activityreport.ProofSelectSQL

type proofScanner func(dest ...any) error

func scanProof(scan proofScanner, visibility activityVisibility) (proofOfPlayRecord, error) {
	session, err := activityreport.ScanProof(scan)
	if err != nil {
		return proofOfPlayRecord{}, err
	}
	return proofRecord(session, visibility), nil
}

func proofRecord(session activityreport.ProofSession, visibility activityVisibility) proofOfPlayRecord {
	return proofOfPlayRecord{
		ID: session.ID, StartedAt: session.StartedAt, EndedAt: session.EndedAt,
		ScreenID: session.ScreenID, ScreenName: session.ScreenName, GroupID: session.GroupID, GroupName: session.GroupName,
		PresentationType: session.PresentationType, PresentationID: session.PresentationID,
		PresentationRevision: session.PresentationRevision, PresentationName: session.PresentationName,
		ContentType: session.ContentType, ContentID: session.ContentID, ContentName: session.ContentName,
		PlaylistItemID: session.PlaylistItemID, LayoutPlacementID: session.LayoutPlacementID,
		ActualDurationMS: session.ActualDurationMS, ExpectedDurationMS: session.ExpectedDurationMS,
		Result: session.Result, Trigger: session.Trigger, ScheduleID: session.ScheduleID, TakeoverID: session.TakeoverID,
		ManifestVersion: session.ManifestVersion, FailureCode: session.FailureCode, SourceID: session.SourceID,
		SelectedRecordID: session.SelectedRecordID, SelectionDate: session.SelectionDate,
		SourceCachedAt: session.SourceCachedAt, SourceRevision: session.SourceRevision, SnapshotHash: session.SnapshotHash,
		SessionType: session.SessionType, TerminalReason: session.TerminalReason,
		Details: activityMetadata(session.Metadata, session.Result == "failed", visibility),
	}
}

// proofFilterOf reads the proof filters of the Studio routes. The result
// filter is not checked against the result vocabulary here: an unknown
// value matches no session, which is what these routes have always done.
func proofFilterOf(r *http.Request) (activityreport.ProofFilter, error) {
	filter := activityreport.ProofFilter{
		Result:         queryValue(r, "result"),
		SessionType:    queryValue(r, "sessionType"),
		TerminalReason: queryValue(r, "terminalReason"),
		Content:        firstQueryValue(r, "media", "widget", "content"),
		Playlist:       queryValue(r, "playlist"),
		Layout:         queryValue(r, "layout"),
		Schedule:       queryValue(r, "schedule"),
		Takeover:       queryValue(r, "takeover"),
		Search:         queryValue(r, "search"),
	}
	for key, target := range map[string]**uuid.UUID{"screen": &filter.Screen, "group": &filter.Group} {
		value := queryValue(r, key)
		if value == "" {
			continue
		}
		parsed, err := uuid.Parse(value)
		if err != nil {
			return filter, errors.New("identifier filter is invalid")
		}
		*target = &parsed
	}
	return filter, nil
}

func firstQueryValue(r *http.Request, keys ...string) string {
	for _, key := range keys {
		if value := queryValue(r, key); value != "" {
			return value
		}
	}
	return ""
}

// proofSummaryLimit is the number of groups the Studio summary route
// returns.
const proofSummaryLimit = 250

func (s *server) proofOfPlaySummary(w http.ResponseWriter, r *http.Request) {
	window, err := parseActivityWindow(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	filter, err := proofFilterOf(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "proof_filter_invalid", err.Error())
		return
	}
	// This route has always read an unknown dimension as the screen.
	dimension := queryValue(r, "dimension")
	if !activityreport.IsSummaryDimension(dimension) {
		dimension = activityreport.SummaryByScreen
	}
	groups, err := activityreport.New(s.db).ProofSummary(r.Context(), filter, window, dimension, 0, proofSummaryLimit)
	if errors.Is(err, activityreport.ErrInvalidFilter) {
		writeError(w, http.StatusUnprocessableEntity, "proof_filter_invalid", err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	items := make([]proofSummaryItem, 0, len(groups))
	for _, group := range groups {
		items = append(items, proofSummaryItem(group))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"dimension": dimension, "items": items}})
}

func (s *server) exportProofOfPlay(w http.ResponseWriter, r *http.Request) {
	visibility, ok := activityVisibilityOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	if !activityCanExport(visibility) {
		writeError(w, http.StatusForbidden, "activity_export_restricted", "Activity exports require Owner or Administrator access.")
		return
	}
	window, err := parseActivityWindow(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	filter, err := proofFilterOf(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "proof_filter_invalid", err.Error())
		return
	}
	sessions, err := activityreport.New(s.db).ListProof(r.Context(), filter, window, nil, proofExportLimit)
	if errors.Is(err, activityreport.ErrInvalidFilter) {
		writeError(w, http.StatusUnprocessableEntity, "proof_filter_invalid", err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="tilecast-proof-of-play.csv"`)
	writer := csv.NewWriter(w)
	_ = writer.Write([]string{"Started at", "Ended at", "Screen", "Group", "Session type", "Presentation", "Presentation type", "Revision", "Content", "Content type", "Playlist item ID", "Layout placement ID", "Actual duration ms", "Expected duration ms", "Result", "Terminal reason", "Trigger", "Schedule ID", "Takeover ID", "Manifest version", "Failure code", "Source ID", "Selected record ID", "Selection date", "Source cached at", "Source revision", "Snapshot hash"})
	for _, session := range sessions {
		item := proofRecord(session, activityVisibility{sensitive: true})
		_ = writer.Write([]string{
			item.StartedAt.UTC().Format(time.RFC3339), optionalTime(item.EndedAt), item.ScreenName, item.GroupName, item.SessionType,
			firstNonEmpty(item.PresentationName, item.PresentationID), item.PresentationType, item.PresentationRevision,
			firstNonEmpty(item.ContentName, item.ContentID), item.ContentType, item.PlaylistItemID, item.LayoutPlacementID,
			optionalInt64(item.ActualDurationMS), optionalInt64(item.ExpectedDurationMS), item.Result, item.TerminalReason, item.Trigger,
			item.ScheduleID, item.TakeoverID, optionalInt64(item.ManifestVersion), item.FailureCode, item.SourceID,
			item.SelectedRecordID, optionalDate(item.SelectionDate), optionalTime(item.SourceCachedAt), item.SourceRevision, item.SnapshotHash,
		})
	}
	writer.Flush()
}
