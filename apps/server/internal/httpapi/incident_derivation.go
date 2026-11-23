package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/connectivity"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Incidents group related events into one operational problem. The rule that
// matters is that a repeat is not a new incident: a screen flapping ten times
// is one connectivity incident with ten occurrences, not ten things to read.

const (
	incidentConnectivity = "connectivity"
	incidentPlayback     = "playback"
	incidentStorage      = "storage"
	incidentSafeMode     = "safe_mode"
	incidentUpdate       = "update"
	// Content Health opens these; activity events never derive them.
	incidentDataSource = "data_source"
	incidentContent    = "content"
)

// incidentSignal is what one activity event says about an incident: whether it
// opens one, repeats one, or ends one.
type incidentSignal struct {
	Type string
	// Opens is false for a recovery signal, which only closes an open incident
	// and never creates one.
	Opens          bool
	Severity       string
	Title          string
	Description    string
	ProbableCause  string
	ResolutionHint string
}

// incidentSignalFor maps a canonical event onto the condition it evidences.
// Only conditions an operator would act on are modelled; ordinary playback
// churn deliberately produces nothing.
func incidentSignalFor(event playerActivityEventInput) (incidentSignal, bool) {
	switch canonicalActivityEventType(event.EventType) {
	case "heartbeat.gap_detected", "connection.lost", "player.disconnected":
		return incidentSignal{
			Type: incidentConnectivity, Opens: true, Severity: "error",
			Title:       "Screen stopped reporting",
			Description: "The Player stopped reporting within the expected heartbeat window.",
			// The server knows reporting stopped. It does not know why, and a
			// network guess here would be shown to an operator as fact.
			ProbableCause: "",
		}, true
	case "connection.restored", "player.connected":
		return incidentSignal{Type: incidentConnectivity, ResolutionHint: "Connection restored."}, true

	case "renderer.failure":
		return incidentSignal{
			Type: incidentPlayback, Opens: true, Severity: "error",
			Title: "Playback is failing", Description: "The renderer reported a failure.",
			ProbableCause: "Renderer failure reported by the Player.",
		}, true
	case "decoder.failure":
		return incidentSignal{
			Type: incidentPlayback, Opens: true, Severity: "error",
			Title: "Playback is failing", Description: "Media decoding failed.",
			ProbableCause: "Decoder failure reported by the Player.",
		}, true
	case "foreground_playback.lost":
		return incidentSignal{
			Type: incidentPlayback, Opens: true, Severity: "warning",
			Title: "Playback is not on screen", Description: "The Player is running in the background.",
			ProbableCause: "Another application took the foreground.",
		}, true
	case "renderer.recovered", "presentation.recovered", "presentation.started":
		return incidentSignal{Type: incidentPlayback, ResolutionHint: "Playback resumed."}, true

	case "storage.pressure":
		return incidentSignal{
			Type: incidentStorage, Opens: true, Severity: "warning",
			Title: "Storage is nearly full", Description: "Cache use crossed the configured pressure threshold.",
			ProbableCause: "Cached media exceeds the configured cache limit.",
		}, true
	case "storage.recovered":
		return incidentSignal{Type: incidentStorage, ResolutionHint: "Storage use fell below the recovery threshold."}, true

	case "safe_mode.entered":
		return incidentSignal{
			Type: incidentSafeMode, Opens: true, Severity: "critical",
			Title: "Player is in safe mode", Description: "The Player entered safe mode and is not playing assigned content.",
			ProbableCause: "Repeated playback failures escalated to safe mode.",
		}, true
	case "safe_mode.exited":
		return incidentSignal{Type: incidentSafeMode, ResolutionHint: "Safe mode exited."}, true

	case "update.installation_failed":
		return incidentSignal{
			Type: incidentUpdate, Opens: true, Severity: "error",
			Title: "Player update failed", Description: "An update did not install.",
		}, true
	case "update.installation_completed":
		return incidentSignal{Type: incidentUpdate, ResolutionHint: "The expected Player version reconnected."}, true
	}
	return incidentSignal{}, false
}

