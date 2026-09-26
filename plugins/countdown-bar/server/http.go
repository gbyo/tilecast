package server

import (
	"net/http"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

const instances = "/plugins/countdown-bar/instances"

// Routes are described in ../api/openapi.yaml.
func (p *Plugin) Routes(router plugin.Router) {
	router.Handle(http.MethodGet, instances, plugin.AccessViewer, p.handleList)
	router.Handle(http.MethodGet, instances+"/{id}", plugin.AccessViewer, p.handleGet)
	router.Handle(http.MethodPost, instances, plugin.AccessManager, p.handleCreate)
	router.Handle(http.MethodPut, instances+"/{id}", plugin.AccessManager, p.handleUpdate)
	router.Handle(http.MethodDelete, instances+"/{id}", plugin.AccessManager, p.handleDelete)
}

func (p *Plugin) handleList(w http.ResponseWriter, r *http.Request) error {
	items, err := p.List(r.Context())
	if err != nil {
		return err
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
	return nil
}

func (p *Plugin) handleGet(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	item, err := p.Get(r.Context(), id)
	if err != nil {
		return err
	}
	plugin.WriteData(w, http.StatusOK, item)
	return nil
}

func (p *Plugin) handleCreate(w http.ResponseWriter, r *http.Request) error {
	var input Input
	if err := plugin.DecodeJSON(w, r, &input); err != nil {
		return err
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	item, err := p.Create(r.Context(), principal.UserID, input)
	if err != nil {
		return err
	}
	plugin.WriteData(w, http.StatusCreated, item)
	return nil
}

func (p *Plugin) handleUpdate(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	var input Input
	if err = plugin.DecodeJSON(w, r, &input); err != nil {
		return err
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	item, err := p.Update(r.Context(), id, principal.UserID, input)
	if err != nil {
		return err
	}
	plugin.WriteData(w, http.StatusOK, item)
	return nil
}

func (p *Plugin) handleDelete(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	if err = p.Delete(r.Context(), id, principal.UserID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
