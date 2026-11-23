package services

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/apps/server/internal/activityreport"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// activity.read@1 reads measured operational evidence: proof of play, its
// summary, playback compliance, and what each screen is doing now. It is
// separate from content.read@2 because it exposes a different class of
// data. Every number comes from internal/activityreport, the package the
// Studio Activity routes read, so a plugin and Studio cannot disagree.
//
// The answers are the safe Activity view whoever calls: no stored metadata
// or details, no raw failure payload, no address, request identifier,
// credential, token, cookie, source payload, or diagnostic data, even for a
// Studio operator who holds activity.manage. Raw Screen Events, telemetry,
// the audit log, and CSV export are not part of this service.
//
// Studio calls need activity.read. Historical proof and compliance cover the
// installation, as the Studio routes do; screens.current is narrowed to the
// operator's screen access, as the fleet and per-screen routes are.
// Unattended calls read the installation under the activity.read@1 grant.

const (
	maxActivityIdentifier = 128
)

// activityRange is the resolved reporting window of an answer.
type activityRange struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

// activityProof is one proof-of-play session in the service's public shape.
type activityProof struct {
	ID                   uuid.UUID  `json:"id"`
	StartedAt            time.Time  `json:"startedAt"`
	EndedAt              *time.Time `json:"endedAt,omitempty"`
	ScreenID             uuid.UUID  `json:"screenId"`
	ScreenName           string     `json:"screenName"`
	GroupID              *uuid.UUID `json:"groupId,omitempty"`
	GroupName            string     `json:"groupName,omitempty"`
	SessionType          string     `json:"sessionType"`
	PresentationType     string     `json:"presentationType,omitempty"`
	PresentationID       string     `json:"presentationId,omitempty"`
	PresentationRevision string     `json:"presentationRevision,omitempty"`
	PresentationName     string     `json:"presentationName,omitempty"`
	ContentType          string     `json:"contentType,omitempty"`
	ContentID            string     `json:"contentId,omitempty"`
	ContentName          string     `json:"contentName,omitempty"`
	PlaylistItemID       string     `json:"playlistItemId,omitempty"`
	LayoutPlacementID    string     `json:"layoutPlacementId,omitempty"`
	ActualDurationMS     *int64     `json:"actualDurationMs,omitempty"`
	ExpectedDurationMS   *int64     `json:"expectedDurationMs,omitempty"`
	Result               string     `json:"result"`
	TerminalReason       string     `json:"terminalReason,omitempty"`
	Trigger              string     `json:"trigger,omitempty"`
	ScheduleID           string     `json:"scheduleId,omitempty"`
	TakeoverID           string     `json:"takeoverId,omitempty"`
	ManifestVersion      *int64     `json:"manifestVersion,omitempty"`
	FailureCode          string     `json:"failureCode,omitempty"`
	SourceID             string     `json:"sourceId,omitempty"`
	SelectedRecordID     string     `json:"selectedRecordId,omitempty"`
	SelectionDate        string     `json:"selectionDate,omitempty"`
	SourceCachedAt       *time.Time `json:"sourceCachedAt,omitempty"`
	SourceRevision       string     `json:"sourceRevision,omitempty"`
	SnapshotHash         string     `json:"snapshotHash,omitempty"`
}

func projectProof(session activityreport.ProofSession) activityProof {
	proof := activityProof{
		ID: session.ID, StartedAt: session.StartedAt, EndedAt: session.EndedAt,
		ScreenID: session.ScreenID, ScreenName: session.ScreenName, GroupID: session.GroupID, GroupName: session.GroupName,
		SessionType: session.SessionType, PresentationType: session.PresentationType, PresentationID: session.PresentationID,
		PresentationRevision: session.PresentationRevision, PresentationName: session.PresentationName,
		ContentType: session.ContentType, ContentID: session.ContentID, ContentName: session.ContentName,
		PlaylistItemID: session.PlaylistItemID, LayoutPlacementID: session.LayoutPlacementID,
		ActualDurationMS: session.ActualDurationMS, ExpectedDurationMS: session.ExpectedDurationMS,
		Result: session.Result, TerminalReason: session.TerminalReason, Trigger: session.Trigger,
		ScheduleID: session.ScheduleID, TakeoverID: session.TakeoverID, ManifestVersion: session.ManifestVersion,
		FailureCode: session.FailureCode, SourceID: session.SourceID, SelectedRecordID: session.SelectedRecordID,
		SourceCachedAt: session.SourceCachedAt, SourceRevision: session.SourceRevision, SnapshotHash: session.SnapshotHash,
	}
	if session.SelectionDate != nil {
		proof.SelectionDate = session.SelectionDate.Format("2006-01-02")
	}
	return proof
}

