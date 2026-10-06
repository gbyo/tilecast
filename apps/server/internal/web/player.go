package web

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strings"
)

// Browser Player is built independently of Studio and embeds the unchanged
// production Player Runtime. Build output replaces this development fallback.
//
//go:embed player-static
var playerFiles embed.FS

var playerSlotPath = regexp.MustCompile(`^/player/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/?$`)

const playerCSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src https:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'"

func PlayerHandler() http.Handler {
	static, _ := fs.Sub(playerFiles, "player-static")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", playerCSP)
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), display-capture=(), geolocation=(), fullscreen=(self), screen-wake-lock=(self), autoplay=(self)")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != path.Clean(r.URL.Path) && !strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/player/")
		if r.URL.Path == "/player" || r.URL.Path == "/player/" || playerSlotPath.MatchString(r.URL.Path) {
			name = "index.html"
		} else if !strings.HasPrefix(r.URL.Path, "/player/") || strings.HasPrefix(name, "media/") {
			http.NotFound(w, r)
			return
		}
		if name == "service-worker.js" {
			w.Header().Set("Service-Worker-Allowed", "/player")
		} else if strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "runtime/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		info, err := fs.Stat(static, name)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		http.ServeFileFS(w, r, static, name)
	})
}
