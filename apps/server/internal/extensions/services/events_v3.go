package services

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// events.publish@1 of bundled plugins (docs/plugin-events.md). The
// publisher is the calling plugin: the input names only <name>@<version>.

// ErrCodeEventSchemaChanged answers a publish whose declared payload schema
// changed under the same version.
const ErrCodeEventSchemaChanged = "event_schema_changed"

type eventPublishInput struct {
	Event   string          `json:"event"`
	Subject string          `json:"subject"`
	Payload json.RawMessage `json:"payload"`
}

func (d *Dispatcher) eventPublish(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input eventPublishInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	occurrence, deliveries, err := d.deps.Plugins.PublishEvent(ctx, call.PluginID, input.Event, input.Subject, input.Payload)
	switch {
	case err == nil:
		return map[string]any{"occurrenceId": occurrence.String(), "deliveries": deliveries}, nil, nil
	case errors.Is(err, plugins.ErrEventUndeclared):
		return nil, nil, notFound("the plugin does not declare this event name and version")
	case errors.Is(err, plugins.ErrEventInvalid):
		return nil, nil, invalidInput("%s", err.Error())
	case errors.Is(err, plugins.ErrEventSchemaChanged):
		return nil, nil, &CallError{Code: ErrCodeEventSchemaChanged, Message: "The event's payload schema changed under the same version. Publish it as a new version."}
	case errors.Is(err, plugins.ErrPluginNotFound):
		return nil, nil, notFound("the plugin does not publish events")
	}
	return nil, nil, unavailable(err)
}