// activitySummaryItem is one proof summary group. The meanings are those of
// docs/activity.md.
type activitySummaryItem struct {
	Key                       string  `json:"key"`
	Label                     string  `json:"label"`
	ConfirmedScreenPlaybackMS int64   `json:"confirmedScreenPlaybackMs"`
	ContentExposureMS         int64   `json:"contentExposureMs"`
	Records                   int64   `json:"records"`
	Completed                 int64   `json:"completed"`
	Failures                  int64   `json:"failures"`
	Partial                   int64   `json:"partial"`
	Unknown                   int64   `json:"unknown"`
	Interrupted               int64   `json:"interrupted"`
	SessionCompletionPercent  float64 `json:"sessionCompletionPercent"`
}

type activitySummaryPage struct {
	Range      activityRange         `json:"range"`
	Dimension  string                `json:"dimension"`
	Items      []activitySummaryItem `json:"items"`
	NextCursor string                `json:"nextCursor,omitempty"`
}

// activityComplianceTotals are the report-wide compliance facts.
type activityComplianceTotals struct {
	MeasurableExpectedMS int64    `json:"measurableExpectedMs"`
	ConfirmedMS          int64    `json:"confirmedMs"`
	MissedMS             int64    `json:"missedMs"`
	CompliancePercent    *float64 `json:"compliancePercent"`
	TakeoverOverriddenMS int64    `json:"takeoverOverriddenMs"`
	CancelledMS          int64    `json:"cancelledMs"`
	NotMeasurableMS      int64    `json:"notMeasurableMs"`
	Windows              int64    `json:"windows"`
	LateStarts           int64    `json:"lateStarts"`
	EarlyEndings         int64    `json:"earlyEndings"`
	NeverStarted         int64    `json:"neverStarted"`
	OfflineMisses        int64    `json:"offlineMisses"`
	FailedWindows        int64    `json:"failedWindows"`
	PartialWindows       int64    `json:"partialWindows"`
}

type activityComplianceGroup struct {
	Key                  string   `json:"key"`
	Label                string   `json:"label"`
	MeasurableExpectedMS int64    `json:"measurableExpectedMs"`
	ConfirmedMS          int64    `json:"confirmedMs"`
	MissedMS             int64    `json:"missedMs"`
	CompliancePercent    *float64 `json:"compliancePercent"`
	Windows              int64    `json:"windows"`
	LateStarts           int64    `json:"lateStarts"`
	EarlyEndings         int64    `json:"earlyEndings"`
	NeverStarted         int64    `json:"neverStarted"`
	OfflineMisses        int64    `json:"offlineMisses"`
	TopFailureReason     string   `json:"topFailureReason,omitempty"`
}

type activityCompliancePage struct {
	Range      activityRange             `json:"range"`
	Dimension  string                    `json:"dimension"`
	Totals     activityComplianceTotals  `json:"totals"`
	Items      []activityComplianceGroup `json:"items"`
	NextCursor string                    `json:"nextCursor,omitempty"`
}

