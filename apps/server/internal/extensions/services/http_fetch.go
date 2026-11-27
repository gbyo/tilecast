package services

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// http.fetch@1: one request through a connection record of the calling
// plugin. The plugin identity is the one the host bound; a request can name
// only this plugin's connections and secrets.

type httpFetchInput struct {
	Connection uuid.UUID         `json:"connection"`
	Method     string            `json:"method"`
	URL        string            `json:"url"`
	Headers    []httpFetchHeader `json:"headers"`
	Body       []byte            `json:"body"`
}

type httpFetchHeader struct {
	Name   string           `json:"name"`
	Value  *string          `json:"value"`
	Secret *httpFetchSecret `json:"secret"`
}

type httpFetchSecret struct {
	Scope   string    `json:"scope"`
	OwnerID uuid.UUID `json:"ownerId"`
	Key     string    `json:"key"`
	Prefix  string    `json:"prefix"`
	Suffix  string    `json:"suffix"`
}

type httpFetchOutput struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
	Body    []byte              `json:"body"`
}

func (d *Dispatcher) httpFetch(ctx context.Context, call Call) (any, *Denial, *CallError) {
	var input httpFetchInput
	if failure := decode(call.Input, &input); failure != nil {
		return nil, nil, failure
	}
	if d.deps.Plugins == nil || call.PluginID == "" {
		return nil, nil, &CallError{Code: "connection_unavailable", Message: "The connection is not ready to use."}
	}
	if input.Connection == uuid.Nil || input.Method == "" || input.URL == "" {
		return nil, nil, invalidInput("a request names a connection, a method, and a URL")
	}
	request := plugins.ConnectionRequest{Connection: input.Connection, Method: input.Method, URL: input.URL, Body: input.Body}
	for _, header := range input.Headers {
		item := plugins.ConnectionHeader{Name: header.Name, Value: header.Value}
		if header.Secret != nil {
			item.Secret = &plugins.SecretHeader{Scope: header.Secret.Scope, OwnerID: header.Secret.OwnerID, Key: header.Secret.Key,
				Prefix: header.Secret.Prefix, Suffix: header.Secret.Suffix}
		}
		request.Headers = append(request.Headers, item)
	}
	response, err := d.deps.Plugins.FetchThroughConnection(ctx, call.PluginID, request)
	var refusal *plugins.FetchFailure
	switch {
	case errors.As(err, &refusal):
		return nil, nil, &CallError{Code: refusal.Code, Message: refusal.Message}
	case err != nil:
		return nil, nil, unavailable(err)
	}
	if response.Headers == nil {
		response.Headers = map[string][]string{}
	}
	return httpFetchOutput{Status: response.Status, Headers: response.Headers, Body: response.Body}, nil, nil
}
