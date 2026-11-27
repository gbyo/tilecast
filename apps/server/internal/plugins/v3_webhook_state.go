package plugins

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/credential"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Webhook tokens, the webhook state Studio shows, the install review, and
// the cleanup of webhook state (docs/plugin-webhooks.md).

// WebhookTokenPrefix identifies a plugin webhook token in a log or a
// configuration file. It differs from the integration token prefix tci_:
// the two credentials share a shape and nothing else.
const WebhookTokenPrefix = "tch_"

// MaxActiveWebhookTokens bounds the unrevoked tokens of one webhook: one
// for each sending system, with room for a rotation.
const MaxActiveWebhookTokens = 10

// Webhook token failures.
var (
	ErrWebhookNotFound      = errors.New("the plugin does not declare this webhook")
	ErrWebhookNotToken      = errors.New("the webhook does not use token authentication")
	ErrWebhookTokenNotFound = errors.New("webhook token not found")
	ErrWebhookTokenInvalid  = errors.New("invalid webhook token request")
	ErrWebhookTokenLimit    = errors.New("the webhook has the most active tokens it may have")
)

// WebhookToken is the metadata of a token. It never carries the secret.
type WebhookToken struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	PublicID   string     `json:"publicId"`
	CreatedAt  time.Time  `json:"createdAt"`
	CreatedBy  *uuid.UUID `json:"createdBy,omitempty"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	RevokedAt  *time.Time `json:"revokedAt,omitempty"`
}

// CreatedWebhookToken is a new token with its secret, returned once.
type CreatedWebhookToken struct {
	WebhookToken
	Token string `json:"token"`
}

func (s *Service) tokenWebhook(pluginID, webhookID string) (hostedPlugin, plugin.WebhookDeclaration, error) {
	hosted, err := s.v3Plugin(pluginID)
	if err != nil {
		return hostedPlugin{}, plugin.WebhookDeclaration{}, err
	}
	declaration, ok := hosted.manifest.WebhookByID(webhookID)
	if !ok {
		return hostedPlugin{}, plugin.WebhookDeclaration{}, ErrWebhookNotFound
	}
	if declaration.Authentication != plugin.WebhookAuthToken {
		return hostedPlugin{}, plugin.WebhookDeclaration{}, ErrWebhookNotToken
	}
	return hosted, declaration, nil
}

// CreateWebhookToken issues a token for one token webhook. The caller
// authorizes plugins.manage. The secret is in the answer and nowhere else.
func (s *Service) CreateWebhookToken(ctx context.Context, pluginID, webhookID, name string, userID uuid.UUID) (CreatedWebhookToken, error) {
	hosted, declaration, err := s.tokenWebhook(pluginID, webhookID)
	if err != nil {
		return CreatedWebhookToken{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 80 {
		return CreatedWebhookToken{}, fmt.Errorf("%w: a name is 1 to 80 characters", ErrWebhookTokenInvalid)
	}
	publicID, secret, err := credential.New()
	if err != nil {
		return CreatedWebhookToken{}, err
	}
	var token WebhookToken
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var installed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plugin_installations WHERE plugin_id=$1 FOR SHARE)`, pluginID).Scan(&installed); err != nil {
			return err
		}
		if !installed {
			return ErrPluginNotFound
		}
		var active int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM plugin_webhook_tokens WHERE plugin_id=$1 AND webhook_id=$2 AND revoked_at IS NULL`,
			pluginID, webhookID).Scan(&active); err != nil {
			return err
		}
		if active >= MaxActiveWebhookTokens {
			return ErrWebhookTokenLimit
		}
		id := uuid.New()
		if err := tx.QueryRow(ctx, `INSERT INTO plugin_webhook_tokens(id,plugin_id,webhook_id,name,public_id,secret_hash,created_by,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+webhookTokenColumns,
			id, pluginID, webhookID, name, publicID, credential.Digest(secret), nullableUser(userID), s.clock.Now().UTC()).
			Scan(webhookTokenFields(&token)...); err != nil {
			return err
		}
		return s.auditPluginResource(ctx, tx, "plugin.webhook_token.created", "plugin_webhook_token", pluginID, id, name, userID, map[string]any{
			"webhookId": declaration.ID, "publicId": publicID, "plugin": hosted.definition.Name,
		})
	})
	if err != nil {
		return CreatedWebhookToken{}, err
	}
	return CreatedWebhookToken{WebhookToken: token, Token: credential.Format(WebhookTokenPrefix, publicID, secret)}, nil
}