// activityOpenSession is a session that has not ended.
type activityOpenSession struct {
	Type      string    `json:"type,omitempty"`
	ID        string    `json:"id,omitempty"`
	Name      string    `json:"name,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

// activityScreen is what one measured screen is doing now.
type activityScreen struct {
	ScreenID   uuid.UUID `json:"screenId"`
	ScreenName string    `json:"screenName"`
	// Health is healthy, impaired, offline, or unmeasured, and HealthReason
	// names why, as the Activity overview does.
	Health       string `json:"health"`
	HealthReason string `json:"healthReason"`
	// Online is reachability alone: heard from and within the grace period.
	Online                             bool                 `json:"online"`
	LastContactAt                      *time.Time           `json:"lastContactAt,omitempty"`
	CurrentPresentation                *activityOpenSession `json:"currentPresentation,omitempty"`
	CurrentContent                     *activityOpenSession `json:"currentContent,omitempty"`
	LastHealthyPlaybackAt              *time.Time           `json:"lastHealthyPlaybackAt,omitempty"`
	LastSuccessfulManifestActivationAt *time.Time           `json:"lastSuccessfulManifestActivationAt,omitempty"`
}

func openSession(session *activityreport.OpenSession) *activityOpenSession {
	if session == nil {
		return nil
	}
	return &activityOpenSession{Type: session.Type, ID: session.ID, Name: session.Name, StartedAt: session.StartedAt}
}

func projectCurrentScreen(screen activityreport.CurrentScreen) activityScreen {
	return activityScreen{
		ScreenID: screen.ScreenID, ScreenName: screen.ScreenName,
		Health: screen.State, HealthReason: screen.Reason,
		Online:                             activityreport.Reachable(screen.State, screen.Signals),
		LastContactAt:                      screen.Signals.LastHeartbeatAt,
		CurrentPresentation:                openSession(screen.Presentation),
		CurrentContent:                     openSession(screen.Content),
		LastHealthyPlaybackAt:              screen.LastHealthyPlayback,
		LastSuccessfulManifestActivationAt: screen.LastSuccessfulManifestActivation,
	}
}

// proofFilterInput is the proof filter shared by proof.list and
// proof.summary.
type proofFilterInput struct {
	From           string `json:"from"`
	To             string `json:"to"`
	Screen         string `json:"screen"`
	Group          string `json:"group"`
	Result         string `json:"result"`
	SessionType    string `json:"sessionType"`
	TerminalReason string `json:"terminalReason"`
	Content        string `json:"content"`
	Presentation   string `json:"presentation"`
	Schedule       string `json:"schedule"`
	Takeover       string `json:"takeover"`
	Search         string `json:"search"`
}

func parseOptionalID(value, name string) (*uuid.UUID, *CallError) {
	if value == "" {
		return nil, nil
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, invalidInput("%s must be a UUID", name)
	}
	return &id, nil
}

// filter validates every member and builds the shared report filter.
func (in proofFilterInput) filter() (activityreport.ProofFilter, *CallError) {
	filter := activityreport.ProofFilter{
		Result: in.Result, SessionType: in.SessionType, TerminalReason: in.TerminalReason,
		Content: in.Content, Presentation: in.Presentation, Schedule: in.Schedule, Takeover: in.Takeover, Search: in.Search,
	}
	var failure *CallError
	if filter.Screen, failure = parseOptionalID(in.Screen, "screen"); failure != nil {
		return filter, failure
	}
	if filter.Group, failure = parseOptionalID(in.Group, "group"); failure != nil {
		return filter, failure
	}
	if in.Result != "" && !activityreport.IsSessionResult(in.Result) {
		return filter, invalidInput("result is invalid")
	}
	if in.SessionType != "" && !activityreport.IsSessionType(in.SessionType) {
		return filter, invalidInput("sessionType is invalid")
	}
	if in.TerminalReason != "" && in.TerminalReason != activityreport.TerminalUnexpected && !activityreport.IsTerminalReason(in.TerminalReason) {
		return filter, invalidInput("terminalReason is invalid")
	}
	for name, value := range map[string]string{"content": in.Content, "presentation": in.Presentation, "schedule": in.Schedule, "takeover": in.Takeover} {
		if len(value) > maxActivityIdentifier {
			return filter, invalidInput("%s may be at most %d bytes", name, maxActivityIdentifier)
		}
	}
	if len(in.Search) > maxReadSearch {
		return filter, invalidInput("search may be at most %d bytes", maxReadSearch)
	}
	return filter, nil
}

// activityWindow resolves the reporting window. A continued cursor carries
// the window of its first page, so a default range does not move between
// pages.
func (d *Dispatcher) activityWindow(from, to string, carried []string) (activityreport.Window, *CallError) {
	if len(carried) == 2 {
		window := activityreport.Window{}
		var errFrom, errTo error
		window.From, errFrom = time.Parse(time.RFC3339Nano, carried[0])
		window.To, errTo = time.Parse(time.RFC3339Nano, carried[1])
		if errFrom != nil || errTo != nil || window.Validate() != nil {
			return window, invalidInput("cursor is invalid")
		}
		return window, nil
	}
	window, err := activityreport.ParseWindow(from, to, d.now())
	if err != nil {
		return window, invalidInput("%v", err)
	}
	return window, nil
}

func windowKey(window activityreport.Window) []string {
	return []string{window.From.UTC().Format(time.RFC3339Nano), window.To.UTC().Format(time.RFC3339Nano)}
}

func (d *Dispatcher) activityReports() *activityreport.Reports {
	return activityreport.New(d.deps.DB)
}

type proofListInput struct {
	proofFilterInput
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

type proofPage struct {
	Range      activityRange   `json:"range"`
	Items      []activityProof `json:"items"`
	NextCursor string          `json:"nextCursor,omitempty"`
}

func (d *Dispatcher) activityProofList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapActivityRead); failure != nil {
		return nil, nil, failure
	}
	var input proofListInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	filter, failure := input.filter()
	if failure != nil {
		return nil, nil, failure
	}
	limit, failure := listLimit(input.Limit)
	if failure != nil {
		return nil, nil, failure
	}
	var carried []string
	var after *keysetPosition
	if input.Cursor != "" {
		key, failure := decodeCursor(input.Cursor, call.Operation, input.proofFilterInput, 4)
		if failure != nil {
			return nil, nil, failure
		}
		carried = key[:2]
		position, err := time.Parse(time.RFC3339Nano, key[2])
		id, idErr := uuid.Parse(key[3])
		if err != nil || idErr != nil {
			return nil, nil, invalidInput("cursor is invalid")
		}
		after = &keysetPosition{At: position, ID: id}
	}
	window, failure := d.activityWindow(input.From, input.To, carried)
	if failure != nil {
		return nil, nil, failure
	}
	sessions, err := d.activityReports().ListProof(ctx, filter, window, after, limit+1)
	if errors.Is(err, activityreport.ErrInvalidFilter) {
		return nil, nil, invalidInput("%v", err)
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	items := make([]activityProof, 0, len(sessions))
	for _, session := range sessions {
		items = append(items, projectProof(session))
	}
	kept, last := fitPage(call.Operation, items, limit, false)
	page := proofPage{Range: activityRange{From: window.From, To: window.To}, Items: kept}
	if last >= 0 {
		key := append(windowKey(window), kept[last].StartedAt.UTC().Format(time.RFC3339Nano), kept[last].ID.String())
		page.NextCursor = encodeCursor(call.Operation, input.proofFilterInput, key...)
	}
	return page, nil, nil
}

type proofSummaryInput struct {
	proofFilterInput
	Dimension string `json:"dimension"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor"`
}

