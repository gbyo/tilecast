package plugins

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Generated dashboard routes of Plugin Manifest API 3 plugins. The handlers
// are thin: they decode, call the instance or settings service, and write
// the API model. The httpapi layer applies authentication, capabilities,
// grant scope, and CSRF exactly as for every plugin route.

func (s *Service) generatedRoutes(hosted hostedPlugin) []Route {
	manifest := hosted.manifest
	base := manifest.APIBasePath()
	if manifest.APIVersion < 3 || base == "" {
		return nil
	}
	id := manifest.ID
	route := func(method, pattern string, access plugin.Access, handler plugin.Handler) Route {
		return Route{PluginID: id, Method: method, Pattern: pattern, Access: access, Handler: handler}
	}
	out := []Route{}
	if manifest.Settings != nil && len(manifest.Settings.Organization) > 0 {
		out = append(out,
			route(http.MethodGet, base+"/settings/organization", plugin.AccessViewer, s.handleGetSettings(id, scopeOrganization)),
			route(http.MethodPut, base+"/settings/organization", plugin.AccessManager, s.handlePutSettings(id, scopeOrganization)))
	}
	if manifest.Settings != nil && len(manifest.Settings.Screen) > 0 {
		out = append(out,
			route(http.MethodGet, base+"/settings/screens/{screenId}", plugin.AccessViewer, s.handleGetSettings(id, scopeScreen)),
			route(http.MethodPut, base+"/settings/screens/{screenId}", plugin.AccessManager, s.handlePutSettings(id, scopeScreen)))
	}
	for _, kind := range manifest.Instances {
		collection := base + "/" + kind.Path
		name := kind.Kind
		out = append(out,
			route(http.MethodGet, collection, plugin.AccessViewer, func(w http.ResponseWriter, r *http.Request) error {
				items, err := s.ListInstances(r.Context(), id, name)
				if err != nil {
					return err
				}
				plugin.WriteData(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
				return nil
			}),
			route(http.MethodGet, collection+"/{id}", plugin.AccessViewer, func(w http.ResponseWriter, r *http.Request) error {
				instanceID, err := plugin.PathUUID(r, "id")
				if err != nil {
					return err
				}
				item, err := s.GetInstance(r.Context(), id, name, instanceID)
				if err != nil {
					return err
				}
				plugin.WriteData(w, http.StatusOK, item)
				return nil
			}),
			route(http.MethodPost, collection, plugin.AccessManager, func(w http.ResponseWriter, r *http.Request) error {
				write, err := decodeInstanceWrite(w, r)
				if err != nil {
					return err
				}
				item, err := s.CreateInstance(r.Context(), id, name, actorID(r), write)
				if err != nil {
					return err
				}
				plugin.WriteData(w, http.StatusCreated, item)
				return nil
			}),
			route(http.MethodPut, collection+"/{id}", plugin.AccessManager, func(w http.ResponseWriter, r *http.Request) error {
				instanceID, err := plugin.PathUUID(r, "id")
				if err != nil {
					return err
				}
				write, err := decodeInstanceWrite(w, r)
				if err != nil {
					return err
				}
				item, err := s.UpdateInstance(r.Context(), id, name, instanceID, actorID(r), write)
				if err != nil {
					return err
				}
				plugin.WriteData(w, http.StatusOK, item)
				return nil
			}),
			route(http.MethodDelete, collection+"/{id}", plugin.AccessManager, func(w http.ResponseWriter, r *http.Request) error {
				instanceID, err := plugin.PathUUID(r, "id")
				if err != nil {
					return err
				}
				if err := s.DeleteInstance(r.Context(), id, name, instanceID, actorID(r)); err != nil {
					return err
				}
				w.WriteHeader(http.StatusNoContent)
				return nil
			}))
	}
	return out
}

func actorID(r *http.Request) uuid.UUID {
	principal, _ := plugin.PrincipalFrom(r.Context())
	return principal.UserID
}

func (s *Service) handleGetSettings(pluginID, scope string) plugin.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		screenID := uuid.Nil
		if scope == scopeScreen {
			var err error
			if screenID, err = plugin.PathUUID(r, "screenId"); err != nil {
				return err
			}
		}
		document, err := s.GetSettings(r.Context(), pluginID, scope, screenID)
		if err != nil {
			return err
		}
		plugin.WriteData(w, http.StatusOK, document)
		return nil
	}
}

func (s *Service) handlePutSettings(pluginID, scope string) plugin.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		screenID := uuid.Nil
		if scope == scopeScreen {
			var err error
			if screenID, err = plugin.PathUUID(r, "screenId"); err != nil {
				return err
			}
		}
		var write settingsWrite
		if err := plugin.DecodeJSONLimit(w, r, &write, MaxInstanceBodyBytes); err != nil {
			return err
		}
		document, err := s.UpdateSettings(r.Context(), pluginID, scope, screenID, actorID(r), write)
		if err != nil {
			return err
		}
		plugin.WriteData(w, http.StatusOK, document)
		return nil
	}
}