// RevokeWebhookToken permanently disables a token.
func (s *Service) RevokeWebhookToken(ctx context.Context, pluginID, webhookID string, tokenID, userID uuid.UUID) (WebhookToken, error) {
	if _, _, err := s.tokenWebhook(pluginID, webhookID); err != nil {
		return WebhookToken{}, err
	}
	var token WebhookToken
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `UPDATE plugin_webhook_tokens SET revoked_at=$4
			WHERE id=$1 AND plugin_id=$2 AND webhook_id=$3 AND revoked_at IS NULL RETURNING `+webhookTokenColumns,
			tokenID, pluginID, webhookID, s.clock.Now().UTC()).Scan(webhookTokenFields(&token)...)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWebhookTokenNotFound
		}
		if err != nil {
			return err
		}
		return s.auditPluginResource(ctx, tx, "plugin.webhook_token.revoked", "plugin_webhook_token", pluginID, tokenID, token.Name, userID, map[string]any{
			"webhookId": webhookID, "publicId": token.PublicID,
		})
	})
	return token, err
}

const webhookTokenColumns = `id,name,public_id,created_at,created_by,last_used_at,revoked_at`

func webhookTokenFields(token *WebhookToken) []any {
	return []any{&token.ID, &token.Name, &token.PublicID, &token.CreatedAt, &token.CreatedBy, &token.LastUsedAt, &token.RevokedAt}
}

// authenticateWebhookToken checks an Authorization header against the
// tokens of one webhook. The public ID selects the row, the secret is
// compared with its digest in constant time, and a token of another
// webhook, a revoked token, and a malformed header all answer false.
func (s *Service) authenticateWebhookToken(ctx context.Context, pluginID, webhookID, header string) bool {
	publicID, secret, ok := credential.ParseBearer(header, WebhookTokenPrefix)
	if !ok || len(publicID) != 24 {
		return false
	}
	var (
		id                     uuid.UUID
		tokenPlugin, tokenHook string
		stored                 []byte
		revokedAt              *time.Time
	)
	err := s.db.QueryRow(ctx, `SELECT id,plugin_id,webhook_id,secret_hash,revoked_at FROM plugin_webhook_tokens WHERE public_id=$1`, publicID).
		Scan(&id, &tokenPlugin, &tokenHook, &stored, &revokedAt)
	if err != nil {
		return false
	}
	matches := credential.Matches(secret, stored)
	if !matches || revokedAt != nil || tokenPlugin != pluginID || tokenHook != webhookID {
		return false
	}
	// Best effort: a failed timestamp update does not refuse the request.
	_, _ = s.db.Exec(ctx, `UPDATE plugin_webhook_tokens SET last_used_at=$2 WHERE id=$1`, id, s.clock.Now().UTC())
	return true
}

// Webhook reachability.
const (
	// WebhookReachable: TILECAST_PUBLIC_URL is HTTPS. The Server cannot
	// prove that the address is reachable from outside.
	WebhookReachable = "available"
	// WebhookNeedsPublicHTTPS: a SaaS provider sends to this webhook and
	// TILECAST_PUBLIC_URL is not HTTPS.
	WebhookNeedsPublicHTTPS = "public_https_required"
	// WebhookLocalOnly: a token webhook on a plain HTTP address. A system
	// that reaches that address can use it.
	WebhookLocalOnly = "local_network"
	// WebhookNoPublicURL: TILECAST_PUBLIC_URL is missing or not a usable
	// address.
	WebhookNoPublicURL = "public_url_missing"
)

