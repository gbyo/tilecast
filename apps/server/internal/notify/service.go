package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// SettingsReader is the part of the settings service this package needs.
type SettingsReader interface {
	Organization(ctx context.Context) (settings.Document, error)
}

// Service enqueues and delivers notifications.
type Service struct {
	db       *pgxpool.Pool
	settings SettingsReader
	cfg      Config
	logger   *slog.Logger
	email    EmailSender
	webhooks WebhookSender

	// batchBudget bounds how long one DeliverDue call keeps sending before it
	// releases the rest of its claim.
	batchBudget time.Duration
}

// deliveryLease is how long a claimed row stays out of other workers' reach.
// A batch stops sending after deliveryBatchBudget, which leaves room for one
// in-flight send (bounded by the webhook and SMTP timeouts) to finish before
// the lease runs out.
const (
	deliveryLease       = 5 * time.Minute
	deliveryBatchBudget = deliveryLease / 2
)

// NewService builds the notification service. Passing a nil email sender is
// valid and means this installation cannot send email.
func NewService(db *pgxpool.Pool, reader SettingsReader, cfg Config, email EmailSender, webhooks WebhookSender, logger *slog.Logger) *Service {
	return &Service{db: db, settings: reader, cfg: cfg, logger: logger, email: email, webhooks: webhooks, batchBudget: deliveryBatchBudget}
}

// EmailConfigured reports whether email delivery is possible at all, which
// Studio shows rather than presenting a control that cannot work.
func (s *Service) EmailConfigured() bool { return s.cfg.EmailConfigured() }

type subscriber struct {
	userID  uuid.UUID
	address string
	mode    string
}

