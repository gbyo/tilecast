package web

import (
	"bytes"
	"embed"
	"encoding/json"
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

const playerSlotID = `[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}`

var (
	playerSlotPath     = regexp.MustCompile(`^/player/(` + playerSlotID + `)/?$`)
	playerSlotManifest = regexp.MustCompile(`^/player/(` + playerSlotID + `)/manifest\.webmanifest$`)
)

// The generic shell links the unmanaged Player's install manifest. A managed
// slot links its own, so an installed Browser Player reopens that same Screen.
const playerGenericManifestLink = `href="/player/manifest.webmanifest"`

// SlotManifest is the install manifest for one managed Browser Player. Its
// identity, scope and start URL are the stable, non-secret slot route. A
// recovery capability is never part of it.
func SlotManifest(slot string) ([]byte, error) {
	route := "/player/" + slot + "/"
	icons := []map[string]string{}
	for _, size := range []string{"192", "512"} {
		icons = append(icons, map[string]string{"src": "/player/icons/player-" + size + ".png", "sizes": size + "x" + size, "type": "image/png"})
	}
	return json.Marshal(map[string]any{
		"id": route, "name": "Tilecast Browser Player", "short_name": "Tilecast Player",
		"start_url": route, "scope": route, "display": "fullscreen",
		"background_color": "#111827", "theme_color": "#111827", "icons": icons,
	})
}

// ShellForSlot points a shell document at its slot's install manifest.
func ShellForSlot(shell []byte, slot string) []byte {
	return bytes.Replace(shell, []byte(playerGenericManifestLink), []byte(`href="/player/`+slot+`/manifest.webmanifest"`), 1)
}

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
		slot := ""
		if match := playerSlotManifest.FindStringSubmatch(r.URL.Path); match != nil {
			manifest, err := SlotManifest(match[1])
			if err != nil {
				http.Error(w, "Manifest unavailable", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/manifest+json")
			_, _ = w.Write(manifest)
			return
		}
		if match := playerSlotPath.FindStringSubmatch(r.URL.Path); match != nil {
			slot = match[1]
		}
		if r.URL.Path == "/player" || r.URL.Path == "/player/" || slot != "" {
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
		if slot != "" {
			shell, err := fs.ReadFile(static, name)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(ShellForSlot(shell, slot))
			return
		}
		http.ServeFileFS(w, r, static, name)
	})
}