// WebhookState is one webhook as Studio shows it. It never holds a body,
// a header, a secret, a token, or an address of a sender.
type WebhookState struct {
	ID                  string `json:"id"`
	Title               string `json:"title"`
	Description         string `json:"description,omitempty"`
	Authentication      string `json:"authentication"`
	Scheme              string `json:"scheme,omitempty"`
	AckStatus           int    `json:"ackStatus"`
	Handshake           string `json:"handshake,omitempty"`
	EndpointURL         string `json:"endpointUrl,omitempty"`
	Reachability        string `json:"reachability"`
	RequiresPublicHTTPS bool   `json:"requiresPublicHttps"`
	// SigningSecret is the state of the signing secret of a
	// standard-webhooks or hmac-sha256 webhook, and SigningSecretKey the
	// organization setting that holds it.
	SigningSecret    pluginsecrets.State `json:"signingSecret,omitempty"`
	SigningSecretKey string              `json:"signingSecretKey,omitempty"`
	AcceptedCount    int64               `json:"acceptedCount"`
	DuplicateCount   int64               `json:"duplicateCount"`
	Pending          int                 `json:"pending"`
	LastAcceptedAt   *time.Time          `json:"lastAcceptedAt,omitempty"`
	LastDuplicateAt  *time.Time          `json:"lastDuplicateAt,omitempty"`
	LastRefusedAt    *time.Time          `json:"lastRefusedAt,omitempty"`
	LastRefusal      string              `json:"lastRefusal,omitempty"`
	// Tokens are the tokens of a token webhook, on the Webhooks page only.
	Tokens []WebhookToken `json:"tokens,omitempty"`
}

// Webhooks lists the webhooks of a plugin with their state and, for token
// webhooks, their tokens.
func (s *Service) Webhooks(ctx context.Context, pluginID string) ([]WebhookState, error) {
	return s.webhookStates(ctx, pluginID, true)
}

