package web

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// Production builds replace static/index.html and add static/assets before compiling.
//
//go:embed static
var files embed.FS

func Handler() http.Handler {
	static, _ := fs.Sub(files, "static")
	return staticHandler(static)
}

func staticHandler(static fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The entry document must be revalidated after an upgrade. Only hashed
		// build assets are safe to reuse indefinitely.
		w.Header().Set("Cache-Control", "no-cache")
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		if info, err := fs.Stat(static, name); err == nil && !info.IsDir() {
			if strings.HasPrefix(name, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
				w.Header().Set("Content-Type", contentType)
			}
			http.ServeFileFS(w, r, static, name)
			return
		}
		// A missing hashed build file must 404 instead of returning HTML, but
		// the bare /assets path is the Studio Media route and needs the SPA.
		if strings.HasPrefix(name, "assets/") {
			http.NotFound(w, r)
			return
		}
		r.URL.Path = "/"
		http.ServeFileFS(w, r, static, "index.html")
	})
}
