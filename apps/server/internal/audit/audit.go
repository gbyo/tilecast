// Package audit is the single shared path for writing audit events.
//
// Every audit row names the human user, the calling surface, the client,
// and the request that caused it. Helpers enrich the row from the request
// context automatically: handlers pass what they know (action, resource,
// outcome) and the package fills in who, where from, and which request.
// Direct INSERT INTO audit_logs calls outside this package are prohibited;
// internal/audit/audit_test.go fails the build if one appears.
//
// Audit metadata never carries secrets. Writers keep credentials, tokens,
// and raw secrets out of Metadata; anything sensitive goes through
// SensitiveMetadata, which the retention job wipes first.
package audit

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// Surface names the calling surface recorded on every audit row.
type Surface string

const (
	// SurfaceStudio is Tilecast Studio in a browser.
	SurfaceStudio Surface = "studio"
	// SurfaceCLI is the tilecast remote CLI.
	SurfaceCLI Surface = "cli"
	// SurfaceMCP is an authorized agent through the MCP interface.
	SurfaceMCP Surface = "mcp"
	// SurfaceAPI is a direct API call: a personal access token or another
	// non-browser credential whose kind alone proves nothing about the
	// program that sent the request.
	SurfaceAPI Surface = "api"
	// SurfaceLegacy is the database default for rows written by legacy
	// direct writers that predate the shared path. New and touched code
	// must name a real surface; Record refuses an empty one.
	SurfaceLegacy Surface = "legacy"
	// SurfaceSystem is server background work with an explicit identity.
	// System events must name a human actor or the initiating server client.
	SurfaceSystem Surface = "system"
)

// Result mirrors the audit_logs result check.
const (
	ResultSuccess = "success"
	ResultFailure = "failure"
	ResultDenied  = "denied"
	ResultPartial = "partial"
)

// Event describes one audit row. Action and ResourceType are required.
// Actor defaults to the context principal; Surface defaults to the context
// surface and must resolve to a real value; RequestID, ClientID, and
// ClientInstance resolve from context when the caller leaves them empty.
// Result defaults to success.
type Event struct {
	Action       string
	ResourceType string
	ResourceID   string
	ResourceName string
	Result       string
	Summary      string
	Metadata     map[string]any
	// SensitiveMetadata marks Metadata for first-wipe retention. It does not
	// make secrets acceptable: keep credentials and tokens out regardless.
	SensitiveMetadata bool
	Actor             *uuid.UUID
	Surface           Surface
	RequestID         string
	ClientID          string
	ClientInstance    string
	IP                string
}

// DB is the Exec surface shared by pools and transactions.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type contextKey string

const (
	surfaceKey  contextKey = "audit-surface"
	requestKey  contextKey = "audit-request"
	clientKey   contextKey = "audit-client"
	instanceKey contextKey = "audit-client-instance"
)

// WithSurface records the calling surface on the context. Studio
// requests set studio in requireUser; Bearer [REDACTED] set their own surface there.
func WithSurface(ctx context.Context, surface Surface) context.Context {
	return context.WithValue(ctx, surfaceKey, surface)
}

// SurfaceFrom returns the context surface, or empty when no caller set
// one. There is deliberately no default: inferring Studio from silence is
// how background work gets misattributed as browser actions.
func SurfaceFrom(ctx context.Context) Surface {
	if surface, ok := ctx.Value(surfaceKey).(Surface); ok {
		return surface
	}
	return ""
}

// WithRequest records the request ID on the context.
func WithRequest(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, requestKey, requestID)
}

// WithClient records the client identity on the context.
func WithClient(ctx context.Context, id, instance string) context.Context {
	ctx = context.WithValue(ctx, clientKey, id)
	return context.WithValue(ctx, instanceKey, instance)
}

func stringFrom(ctx context.Context, key contextKey) string {
	if value, ok := ctx.Value(key).(string); ok {
		return value
	}
	return ""
}

// recordColumns is the one INSERT the codebase may use for audit rows.
const recordColumns = `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,ip_address,request_id,summary,metadata,metadata_sensitive,calling_surface,client_id,client_instance)
	VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::inet,NULLIF($9,''),$10,$11::jsonb,$12,$13,NULLIF($14,''),NULLIF($15,''))`

// Record writes one audit row, enriching the event from the context. The
// human user comes from the context principal or an explicit actor. System
// work can instead name the server client without inventing a human actor.
func Record(ctx context.Context, db DB, event Event) error {
	if event.Action == "" || event.ResourceType == "" {
		return errors.New("audit event needs an action and a resource type")
	}
	surface := event.Surface
	if surface == "" {
		surface = SurfaceFrom(ctx)
	}
	if surface == "" {
		return errors.New("audit event needs an explicit calling surface")
	}
	var actor *uuid.UUID
	if event.Actor != nil {
		actor = event.Actor
	} else if principal, ok := auth.PrincipalFrom(ctx); ok {
		id := principal.User.ID
		actor = &id
	}
	result := event.Result
	if result == "" {
		result = ResultSuccess
	}
	requestID := event.RequestID
	if requestID == "" {
		requestID = stringFrom(ctx, requestKey)
	}
	clientID := event.ClientID
	if clientID == "" {
		clientID = stringFrom(ctx, clientKey)
	}
	if surface == SurfaceSystem && actor == nil && clientID == "" {
		return errors.New("system audit events need an explicit actor or client identity")
	}
	instance := event.ClientInstance
	if instance == "" {
		instance = stringFrom(ctx, instanceKey)
	}
	metadata := event.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	var name *string
	if event.ResourceName != "" {
		resourceName := event.ResourceName
		name = &resourceName
	}
	_, err := db.Exec(ctx, recordColumns,
		uuid.New(), actor, event.Action, event.ResourceType, event.ResourceID, name,
		result, event.IP, requestID, event.Summary, metadata, event.SensitiveMetadata,
		string(surface), clientID, instance)
	return err
}

// RecordTx runs Record inside an explicit transaction step. pgx.Tx satisfies
// DB, so this is documentation rather than machinery: plugin hosts and
// multi-write handlers name the transactional intent at the call site.
func RecordTx(ctx context.Context, tx pgx.Tx, event Event) error {
	return Record(ctx, tx, event)
}
