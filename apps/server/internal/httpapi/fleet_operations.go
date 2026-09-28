package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/fleetops"
)

type bulkOperationRequest struct {
	fleetops.Request
	// ExpectedChangeCount is the number shown in the preview the operator
	// confirmed. Apply refuses when the fleet has moved since. A negative
	// value skips the check, which only the API uses; Studio always sends it.
	ExpectedChangeCount *int `json:"expectedChangeCount,omitempty"`
}

func (s *server) previewBulkOperation(w http.ResponseWriter, r *http.Request) {
	var body bulkOperationRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	// Scope is checked on the selection before the preview expands it through
	// sync groups, so an operator cannot reach outside their scope by naming one
	// screen in a group that straddles it.
	if !s.authorizeScreenList(w, r, body.ScreenIDs, nil) {
		return
	}
	preview, err := s.fleet.Build(r.Context(), body.Request)
	if errors.Is(err, fleetops.ErrValidation) {
		writeError(w, http.StatusUnprocessableEntity, "bulk_operation_invalid", trimSentinel(err))
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": preview})
}

func (s *server) applyBulkOperation(w http.ResponseWriter, r *http.Request) {
	var body bulkOperationRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	// Scope is checked on the selection before the preview expands it through
	// sync groups, so an operator cannot reach outside their scope by naming one
	// screen in a group that straddles it.
	if !s.authorizeScreenList(w, r, body.ScreenIDs, nil) {
		return
	}
	expected := -1
	if body.ExpectedChangeCount != nil {
		expected = *body.ExpectedChangeCount
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	operation, err := s.fleet.Apply(r.Context(), user.ID, body.Request, expected)
	switch {
	case errors.Is(err, fleetops.ErrStale):
		// 409 rather than 422: the request was fine, the world moved.
		writeError(w, http.StatusConflict, "bulk_operation_stale", trimSentinel(err))
		return
	case errors.Is(err, fleetops.ErrValidation):
		writeError(w, http.StatusUnprocessableEntity, "bulk_operation_invalid", trimSentinel(err))
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": operation})
}

func (s *server) undoBulkOperation(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	operation, err := s.fleet.Undo(r.Context(), user.ID, user.Role, id)
	switch {
	case errors.Is(err, fleetops.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "That operation no longer exists.")
		return
	case errors.Is(err, devices.ErrOutOfScope):
		// Same answer as reading an out-of-scope screen: a scoped operator must
		// not learn that the operation exists.
		writeError(w, http.StatusNotFound, "not_found", "That operation no longer exists.")
		return
	case errors.Is(err, fleetops.ErrNotReversible):
		writeError(w, http.StatusConflict, "not_reversible",
			"This operation cannot be undone. A command that a Player may already have collected cannot be recalled.")
		return
	case errors.Is(err, fleetops.ErrValidation):
		writeError(w, http.StatusConflict, "undo_unavailable", trimSentinel(err))
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": operation})
}

func (s *server) listBulkOperations(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	operations, err := s.fleet.Recent(r.Context(), principal.User.ID, principal.User.Role, limit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": operations})
}

// trimSentinel strips the wrapping sentinel prefix so the message shown to an
// operator reads as a sentence rather than as an error chain.
func trimSentinel(err error) string {
	message := err.Error()
	for _, prefix := range []string{
		fleetops.ErrValidation.Error() + ": ",
		fleetops.ErrStale.Error() + ": ",
	} {
		if len(message) > len(prefix) && message[:len(prefix)] == prefix {
			return message[len(prefix):]
		}
	}
	return message
}