// Enqueue fans one event out to every subscriber and webhook, writing one
// pending delivery per target.
//
// It returns nil when notifications are off or the event is below the severity
// floor. The caller marks the source transition as notified either way: a
// backlog that flushes the moment an administrator enables notifications would
// mail out a month of resolved history.
func (s *Service) Enqueue(ctx context.Context, event Event) error {
	if event.Key == "" || event.Category == "" {
		return errors.New("notification event needs a key and a category")
	}
	if event.Severity == "" {
		event.Severity = "warning"
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now()
	}

	policy, err := s.policy(ctx)
	if err != nil {
		return err
	}
	floor := event.FloorSeverity
	if floor == "" {
		floor = event.Severity
	}
	if !policy.Enabled || !SeverityAtLeast(floor, policy.MinimumSeverity) {
		return nil
	}

	now := time.Now()
	if s.cfg.EmailConfigured() && policy.FromAddress != "" {
		people, err := s.subscribers(ctx, event.Category)
		if err != nil {
			return err
		}
		for _, person := range people {
			at := policy.ScheduleFor(person.mode, event.Severity, now)
			if err := s.insertDelivery(ctx, event, "email", person.address, at); err != nil {
				return err
			}
		}
	}

	targets, err := s.webhookTargets(ctx, event.Category)
	if err != nil {
		return err
	}
	for _, target := range targets {
		// A webhook is a machine receiver. Quiet hours and digests are human
		// comforts and would only make an integration look broken.
		if err := s.insertDelivery(ctx, event, "webhook", target.ID, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) insertDelivery(ctx context.Context, event Event, channel, target string, at time.Time) error {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		payload = []byte(`{}`)
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO notification_deliveries(
			id,event_key,category,severity,channel,target,subject,body,payload,status,next_attempt_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'pending',$10)
		ON CONFLICT (event_key,channel,target) DO NOTHING`,
		uuid.New(), event.Key, event.Category, event.Severity, channel, target,
		truncate(event.Subject, 240), truncate(event.Body, s.cfg.MaxDeliveryBodyLen),
		string(payload), at)
	return err
}

// policy reads the organization notification settings.
func (s *Service) policy(ctx context.Context) (Settings, error) {
	document, err := s.settings.Organization(ctx)
	if err != nil {
		return Settings{}, err
	}
	return ParseSettings(document.Values)
}

// subscribers lists the accounts that asked for this category. Preferences are
// stored as one JSONB document per user, so the category test happens here
// rather than in SQL against keys that may be absent.
func (s *Service) subscribers(ctx context.Context, category string) ([]subscriber, error) {
	rows, err := s.db.Query(ctx, `
		SELECT u.id, COALESCE(p.preferences,'{}'::jsonb)
		FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
		WHERE u.active=TRUE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	defaults := settings.Defaults(settings.ScopePreference)
	var out []subscriber
	for rows.Next() {
		var id uuid.UUID
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		values := map[string]any{}
		_ = json.Unmarshal(raw, &values)
		for key, fallback := range defaults {
			if _, ok := values[key]; !ok {
				values[key] = fallback
			}
		}
		mode := stringSetting(values, "preference.notifications.mode", "off")
		if mode != "immediate" && mode != "digest" {
			continue
		}
		if !boolSetting(values, categoryPreferenceKey(category), false) {
			continue
		}
		address := strings.TrimSpace(stringSetting(values, "preference.notifications.address", ""))
		if address == "" {
			continue
		}
		if _, err := mail.ParseAddress(address); err != nil {
			continue
		}
		out = append(out, subscriber{userID: id, address: address, mode: mode})
	}
	return out, rows.Err()
}

func categoryPreferenceKey(category string) string {
	switch category {
	case CategoryIncident:
		return "preference.notifications.incidents"
	case CategoryContentHealth:
		return "preference.notifications.content_health"
	case CategoryBackup:
		return "preference.notifications.backups"
	case CategoryUpdate:
		return "preference.notifications.updates"
	}
	// An unrecognised category matches no preference key and therefore reaches
	// nobody, which is the safe direction.
	return "preference.notifications." + category
}

func (s *Service) webhookTargets(ctx context.Context, category string) ([]WebhookTarget, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text,name,url,signing_secret FROM notification_webhooks
		WHERE deleted_at IS NULL AND enabled=TRUE
		  AND (cardinality(categories)=0 OR $1=ANY(categories))
		ORDER BY created_at`, category)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WebhookTarget
	for rows.Next() {
		var t WebhookTarget
		if err := rows.Scan(&t.ID, &t.Name, &t.URL, &t.SigningSecret); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeliverDue sends everything that is due and returns how many messages were
// sent. Email deliveries for one address are combined into a single message,
// which is what makes the daily digest a scheduling decision rather than a
// separate code path.
func (s *Service) DeliverDue(ctx context.Context) (int, error) {
	policy, err := s.policy(ctx)
	if err != nil {
		return 0, err
	}
	pending, err := s.claimDue(ctx)
	if err != nil {
		return 0, err
	}
	if len(pending) == 0 {
		return 0, nil
	}

	// Sends are sequential, so a long batch could outlive its lease and let
	// another worker send the same rows. Stop starting new sends once the
	// budget is spent and hand the untouched rows back.
	started := time.Now()
	budget := s.batchBudget
	if budget <= 0 {
		budget = deliveryBatchBudget
	}
	exhausted := func() bool { return ctx.Err() != nil || time.Since(started) >= budget }

	sent := 0
	var unsent []pendingDelivery
	byAddress := map[string][]pendingDelivery{}
	for _, item := range pending {
		if item.channel == "email" {
			byAddress[item.target] = append(byAddress[item.target], item)
			continue
		}
		if exhausted() {
			unsent = append(unsent, item)
			continue
		}
		if s.deliverWebhook(ctx, item) {
			sent++
		}
	}
	addresses := make([]string, 0, len(byAddress))
	for address := range byAddress {
		addresses = append(addresses, address)
	}
	sort.Strings(addresses)
	for _, address := range addresses {
		if exhausted() {
			unsent = append(unsent, byAddress[address]...)
			continue
		}
		if s.deliverEmail(ctx, policy, address, byAddress[address]) {
			sent++
		}
	}
	s.release(unsent)
	return sent, nil
}

type pendingDelivery struct {
	id       uuid.UUID
	eventKey string
	category string
	severity string
	channel  string
	target   string
	subject  string
	body     string
	payload  []byte
	attempts int
	// lease is the next_attempt_at value this worker wrote when it claimed
	// the row. Every later update is fenced on it.
	lease time.Time
}

func (s *Service) claimDue(ctx context.Context) ([]pendingDelivery, error) {
	// Claim by leasing: the rows stay pending, but their next attempt moves out
	// of reach so a concurrent DeliverDue cannot pick them up and send a second
	// copy. Delivery has no receiver-side idempotency, so a duplicate read is a
	// duplicate email. A crash between the lease and the send costs a delay,
	// not a lost message. The leased next_attempt_at doubles as the claim
	// token: results are written only while it is still the row's value.
	rows, err := s.db.Query(ctx, `
		WITH due AS (
			SELECT id FROM notification_deliveries
			WHERE status='pending' AND next_attempt_at<=now()
			ORDER BY next_attempt_at
			LIMIT 200
			FOR UPDATE SKIP LOCKED
		)
		UPDATE notification_deliveries d
		SET next_attempt_at = now() + make_interval(secs => $1)
		FROM due WHERE d.id = due.id
		RETURNING d.id,d.event_key,d.category,d.severity,d.channel,d.target,
		          d.subject,d.body,d.payload,d.attempts,d.next_attempt_at`, deliveryLease.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pendingDelivery
	for rows.Next() {
		var d pendingDelivery
		if err := rows.Scan(&d.id, &d.eventKey, &d.category, &d.severity, &d.channel,
			&d.target, &d.subject, &d.body, &d.payload, &d.attempts, &d.lease); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Service) deliverEmail(ctx context.Context, policy Settings, address string, items []pendingDelivery) bool {
	if s.email == nil {
		s.failAll(ctx, items, errors.New("email delivery is not configured"), true)
		return false
	}
	subject, body := composeEmail(policy, items, s.cfg.PublicURL)
	from := mail.Address{Name: policy.FromName, Address: policy.FromAddress}
	err := s.email.Send(ctx, Message{From: from, To: address, Subject: subject, Body: body, Category: items[0].category})
	if err != nil {
		s.failAll(ctx, items, err, errors.Is(err, ErrPermanent))
		return false
	}
	s.markSent(ctx, items)
	return true
}

func (s *Service) deliverWebhook(ctx context.Context, item pendingDelivery) bool {
	if s.webhooks == nil {
		s.failAll(ctx, []pendingDelivery{item}, errors.New("webhook delivery is not configured"), true)
		return false
	}
	target, err := s.resolveWebhook(ctx, item.target)
	if err != nil {
		// The webhook was removed after the delivery was queued. That is not a
		// failure worth retrying or worth alarming anyone about.
		s.cancel(ctx, item, "The webhook was removed before the notification was sent.")
		return false
	}
	var data map[string]any
	_ = json.Unmarshal(item.payload, &data)
	payload, err := EncodePayload(Event{
		Key: item.eventKey, Category: item.category, Severity: item.severity,
		Subject: item.subject, Body: item.body, OccurredAt: time.Now(), Payload: data,
	})
	if err != nil {
		s.failAll(ctx, []pendingDelivery{item}, err, true)
		return false
	}
	err = s.webhooks.Post(ctx, target, payload)
	s.recordWebhookResult(ctx, item.target, err)
	if err != nil {
		s.failAll(ctx, []pendingDelivery{item}, err, errors.Is(err, ErrPermanent))
		return false
	}
	s.markSent(ctx, []pendingDelivery{item})
	return true
}

func (s *Service) resolveWebhook(ctx context.Context, id string) (WebhookTarget, error) {
	var t WebhookTarget
	err := s.db.QueryRow(ctx, `
		SELECT id::text,name,url,signing_secret FROM notification_webhooks
		WHERE id=$1 AND deleted_at IS NULL AND enabled=TRUE`, id).Scan(&t.ID, &t.Name, &t.URL, &t.SigningSecret)
	return t, err
}

func (s *Service) recordWebhookResult(ctx context.Context, id string, err error) {
	message := ""
	if err != nil {
		message = truncate(err.Error(), 400)
	}
	_, _ = s.db.Exec(ctx, `
		UPDATE notification_webhooks SET last_attempt_at=now(),
			last_success_at=CASE WHEN $2='' THEN now() ELSE last_success_at END,
			last_error=$2, updated_at=now()
		WHERE id=$1`, id, message)
}

func (s *Service) markSent(ctx context.Context, items []pendingDelivery) {
	for _, item := range items {
		if _, err := s.db.Exec(ctx, `
			UPDATE notification_deliveries SET status='sent',sent_at=now(),attempts=attempts+1,last_error=''
			WHERE id=$1 AND status='pending' AND next_attempt_at=$2`, item.id, item.lease); err != nil {
			s.logger.Error("recording notification delivery failed", "error", err)
		}
	}
}

// release returns claimed rows that were never attempted so they are due again
// at once, instead of waiting out the lease.
func (s *Service) release(items []pendingDelivery) {
	if len(items) == 0 {
		return
	}
	// The caller's context may already be cancelled, which is the usual reason
	// to be here.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, item := range items {
		if _, err := s.db.Exec(ctx, `
			UPDATE notification_deliveries SET next_attempt_at=now()
			WHERE id=$1 AND status='pending' AND next_attempt_at=$2`, item.id, item.lease); err != nil {
			s.logger.Error("releasing notification delivery failed", "error", err)
		}
	}
}

// failAll records a failed attempt. A permanent failure stops immediately;
// anything else is retried on a backoff until the attempt budget runs out, and
// the last error is kept so the delivery log can explain the silence.
func (s *Service) failAll(ctx context.Context, items []pendingDelivery, cause error, permanent bool) {
	message := truncate(cause.Error(), 400)
	for _, item := range items {
		attempts := item.attempts + 1
		status := "pending"
		if permanent || attempts >= s.cfg.MaxAttempts {
			status = "failed"
		}
		if _, err := s.db.Exec(ctx, `
			UPDATE notification_deliveries
			SET status=$2, attempts=$3, last_error=$4, next_attempt_at=$5
			WHERE id=$1 AND status='pending' AND next_attempt_at=$6`,
			item.id, status, attempts, message, time.Now().Add(Backoff(attempts)), item.lease); err != nil {
			s.logger.Error("recording notification failure failed", "error", err)
		}
	}
	// One log line per batch, without the body or the recipient list.
	s.logger.Warn("notification delivery failed",
		"channel", items[0].channel, "category", items[0].category,
		"permanent", permanent, "error", message)
}

func (s *Service) cancel(ctx context.Context, item pendingDelivery, reason string) {
	_, _ = s.db.Exec(ctx, `UPDATE notification_deliveries SET status='cancelled',last_error=$2 WHERE id=$1 AND status='pending' AND next_attempt_at=$3`, item.id, reason, item.lease)
}

// composeEmail renders one message from one or more due conditions. A single
// condition reads as itself; several read as a digest.
func composeEmail(policy Settings, items []pendingDelivery, publicURL string) (string, string) {
	if len(items) == 1 {
		item := items[0]
		var body strings.Builder
		body.WriteString(item.body)
		body.WriteString("\n\n")
		if link := studioLink(publicURL, item.payload); link != "" {
			body.WriteString(link + "\n\n")
		}
		body.WriteString(emailFooter(policy))
		return item.subject, body.String()
	}

	counts := map[string]int{}
	for _, item := range items {
		counts[item.severity]++
	}
	subject := fmt.Sprintf("Tilecast: %d conditions need attention", len(items))
	if counts["critical"] > 0 {
		subject = fmt.Sprintf("Tilecast: %d conditions need attention, %d critical", len(items), counts["critical"])
	}

	var body strings.Builder
	body.WriteString("The following conditions were recorded.\n\n")
	sorted := append([]pendingDelivery(nil), items...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return severityRank[sorted[i].severity] > severityRank[sorted[j].severity]
	})
	for _, item := range sorted {
		body.WriteString(fmt.Sprintf("[%s] %s\n", strings.ToUpper(item.severity), item.subject))
		if item.body != "" && item.body != item.subject {
			body.WriteString("    " + strings.ReplaceAll(item.body, "\n", "\n    ") + "\n")
		}
		if link := studioLink(publicURL, item.payload); link != "" {
			body.WriteString("    " + link + "\n")
		}
		body.WriteString("\n")
	}
	body.WriteString(emailFooter(policy))
	return subject, body.String()
}

func studioLink(publicURL string, payload []byte) string {
	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		return ""
	}
	path, _ := data["studioPath"].(string)
	if path == "" || publicURL == "" {
		return ""
	}
	return strings.TrimRight(publicURL, "/") + path
}

func emailFooter(policy Settings) string {
	_ = policy
	return "You are receiving this because your Tilecast account is subscribed to notifications.\n" +
		"Change what you receive in Studio under Settings, My preferences, Notifications."
}

// SendTest delivers a message to one address immediately, bypassing
// subscriptions, quiet hours, and the outbox. It is the only way to find out
// whether SMTP works without waiting for something to break.
func (s *Service) SendTest(ctx context.Context, address string) error {
	if !s.cfg.EmailConfigured() || s.email == nil {
		return ErrEmailNotConfigured
	}
	policy, err := s.policy(ctx)
	if err != nil {
		return err
	}
	if policy.FromAddress == "" {
		return errors.New("set a from address in notification settings first")
	}
	return s.email.Send(ctx, Message{
		From:    mail.Address{Name: policy.FromName, Address: policy.FromAddress},
		To:      address,
		Subject: "Tilecast test notification",
		Body: "This is a test from Tilecast.\n\nIf you received it, notification email is working.\n" +
			"It does not confirm that anyone is subscribed: each account chooses that under Settings, My preferences, Notifications.\n",
		Category: CategoryIncident,
	})
}

// Cleanup applies delivery-log retention.
func (s *Service) Cleanup(ctx context.Context) error {
	policy, err := s.policy(ctx)
	if err != nil {
		return err
	}
	days := policy.RetentionDays
	if days <= 0 {
		days = 90
	}
	_, err = s.db.Exec(ctx, `
		DELETE FROM notification_deliveries
		WHERE status<>'pending' AND created_at < now() - make_interval(days => $1)`, days)
	return err
}

// ErrNotFound is returned by the webhook accessors.
var ErrNotFound = errors.New("not found")

// Webhook is the API view of a receiver. The signing secret is deliberately
// absent: it is returned exactly once, by CreateWebhook.
type Webhook struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	URL           string     `json:"url"`
	Enabled       bool       `json:"enabled"`
	Categories    []string   `json:"categories"`
	LastAttemptAt *time.Time `json:"lastAttemptAt,omitempty"`
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
}

// ListWebhooks returns the configured receivers.
func (s *Service) ListWebhooks(ctx context.Context) ([]Webhook, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id,name,url,enabled,categories,last_attempt_at,last_success_at,last_error,created_at
		FROM notification_webhooks WHERE deleted_at IS NULL ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		var w Webhook
		if err := rows.Scan(&w.ID, &w.Name, &w.URL, &w.Enabled, &w.Categories,
			&w.LastAttemptAt, &w.LastSuccessAt, &w.LastError, &w.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// CreateWebhook registers a receiver and returns the signing secret once.
func (s *Service) CreateWebhook(ctx context.Context, user uuid.UUID, name, rawURL string, categories []string) (Webhook, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Webhook{}, "", errors.New("a name is required")
	}
	if err := ValidateWebhookURL(rawURL); err != nil {
		return Webhook{}, "", err
	}
	if err := validateCategories(categories); err != nil {
		return Webhook{}, "", err
	}
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM notification_webhooks WHERE deleted_at IS NULL`).Scan(&count); err != nil {
		return Webhook{}, "", err
	}
	if count >= s.cfg.MaxWebhooksPerOrg {
		return Webhook{}, "", fmt.Errorf("no more than %d webhooks can be configured", s.cfg.MaxWebhooksPerOrg)
	}
	secret, err := NewSigningSecret()
	if err != nil {
		return Webhook{}, "", err
	}
	var org uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		return Webhook{}, "", err
	}
	id := uuid.New()
	if _, err := s.db.Exec(ctx, `
		INSERT INTO notification_webhooks(id,organization_id,name,url,signing_secret,categories,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7)`,
		id, org, name, strings.TrimSpace(rawURL), secret, normalizeCategories(categories), user); err != nil {
		return Webhook{}, "", err
	}
	created, err := s.getWebhook(ctx, id)
	return created, secret, err
}

