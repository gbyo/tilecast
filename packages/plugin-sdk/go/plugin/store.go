package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"path"
	"strings"
	"unicode/utf8"
)

// Limits on first-party Plugin Store presentation metadata.
const (
	MaxStoreScreenshots      = 5
	maxStorePublisherName    = 80
	maxStoreLongDescription  = 4000
	maxStoreScreenshotAlt    = 300
	maxStoreArtworkFileBytes = 4 << 20
)

// StoreListing is the presentation metadata a bundled plugin ships for its
// Plugin Store page. It lives in tilecast.store.json beside the manifest and
// is deliberately small: it can change how a listing looks, never what the
// plugin is or does. Identity, installation, capabilities, requirements,
// trust, and Player manifests all come from tilecast.plugin.json.
type StoreListing struct {
	Publisher       StorePublisher `json:"publisher"`
	LongDescription string         `json:"longDescription,omitempty"`
	Artwork         StoreArtwork   `json:"artwork"`
}

// StorePublisher names who builds the plugin. URL is optional and must be
// an https address.
type StorePublisher struct {
	Name string `json:"name"`
	URL  string `json:"url,omitempty"`
}

// StoreArtwork lists release-owned image files by relative path.
type StoreArtwork struct {
	Icon        string            `json:"icon,omitempty"`
	Screenshots []StoreScreenshot `json:"screenshots,omitempty"`
}

// StoreScreenshot is one marketing image with the text that describes it.
type StoreScreenshot struct {
	Src string `json:"src"`
	Alt string `json:"alt"`
}

// StoreArtworkContentType answers the media type for an artwork path, or
// false when the extension is not a supported image type.
func StoreArtworkContentType(name string) (string, bool) {
	switch strings.ToLower(path.Ext(name)) {
	case ".webp":
		return "image/webp", true
	case ".png":
		return "image/png", true
	}
	return "", false
}

// ParseStoreListing strictly decodes and validates tilecast.store.json
// against the plugin's embedded files. assets is rooted at the plugin
// directory, so "./store/icon.webp" resolves to store/icon.webp.
func ParseStoreListing(data []byte, assets fs.FS) (StoreListing, error) {
	var listing StoreListing
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&listing); err != nil {
		return StoreListing{}, fmt.Errorf("store metadata: %w", err)
	}
	if decoder.More() {
		return StoreListing{}, fmt.Errorf("store metadata: unexpected trailing content")
	}
	if err := listing.validate(assets); err != nil {
		return StoreListing{}, fmt.Errorf("store metadata: %w", err)
	}
	return listing, nil
}

func (l StoreListing) validate(assets fs.FS) error {
	name := strings.TrimSpace(l.Publisher.Name)
	if name == "" || utf8.RuneCountInString(name) > maxStorePublisherName {
		return fmt.Errorf("publisher.name must be 1 to %d characters", maxStorePublisherName)
	}
	if l.Publisher.URL != "" {
		parsed, err := url.Parse(l.Publisher.URL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
			return fmt.Errorf("publisher.url must be a plain https address")
		}
	}
	if utf8.RuneCountInString(l.LongDescription) > maxStoreLongDescription {
		return fmt.Errorf("longDescription must be at most %d characters", maxStoreLongDescription)
	}
	if len(l.Artwork.Screenshots) > MaxStoreScreenshots {
		return fmt.Errorf("artwork.screenshots allows at most %d images", MaxStoreScreenshots)
	}
	if l.Artwork.Icon != "" {
		if err := checkStoreArtworkFile(assets, l.Artwork.Icon); err != nil {
			return fmt.Errorf("artwork.icon: %w", err)
		}
	}
	for index, shot := range l.Artwork.Screenshots {
		if err := checkStoreArtworkFile(assets, shot.Src); err != nil {
			return fmt.Errorf("artwork.screenshots[%d].src: %w", index, err)
		}
		alt := strings.TrimSpace(shot.Alt)
		if alt == "" || utf8.RuneCountInString(alt) > maxStoreScreenshotAlt {
			return fmt.Errorf("artwork.screenshots[%d].alt must be 1 to %d characters", index, maxStoreScreenshotAlt)
		}
	}
	return nil
}

// StoreArtworkPath resolves a declared artwork path to its location in the
// plugin's file system. Only relative paths below the plugin directory pass.
func StoreArtworkPath(declared string) (string, error) {
	cleaned := path.Clean(strings.TrimPrefix(declared, "./"))
	if declared == "" || strings.HasPrefix(declared, "/") || strings.Contains(declared, `\`) ||
		cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || !fs.ValidPath(cleaned) {
		return "", fmt.Errorf("%q must be a relative path inside the plugin", declared)
	}
	if _, ok := StoreArtworkContentType(cleaned); !ok {
		return "", fmt.Errorf("%q must be a .webp or .png image", declared)
	}
	return cleaned, nil
}

func checkStoreArtworkFile(assets fs.FS, declared string) error {
	resolved, err := StoreArtworkPath(declared)
	if err != nil {
		return err
	}
	if assets == nil {
		return fmt.Errorf("%q is declared but the plugin embeds no files", declared)
	}
	info, err := fs.Stat(assets, resolved)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("%q does not exist in the plugin", declared)
	}
	if info.Size() == 0 || info.Size() > maxStoreArtworkFileBytes {
		return fmt.Errorf("%q must be between 1 byte and %d MiB", declared, maxStoreArtworkFileBytes>>20)
	}
	return nil
}

// StoreArtworkSource is the optional contribution a plugin with Store
// presentation implements. Bundle provides it once WithStore is called.
type StoreArtworkSource interface {
	// StoreListing returns the validated listing and the plugin's file
	// system, rooted at the plugin directory. ok is false when the plugin
	// ships no store metadata.
	StoreListing() (listing StoreListing, assets fs.FS, ok bool)
}