// deriveIncident applies one event to the incident model. It is called inside
// the same transaction as the rest of derivation, so an incident can never be
// opened for an event that was rolled back.
func (s *server) deriveIncident(r *http.Request, tx pgx.Tx, screenID uuid.UUID, event playerActivityEventInput) error {
	if playsSuccessfully(event) {
		return recoverPlaybackIncidentForContent(r, tx, s.events, screenID, event)
	}
	signal, ok := incidentSignalFor(event)
	if !ok {
		return nil
	}
	key := incidentDedupeKey(screenID, signal.Type)
	if !signal.Opens {
		return recoverIncident(r, tx, s.events, key, event, signal.ResolutionHint)
	}
	return openOrRepeatIncident(r, tx, s.events, screenID, key, event, signal)
}

// playsSuccessfully reports whether an event is evidence that content which
// failed is now playing: a child session that ran to a normal end and stayed
// on screen long enough to be a play. A renderer that fails as an item mounts
// and plays the same item a moment later has recovered, but nothing said so —
// no renderer.recovered, no new root presentation — so the incident stayed
// open indefinitely and counted every repeat as another occurrence.
func playsSuccessfully(event playerActivityEventInput) bool {
	if canonicalActivityEventType(event.EventType) != "content.completed" {
		return false
	}
	if event.ContentID == "" || event.FailureCode != "" {
		return false
	}
	if event.DurationMS == nil || *event.DurationMS < minimumPlaybackSessionMS {
		return false
	}
	if event.Result != "completed" && event.Result != "success" {
		return false
	}
	switch contractTerminalReason(event) {
	case terminalExpectedItemBoundary, terminalCompletedDuration:
		return true
	}
	return false
}

// recoverPlaybackIncidentForContent closes the playback incident that was
// opened for this same content. It is deliberately scoped to the content: a
// healthy image on the same screen says nothing about the video that keeps
// failing, and closing the incident on it would reopen it on the next failure
// as a stream of separate one-second outages.
func recoverPlaybackIncidentForContent(r *http.Request, tx pgx.Tx, events coreevents.Sink, screenID uuid.UUID, event playerActivityEventInput) error {
	ctx := activityContextWithoutCancel(r.Context())
	const hint = "The content played to a normal end again."
	key := incidentDedupeKey(screenID, incidentPlayback)
	rows, err := tx.Query(ctx, `
		UPDATE incidents SET status='recovered',recovered_at=$2,recovery_event_id=$3,
			recovery_mode='automatic',resolution_reason=COALESCE(NULLIF(resolution_reason,''),$4),updated_at=now()
		WHERE dedupe_key=$1 AND status IN('open','acknowledged') AND related_id=$5
		RETURNING id`,
		key, event.OccurredAt, event.ID, hint, event.ContentID)
	if err != nil {
		return err
	}
	recovered, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil || len(recovered) == 0 {
		return err
	}
	if err := appendIncidentEvent(ctx, tx, key, event, "recovered", hint); err != nil {
		return err
	}
	return coreevents.EmitIncidents(ctx, tx, events, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic, event.OccurredAt, recovered...)
}

func incidentDedupeKey(screenID uuid.UUID, incidentType string) string {
	return incidentType + ":screen:" + screenID.String()
}

