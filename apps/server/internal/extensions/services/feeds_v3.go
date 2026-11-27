package services

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// feeds.publish@1 of bundled plugins. The plugin identity the host bound
// selects the feeds; an input names a feed of this plugin only.

// Feed failure codes.
const (
	ErrCodeFeedConflict = "revision_conflict"
	ErrCodeFeedTooLarge = "too_large"
)

type feedPublishInput struct {
	Feed        string                    `json:"feed"`
	Instance    uuid.UUID                 `json:"instance"`
	Replaces    int64                     `json:"replaces"`
	Records     []plugins.FeedRecordInput `json:"records"`
	ValidUntil  *time.Time                `json:"validUntil"`
	Connections map[string]uuid.UUID      `json:"connections"`
}

func (d *Dispatcher) feedPublish(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input feedPublishInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	if input.Records == nil {
		return nil, nil, invalidInput("a publication carries the complete record set; send records: [] to empty it")
	}
	published, err := d.deps.Plugins.PublishFeed(ctx, call.PluginID, plugins.FeedPublication{Feed: input.Feed, Instance: input.Instance,
		Replaces: input.Replaces, Records: input.Records, ValidUntil: input.ValidUntil, Connections: input.Connections})
	var conflict *plugins.FeedConflictError
	switch {
	case err == nil:
		return published, nil, nil
	case errors.As(err, &conflict):
		return nil, nil, &CallError{Code: ErrCodeFeedConflict, Message: "Another publication changed the dataset. Read the current revision and publish again."}
	case errors.Is(err, plugins.ErrFeedTooLarge):
		return nil, nil, &CallError{Code: ErrCodeFeedTooLarge, Message: "A publication is at most 512 KiB of canonical JSON."}
	case errors.Is(err, plugins.ErrFeedInvalid):
		return nil, nil, invalidInput("%v", err)
	case errors.Is(err, plugins.ErrPluginNotFound):
		return nil, nil, notFound("the plugin declares no feeds")
	}
	return nil, nil, unavailable(err)
}

type feedRevisionInput struct {
	Feed     string    `json:"feed"`
	Instance uuid.UUID `json:"instance"`
}

func (d *Dispatcher) feedRevision(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input feedRevisionInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	revision, err := d.deps.Plugins.FeedRevision(ctx, call.PluginID, input.Feed, input.Instance)
	switch {
	case err == nil:
		return map[string]int64{"revision": revision}, nil, nil
	case errors.Is(err, plugins.ErrFeedInvalid):
		return nil, nil, invalidInput("%v", err)
	case errors.Is(err, plugins.ErrPluginNotFound):
		return nil, nil, notFound("the plugin declares no feeds")
	}
	return nil, nil, unavailable(err)
}

type instanceReadInput struct {
	Kind string    `json:"kind"`
	ID   uuid.UUID `json:"id"`
}

// instanceRead answers one instance of the calling plugin. Secrets stay in
// the secret store; the answer holds only their absence.
func (d *Dispatcher) instanceRead(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input instanceReadInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	if input.Kind == "" || input.ID == uuid.Nil {
		return nil, nil, invalidInput("a read names an instance kind and an ID")
	}
	document, err := d.deps.Plugins.GetInstance(ctx, call.PluginID, input.Kind, input.ID)
	switch {
	case err == nil:
		return map[string]any{"id": document.ID, "kind": document.Kind, "name": document.Name, "enabled": document.Enabled,
			"revision": document.Revision, "configuration": document.Configuration}, nil, nil
	case errors.Is(err, plugins.ErrNotFound), errors.Is(err, plugins.ErrPluginNotFound):
		return nil, nil, notFound("the plugin has no such instance")
	}
	return nil, nil, unavailable(err)
}

// maxInstanceList bounds instances.read@1/list: the IDs, names, and state
// of at most this many instances fit the answer.
const maxInstanceList = 500

func (d *Dispatcher) instanceList(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input struct {
		Kind string `json:"kind"`
	}
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if failure := d.pluginReady(call); failure != nil {
		return nil, nil, failure
	}
	documents, err := d.deps.Plugins.ListInstances(ctx, call.PluginID, input.Kind)
	if errors.Is(err, plugins.ErrNotFound) || errors.Is(err, plugins.ErrPluginNotFound) {
		return nil, nil, notFound("the plugin has no such instance kind")
	}
	if err != nil {
		return nil, nil, unavailable(err)
	}
	items := make([]map[string]any, 0, len(documents))
	for _, document := range documents {
		if len(items) == maxInstanceList {
			break
		}
		items = append(items, map[string]any{"id": document.ID, "name": document.Name, "enabled": document.Enabled, "revision": document.Revision})
	}
	return map[string]any{"items": items, "truncated": len(documents) > maxInstanceList}, nil, nil
}