func (d *Dispatcher) activityProofSummary(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapActivityRead); failure != nil {
		return nil, nil, failure
	}
	var input proofSummaryInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	filter, failure := input.filter()
	if failure != nil {
		return nil, nil, failure
	}
	if input.Dimension == "" {
		input.Dimension = activityreport.SummaryByScreen
	}
	if !activityreport.IsSummaryDimension(input.Dimension) {
		return nil, nil, invalidInput("dimension must be screen, content, presentation, or schedule")
	}
	limit, failure := listLimit(input.Limit)
	if failure != nil {
		return nil, nil, failure
	}
	filters := struct {
		proofFilterInput
		Dimension string `json:"dimension"`
	}{input.proofFilterInput, input.Dimension}
	offset, carried, failure := decodeOffsetCursor(input.Cursor, call.Operation, filters, 2)
	if failure != nil {
		return nil, nil, failure
	}
	window, failure := d.activityWindow(input.From, input.To, carried)
	if failure != nil {
		return nil, nil, failure
	}
	groups, err := d.activityReports().ProofSummary(ctx, filter, window, input.Dimension, offset, limit+1)
	if errors.Is(err, activityreport.ErrInvalidFilter) {
		return nil, nil, invalidInput("%v", err)
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	items := make([]activitySummaryItem, 0, len(groups))
	for _, group := range groups {
		items = append(items, activitySummaryItem(group))
	}
	kept, last := fitPage(call.Operation, items, limit, false)
	page := activitySummaryPage{Range: activityRange{From: window.From, To: window.To}, Dimension: input.Dimension, Items: kept}
	if last >= 0 {
		page.NextCursor = offsetCursor(call.Operation, filters, offset+last+1, windowKey(window)...)
	}
	return page, nil, nil
}