func openOrRepeatIncident(r *http.Request, tx pgx.Tx, events coreevents.Sink, screenID uuid.UUID, key string, event playerActivityEventInput, signal incidentSignal) error {
	ctx := activityContextWithoutCancel(r.Context())
	description := signal.Description
	if event.FailureMessage != "" {
		description = event.FailureMessage
	}
	metadata, _ := json.Marshal(sanitizeActivityMap(event.Metadata, true))

	// A repeat of a condition already being tracked moves last_seen_at and the
	// occurrence count. Severity only ever escalates: an incident that has
	// already produced a critical event must not be quietly downgraded.
	tag, err := tx.Exec(ctx, `
		UPDATE incidents SET
			last_seen_at=GREATEST(last_seen_at,$2),
			occurrence_count=occurrence_count+1,
			severity=CASE WHEN $3='critical' OR (severity NOT IN('critical') AND $3='error') THEN $3 ELSE severity END,
			failure_code=COALESCE(NULLIF($4,''),failure_code),
			updated_at=now()
		WHERE dedupe_key=$1 AND status IN('open','acknowledged')`,
		key, event.OccurredAt, signal.Severity, event.FailureCode)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		return appendIncidentEvent(ctx, tx, key, event, "recurrence", "Condition reported again.")
	}

	// An incident that already recovered but was never closed does not block a
	// new one: the condition genuinely returned, and the mean-time-to-recover
	// figures should see two separate outages rather than one long one.
	incidentID := uuid.New()
	rows, err := tx.Query(ctx, `
		INSERT INTO incidents(
			id,incident_type,severity,status,title,description,opened_at,last_seen_at,
			primary_screen_id,location_id,group_id,device_model,player_version,
			failure_code,probable_cause,related_type,related_id,dedupe_key,metadata)
		SELECT $1,$2,$3,'open',$4,$5,$6,$6,
		       s.id,s.location_id,
		       (SELECT m.screen_group_id FROM screen_group_memberships m WHERE m.screen_id=s.id ORDER BY m.screen_group_id LIMIT 1),
		       s.device_model,s.player_version,
		       $7,$8,$9,$10,$11,$12::jsonb
		FROM screens s WHERE s.id=$13
		ON CONFLICT DO NOTHING
		RETURNING id`,
		incidentID, signal.Type, signal.Severity, signal.Title, description, event.OccurredAt,
		event.FailureCode, signal.ProbableCause, event.ContentType, event.ContentID, key, string(metadata), screenID)
	if err != nil {
		return err
	}
	opened, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	if len(opened) == 0 {
		// Another transaction opened the same incident first: this event is
		// a recurrence of it, not a second opening.
		return appendIncidentEvent(ctx, tx, key, event, "recurrence", "Condition reported again.")
	}
	if err := appendIncidentEvent(ctx, tx, key, event, "opened", signal.Title); err != nil {
		return err
	}
	return coreevents.EmitIncidents(ctx, tx, events, plugin.CoreIncidentOpened, coreevents.IncidentDetected, event.OccurredAt, opened...)
}

func recoverIncident(r *http.Request, tx pgx.Tx, events coreevents.Sink, key string, event playerActivityEventInput, hint string) error {
	ctx := activityContextWithoutCancel(r.Context())
	// Recovered, not resolved: the condition ended on its own, so this is a
	// record of an outage that fixed itself, not a task. Nobody is asked to
	// acknowledge it; the distinction from a person closing the matter by hand
	// is kept only because the recovery figures depend on it.
	rows, err := tx.Query(ctx, `
		UPDATE incidents SET status='recovered',recovered_at=$2,recovery_event_id=$3,
			recovery_mode='automatic',resolution_reason=COALESCE(NULLIF(resolution_reason,''),$4),updated_at=now()
		WHERE dedupe_key=$1 AND status IN('open','acknowledged')
		RETURNING id`,
		key, event.OccurredAt, event.ID, hint)
	if err != nil {
		return err
	}
	recovered, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil || len(recovered) == 0 {
		return err
	}
	if err := appendIncidentEvent(ctx, tx, key, event, "recovered", hint); err != nil {
		return err
	}
	return coreevents.EmitIncidents(ctx, tx, events, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic, event.OccurredAt, recovered...)
}

func appendIncidentEvent(ctx context.Context, tx pgx.Tx, key string, event playerActivityEventInput, role, summary string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO incident_events(id,incident_id,activity_event_id,role,occurred_at,summary)
		SELECT $1,i.id,$2,$3,$4,$5 FROM incidents i
		WHERE i.dedupe_key=$6 ORDER BY i.opened_at DESC LIMIT 1`,
		uuid.New(), event.ID, role, event.OccurredAt, safeActivityText(summary, 240), key)
	return err
}

// syncOfflineIncidents runs the connectivity sweep before an incident read,
// so the list is current even between background sweeps. The sweep opens
// and recovers connectivity incidents from current state rather than from
// events: a screen that stops reporting sends nothing. See
// internal/connectivity.
func (s *server) syncOfflineIncidents(ctx context.Context) error {
	return s.connectivitySweeper().Sweep(ctx)
}

// incidentTitleForType keeps the event-driven and sweep-driven paths from
// drifting apart on what the same condition is called.
func incidentTitleForType(incidentType string) string {
	switch incidentType {
	case incidentConnectivity:
		return connectivity.IncidentTitle
	case incidentPlayback:
		return "Playback is failing"
	case incidentStorage:
		return "Storage is nearly full"
	case incidentSafeMode:
		return "Player is in safe mode"
	case incidentUpdate:
		return "Player update failed"
	default:
		return strings.ReplaceAll(incidentType, "_", " ")
	}
}
