package httpapi

import (
	"net/http"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// principalOf returns the request's management principal. requireSession
// stores it for every authenticated browser request, so handlers behind the
// dashboard group always find one; anything else fails closed. Callers that
// need the credential itself (logout, MFA, passkeys, CSRF) read the session
// instead.
func principalOf(r *http.Request) (auth.Principal, bool) {
	return auth.PrincipalFrom(r.Context())
}