// UpdateWebhook changes a receiver. The signing secret is never rotated here;
// a receiver that needs a new key gets a new webhook, so a silent rotation
// cannot break an integration nobody is watching.
func (s *Service) UpdateWebhook(ctx context.Context, id uuid.UUID, name, rawURL string, enabled bool, categories []string) (Webhook, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Webhook{}, errors.New("a name is required")
	}
	if err := ValidateWebhookURL(rawURL); err != nil {
		return Webhook{}, err
	}
	if err := validateCategories(categories); err != nil {
		return Webhook{}, err
	}
	tag, err := s.db.Exec(ctx, `
		UPDATE notification_webhooks SET name=$2,url=$3,enabled=$4,categories=$5,updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`,
		id, name, strings.TrimSpace(rawURL), enabled, normalizeCategories(categories))
	if err != nil {
		return Webhook{}, err
	}
	if tag.RowsAffected() == 0 {
		return Webhook{}, ErrNotFound
	}
	return s.getWebhook(ctx, id)
}

// DeleteWebhook removes a receiver. Pending deliveries aimed at it are
// cancelled rather than left to fail six times first.
func (s *Service) DeleteWebhook(ctx context.Context, id uuid.UUID) error {
	tag, err := s.db.Exec(ctx, `UPDATE notification_webhooks SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, err = s.db.Exec(ctx, `
		UPDATE notification_deliveries SET status='cancelled',last_error='The webhook was removed.'
		WHERE channel='webhook' AND target=$1 AND status='pending'`, id.String())
	return err
}

// TestWebhook posts a signed sample event so an operator can confirm the
// receiver accepts it.
func (s *Service) TestWebhook(ctx context.Context, id uuid.UUID) error {
	if s.webhooks == nil {
		// deliverWebhook already treats a nil sender as a supported build; this
		// path has to agree rather than panic.
		return errors.New("webhook delivery is not configured")
	}
	target, err := s.resolveWebhook(ctx, id.String())
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	payload, err := EncodePayload(Event{
		Key: "test:" + uuid.NewString(), Category: CategoryIncident, Severity: "info",
		Subject: "Tilecast test event", Body: "This is a test from Tilecast.",
		OccurredAt: time.Now(), Payload: map[string]any{"test": true},
	})
	if err != nil {
		return err
	}
	err = s.webhooks.Post(ctx, target, payload)
	s.recordWebhookResult(ctx, id.String(), err)
	return err
}

func (s *Service) getWebhook(ctx context.Context, id uuid.UUID) (Webhook, error) {
	var w Webhook
	err := s.db.QueryRow(ctx, `
		SELECT id,name,url,enabled,categories,last_attempt_at,last_success_at,last_error,created_at
		FROM notification_webhooks WHERE id=$1 AND deleted_at IS NULL`, id).
		Scan(&w.ID, &w.Name, &w.URL, &w.Enabled, &w.Categories,
			&w.LastAttemptAt, &w.LastSuccessAt, &w.LastError, &w.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Webhook{}, ErrNotFound
	}
	return w, err
}

func validateCategories(categories []string) error {
	for _, category := range categories {
		switch category {
		case CategoryIncident, CategoryContentHealth, CategoryBackup, CategoryUpdate:
		default:
			return fmt.Errorf("unknown notification category %q", category)
		}
	}
	return nil
}

func normalizeCategories(categories []string) []string {
	if len(categories) == 0 {
		return []string{}
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(categories))
	for _, category := range categories {
		if !seen[category] {
			seen[category] = true
			out = append(out, category)
		}
	}
	sort.Strings(out)
	return out
}

// Delivery is the API view of one delivery-log row.
type Delivery struct {
	ID        uuid.UUID  `json:"id"`
	EventKey  string     `json:"eventKey"`
	Category  string     `json:"category"`
	Severity  string     `json:"severity"`
	Channel   string     `json:"channel"`
	Target    string     `json:"target"`
	Subject   string     `json:"subject"`
	Status    string     `json:"status"`
	Attempts  int        `json:"attempts"`
	LastError string     `json:"lastError,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	SentAt    *time.Time `json:"sentAt,omitempty"`
}

// DeliveryCounts reports the queue depth and recent failures. It lives here
// rather than in the handler so a failing count is an error rather than a
// healthy-looking zero.
func (s *Service) DeliveryCounts(ctx context.Context) (pending int, recentFailures int, err error) {
	err = s.db.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status='pending'),
		       count(*) FILTER (WHERE status='failed' AND created_at > now()-interval '7 days')
		FROM notification_deliveries`).Scan(&pending, &recentFailures)
	return pending, recentFailures, err
}

// RecentDeliveries returns the delivery log, newest first.
func (s *Service) RecentDeliveries(ctx context.Context, limit int) ([]Delivery, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(ctx, `
		SELECT id,event_key,category,severity,channel,target,subject,status,attempts,last_error,created_at,sent_at
		FROM notification_deliveries ORDER BY created_at DESC, id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.EventKey, &d.Category, &d.Severity, &d.Channel, &d.Target,
			&d.Subject, &d.Status, &d.Attempts, &d.LastError, &d.CreatedAt, &d.SentAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
