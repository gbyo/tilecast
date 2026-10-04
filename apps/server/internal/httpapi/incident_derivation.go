package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
		return recoverPlaybackIncidentForContent(r, tx, screenID, event)
	}
	signal, ok := incidentSignalFor(event)
	if !ok {
		return nil
	}
	key := incidentDedupeKey(screenID, signal.Type)
	if !signal.Opens {
		return recoverIncident(r, tx, key, event, signal.ResolutionHint)
	}
	return openOrRepeatIncident(r, tx, screenID, key, event, signal)
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
func recoverPlaybackIncidentForContent(r *http.Request, tx pgx.Tx, screenID uuid.UUID, event playerActivityEventInput) error {
	ctx := activityContextWithoutCancel(r.Context())
	const hint = "The content played to a normal end again."
	key := incidentDedupeKey(screenID, incidentPlayback)
	tag, err := tx.Exec(ctx, `
		UPDATE incidents SET status='recovered',recovered_at=$2,recovery_event_id=$3,
			recovery_mode='automatic',resolution_reason=COALESCE(NULLIF(resolution_reason,''),$4),updated_at=now()
		WHERE dedupe_key=$1 AND status IN('open','acknowledged') AND related_id=$5`,
		key, event.OccurredAt, event.ID, hint, event.ContentID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return appendIncidentEvent(ctx, tx, key, event, "recovered", hint)
}

func incidentDedupeKey(screenID uuid.UUID, incidentType string) string {
	return incidentType + ":screen:" + screenID.String()
}

func openOrRepeatIncident(r *http.Request, tx pgx.Tx, screenID uuid.UUID, key string, event playerActivityEventInput, signal incidentSignal) error {
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
	_, err = tx.Exec(ctx, `
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
		ON CONFLICT DO NOTHING`,
		incidentID, signal.Type, signal.Severity, signal.Title, description, event.OccurredAt,
		event.FailureCode, signal.ProbableCause, event.ContentType, event.ContentID, key, string(metadata), screenID)
	if err != nil {
		return err
	}
	return appendIncidentEvent(ctx, tx, key, event, "opened", signal.Title)
}

func recoverIncident(r *http.Request, tx pgx.Tx, key string, event playerActivityEventInput, hint string) error {
	ctx := activityContextWithoutCancel(r.Context())
	// Recovered, not resolved: the condition ended on its own, so this is a
	// record of an outage that fixed itself, not a task. Nobody is asked to
	// acknowledge it; the distinction from a person closing the matter by hand
	// is kept only because the recovery figures depend on it.
	tag, err := tx.Exec(ctx, `
		UPDATE incidents SET status='recovered',recovered_at=$2,recovery_event_id=$3,
			recovery_mode='automatic',resolution_reason=COALESCE(NULLIF(resolution_reason,''),$4),updated_at=now()
		WHERE dedupe_key=$1 AND status IN('open','acknowledged')`,
		key, event.OccurredAt, event.ID, hint)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return appendIncidentEvent(ctx, tx, key, event, "recovered", hint)
}

func appendIncidentEvent(ctx context.Context, tx pgx.Tx, key string, event playerActivityEventInput, role, summary string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO incident_events(id,incident_id,activity_event_id,role,occurred_at,summary)
		SELECT $1,i.id,$2,$3,$4,$5 FROM incidents i
		WHERE i.dedupe_key=$6 ORDER BY i.opened_at DESC LIMIT 1`,
		uuid.New(), event.ID, role, event.OccurredAt, safeActivityText(summary, 240), key)
	return err
}

// syncOfflineIncidents opens and recovers connectivity incidents from current
// state rather than from events. A screen that stops reporting sends nothing,
// so without this sweep the very outage operators most need to see would only
// ever appear once the screen came back and its gap event arrived.
//
// It is deliberately idempotent: the partial unique index means a screen that
// has been offline for a week still has exactly one open incident.
func (s *server) syncOfflineIncidents(ctx context.Context) error {
	// Open one for every measured screen that is now past the grace period.
	if _, err := s.db.Exec(ctx, `
		INSERT INTO incidents(
			id,incident_type,severity,status,title,description,opened_at,last_seen_at,
			primary_screen_id,location_id,group_id,device_model,player_version,dedupe_key,metadata)
		SELECT gen_random_uuid(),$1,'error','open',$2,
		       'The Player has not reported within the heartbeat grace period.',
		       -- Opened when reporting actually stopped, not when the sweep
		       -- noticed, so time-to-recover measures the outage.
		       s.last_heartbeat_at + $3::interval, now(),
		       s.id,s.location_id,
		       (SELECT m.screen_group_id FROM screen_group_memberships m WHERE m.screen_id=s.id ORDER BY m.screen_group_id LIMIT 1),
		       s.device_model,s.player_version,
		       $1||':screen:'||s.id::text,'{"source":"offline_sweep"}'::jsonb
		FROM screens s
		WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL
		  AND s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < now()-$3::interval
		  AND EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=s.id AND c.revoked_at IS NULL)
		ON CONFLICT DO NOTHING`,
		incidentConnectivity, incidentTitleForType(incidentConnectivity), fleetHeartbeatGrace); err != nil {
		return err
	}
	// Recover the ones whose screen is reporting again. The heartbeat is the
	// evidence, so this is an automatic recovery.
	_, err := s.db.Exec(ctx, `
		UPDATE incidents i SET status='recovered',recovered_at=s.last_heartbeat_at,
			recovery_mode='automatic',
			resolution_reason=COALESCE(NULLIF(i.resolution_reason,''),'Screen is reporting again.'),
			updated_at=now()
		FROM screens s
		WHERE s.id=i.primary_screen_id AND i.incident_type=$1 AND i.status IN('open','acknowledged')
		  AND s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at >= now()-$2::interval`,
		incidentConnectivity, fleetHeartbeatGrace)
	return err
}

// incidentTitleForType keeps the event-driven and sweep-driven paths from
// drifting apart on what the same condition is called.
func incidentTitleForType(incidentType string) string {
	switch incidentType {
	case incidentConnectivity:
		return "Screen stopped reporting"
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