type complianceSummaryInput struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Screen    string `json:"screen"`
	Schedule  string `json:"schedule"`
	Dimension string `json:"dimension"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor"`
}

func (d *Dispatcher) activityComplianceSummary(ctx context.Context, call Call) (any, *Denial, *CallError) {
	if failure := requireCapability(call, auth.CapActivityRead); failure != nil {
		return nil, nil, failure
	}
	var input complianceSummaryInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if input.Dimension == "" {
		input.Dimension = "screen"
	}
	if !activityreport.IsComplianceDimension(input.Dimension) {
		return nil, nil, invalidInput("dimension must be screen, location, group, presentation, schedule, date, or reason")
	}
	filter := activityreport.ComplianceFilter{Schedule: input.Schedule}
	var failure *CallError
	if filter.Screen, failure = parseOptionalID(input.Screen, "screen"); failure != nil {
		return nil, nil, failure
	}
	if len(input.Schedule) > maxActivityIdentifier {
		return nil, nil, invalidInput("schedule may be at most %d bytes", maxActivityIdentifier)
	}
	limit, failure := listLimit(input.Limit)
	if failure != nil {
		return nil, nil, failure
	}
	filters := input
	filters.Limit, filters.Cursor = 0, ""
	offset, carried, failure := decodeOffsetCursor(input.Cursor, call.Operation, filters, 2)
	if failure != nil {
		return nil, nil, failure
	}
	window, failure := d.activityWindow(input.From, input.To, carried)
	if failure != nil {
		return nil, nil, failure
	}
	reports := d.activityReports()
	// The Studio route judges every finished window before it reports, so a
	// window that closed a moment ago is not unmeasured; so does this one.
	if err := reports.EvaluateExpectedWindows(ctx, d.now(), nil); err != nil {
		return nil, nil, unavailable(err)
	}
	totals, err := reports.ComplianceTotals(ctx, filter, window)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	groups, err := reports.ComplianceBreakdown(ctx, filter, window, input.Dimension, offset, limit+1)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	items := make([]activityComplianceGroup, 0, len(groups))
	for _, group := range groups {
		items = append(items, activityComplianceGroup(group))
	}
	kept, last := fitPage(call.Operation, items, limit, false)
	page := activityCompliancePage{
		Range: activityRange{From: window.From, To: window.To}, Dimension: input.Dimension,
		Totals: activityComplianceTotals(totals), Items: kept,
	}
	if last >= 0 {
		page.NextCursor = offsetCursor(call.Operation, filters, offset+last+1, windowKey(window)...)
	}
	return page, nil, nil
}

type screensCurrentInput struct {
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

func (d *Dispatcher) activityScreensCurrent(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input screensCurrentInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	access, failure := d.screenAccess(ctx, call, auth.CapActivityRead)
	if failure != nil {
		return nil, nil, failure
	}
	limit, failure := listLimit(input.Limit)
	if failure != nil {
		return nil, nil, failure
	}
	filters := map[string]string{}
	after, failure := decodeKeysetCursor(input.Cursor, call.Operation, filters)
	if failure != nil {
		return nil, nil, failure
	}
	screens, err := d.activityReports().CurrentScreens(ctx, d.now(), access, after, limit+1)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	items := make([]activityScreen, 0, len(screens))
	for _, screen := range screens {
		items = append(items, projectCurrentScreen(screen))
	}
	kept, last := fitPage(call.Operation, items, limit, false)
	page := contentPage[activityScreen]{Items: kept}
	if last >= 0 {
		page.NextCursor = keysetCursor(call.Operation, filters, screens[last].CreatedAt, screens[last].ScreenID)
	}
	return page, nil, nil
}