func (s *Service) webhookStates(ctx context.Context, pluginID string, tokens bool) ([]WebhookState, error) {
	hosted, err := s.v3Plugin(pluginID)
	if err != nil {
		return nil, err
	}
	out := []WebhookState{}
	if len(hosted.manifest.Webhooks) == 0 {
		return out, nil
	}
	secretStates := map[string]pluginsecrets.State{}
	if s.secrets != nil {
		keys := []string{}
		for _, webhook := range hosted.manifest.Webhooks {
			if webhook.Signature != nil && webhook.Signature.Secret != "" {
				keys = append(keys, webhook.Signature.Secret)
			}
		}
		if len(keys) > 0 {
			organizationID, err := s.organizationID(ctx)
			if err != nil {
				return nil, err
			}
			if secretStates, err = s.secrets.States(ctx, s.db, pluginID, pluginsecrets.OwnerOrganization, organizationID, keys); err != nil {
				return nil, err
			}
		}
	}
	for _, webhook := range hosted.manifest.Webhooks {
		state := WebhookState{ID: webhook.ID, Title: webhook.Title, Description: webhook.Description,
			Authentication: webhook.Authentication, AckStatus: webhook.Ack(), RequiresPublicHTTPS: webhook.RequiresPublicHTTPS()}
		if webhook.Signature != nil {
			state.Scheme = webhook.Signature.Scheme
			if key := webhook.Signature.Secret; key != "" {
				state.SigningSecretKey = key
				state.SigningSecret = pluginsecrets.StateNotSet
				if value, ok := secretStates[key]; ok {
					state.SigningSecret = value
				}
			}
		}
		if webhook.Handshake != nil {
			state.Handshake = webhook.Handshake.Type
		}
		endpoint, https := s.webhookEndpoint(pluginID, webhook.ID)
		state.EndpointURL = endpoint
		switch {
		case endpoint == "":
			state.Reachability = WebhookNoPublicURL
		case https:
			state.Reachability = WebhookReachable
		case webhook.RequiresPublicHTTPS():
			state.Reachability = WebhookNeedsPublicHTTPS
		default:
			state.Reachability = WebhookLocalOnly
		}
		err := s.db.QueryRow(ctx, `SELECT accepted_count,duplicate_count,last_accepted_at,last_duplicate_at,last_refused_at,COALESCE(last_refusal,'')
			FROM plugin_webhook_status WHERE plugin_id=$1 AND webhook_id=$2`, pluginID, webhook.ID).
			Scan(&state.AcceptedCount, &state.DuplicateCount, &state.LastAcceptedAt, &state.LastDuplicateAt, &state.LastRefusedAt, &state.LastRefusal)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM plugin_deliveries WHERE plugin_id=$1 AND kind=$2 AND source=$3 AND state='pending'`,
			pluginID, plugindelivery.KindWebhook, webhook.ID).Scan(&state.Pending); err != nil {
			return nil, err
		}
		if tokens && webhook.Authentication == plugin.WebhookAuthToken {
			rows, err := s.db.Query(ctx, `SELECT `+webhookTokenColumns+` FROM plugin_webhook_tokens
				WHERE plugin_id=$1 AND webhook_id=$2 ORDER BY created_at DESC, id`, pluginID, webhook.ID)
			if err != nil {
				return nil, err
			}
			state.Tokens, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (WebhookToken, error) {
				var token WebhookToken
				return token, row.Scan(webhookTokenFields(&token)...)
			})
			if err != nil {
				return nil, err
			}
			if state.Tokens == nil {
				state.Tokens = []WebhookToken{}
			}
		}
		out = append(out, state)
	}
	return out, nil
}

// WebhookReview is what the install review shows about one webhook.
type WebhookReview struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Description    string `json:"description,omitempty"`
	Authentication string `json:"authentication"`
	Scheme         string `json:"scheme,omitempty"`
	AckStatus      int    `json:"ackStatus"`
	Handshake      string `json:"handshake,omitempty"`
	// Path is the endpoint below the Server's public address.
	Path                string `json:"path"`
	RequiresPublicHTTPS bool   `json:"requiresPublicHttps"`
	// SigningSecretKey is the organization setting the operator fills in.
	SigningSecretKey string `json:"signingSecretKey,omitempty"`
}

func webhookReviews(m plugin.Manifest) []WebhookReview {
	out := []WebhookReview{}
	if m.APIVersion < 3 {
		return out
	}
	for _, webhook := range m.Webhooks {
		review := WebhookReview{ID: webhook.ID, Title: webhook.Title, Description: webhook.Description,
			Authentication: webhook.Authentication, AckStatus: webhook.Ack(),
			Path: "/api/v1/hooks/" + m.ID + "/" + webhook.ID, RequiresPublicHTTPS: webhook.RequiresPublicHTTPS()}
		if webhook.Signature != nil {
			review.Scheme, review.SigningSecretKey = webhook.Signature.Scheme, webhook.Signature.Secret
		}
		if webhook.Handshake != nil {
			review.Handshake = webhook.Handshake.Type
		}
		out = append(out, review)
	}
	return out
}

// removeWebhookState deletes the tokens, receipts, and status of a plugin
// in its removal transaction. The queued requests go with the delivery
// queue.
func removeWebhookState(ctx context.Context, tx pgx.Tx, pluginID string) error {
	for _, table := range []string{"plugin_webhook_tokens", "plugin_webhook_receipts", "plugin_webhook_status"} {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE plugin_id=$1`, pluginID); err != nil {
			return err
		}
	}
	return nil
}

// SweepWebhooks deletes expired replay receipts, and the tokens, receipts,
// and status of webhooks that a plugin of this release no longer declares
// or whose plugin is not installed. A token of a removed declaration never
// authenticates again, also if a later release declares the ID again.
func (s *Service) SweepWebhooks(ctx context.Context) (int64, error) {
	now := s.clock.Now().UTC()
	tag, err := s.db.Exec(ctx, `DELETE FROM plugin_webhook_receipts WHERE expires_at <= $1`, now)
	if err != nil {
		return 0, err
	}
	removed := tag.RowsAffected()
	declared := []string{}
	for _, hosted := range s.hosted {
		for _, webhook := range hosted.manifest.Webhooks {
			if hosted.manifest.APIVersion >= 3 {
				declared = append(declared, hosted.manifest.ID+"/"+webhook.ID)
			}
		}
	}
	for _, table := range []string{"plugin_webhook_tokens", "plugin_webhook_receipts", "plugin_webhook_status"} {
		tag, err := s.db.Exec(ctx, `DELETE FROM `+table+` t WHERE NOT (t.plugin_id || '/' || t.webhook_id = ANY($1))
			OR NOT EXISTS (SELECT 1 FROM plugin_installations i WHERE i.plugin_id=t.plugin_id)`, declared)
		if err != nil {
			return removed, err
		}
		removed += tag.RowsAffected()
	}
	return removed, nil
}
