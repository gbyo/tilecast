package plugins

// Presentation for release-owned store entries. An included plugin may ship
// a tilecast.store.json and image files next to its manifest. They are
// trusted release assets: the server reads them from the binary and serves
// them directly, never through the marketplace artwork fetcher. Presentation
// never feeds back into identity, installation, capabilities, or trust.

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"strconv"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// DefaultIncludedPublisher names the publisher of an included plugin whose
// listing declares none. Included plugins are built by the Tilecast release.
const DefaultIncludedPublisher = "Tilecast"

// IncludedListing is the presentation of one included store entry. Artwork
// holds Tilecast server paths, never filesystem paths.
type IncludedListing struct {
	PublisherName   string        `json:"publisherName"`
	PublisherURL    string        `json:"publisherUrl,omitempty"`
	LongDescription string        `json:"longDescription,omitempty"`
	Artwork         *StoreArtwork `json:"artwork,omitempty"`
}

// IncludedArtwork is one release-owned image the server may serve.
type IncludedArtwork struct {
	Body        []byte
	ContentType string
	ETag        string
}

// includedPresentation is the loaded presentation of one hosted plugin.
type includedPresentation struct {
	listing     IncludedListing
	icon        *IncludedArtwork
	screenshots []IncludedArtwork
}

// loadIncludedPresentation reads a plugin's store metadata and images once.
// A plugin without metadata still gets the default publisher. Files were
// already checked by the SDK, so a read failure here is a release defect.
func loadIncludedPresentation(p plugin.Plugin, id string) includedPresentation {
	presentation := includedPresentation{listing: IncludedListing{PublisherName: DefaultIncludedPublisher}}
	source, ok := p.(plugin.StoreArtworkSource)
	if !ok {
		return presentation
	}
	declared, assets, ok := source.StoreListing()
	if !ok {
		return presentation
	}
	presentation.listing.PublisherName = declared.Publisher.Name
	presentation.listing.PublisherURL = declared.Publisher.URL
	presentation.listing.LongDescription = declared.LongDescription

	artwork := &StoreArtwork{}
	if declared.Artwork.Icon != "" {
		image := mustReadArtwork(assets, id, declared.Artwork.Icon)
		presentation.icon = &image
		artwork.IconURL = includedArtworkPath(id, "icon", image)
	}
	for index, shot := range declared.Artwork.Screenshots {
		image := mustReadArtwork(assets, id, shot.Src)
		presentation.screenshots = append(presentation.screenshots, image)
		artwork.Screenshots = append(artwork.Screenshots, StoreScreenshot{
			URL: includedArtworkPath(id, "screenshots/"+strconv.Itoa(index), image),
			Alt: shot.Alt,
		})
	}
	if artwork.IconURL != "" || len(artwork.Screenshots) > 0 {
		presentation.listing.Artwork = artwork
	}
	return presentation
}

func mustReadArtwork(assets fs.FS, id, declared string) IncludedArtwork {
	resolved, err := plugin.StoreArtworkPath(declared)
	if err != nil {
		panic("plugin " + id + ": " + err.Error())
	}
	body, err := fs.ReadFile(assets, resolved)
	if err != nil {
		panic("plugin " + id + ": " + err.Error())
	}
	contentType, _ := plugin.StoreArtworkContentType(resolved)
	sum := sha256.Sum256(body)
	return IncludedArtwork{Body: body, ContentType: contentType, ETag: `"` + hex.EncodeToString(sum[:8]) + `"`}
}

// includedArtworkPath is the server path that serves one image. The version
// token is the content hash, so replacing an image defeats browser caches.
func includedArtworkPath(id, slot string, image IncludedArtwork) string {
	return "/api/v1/plugin-store/" + id + "/artwork/" + slot + "?v=" + image.ETag[1:13]
}

// IncludedIcon returns an included plugin's icon. known reports whether id
// names an included plugin at all, so callers can fall through to other
// sources only for other IDs; ok reports whether that plugin has an icon.
func (s *Service) IncludedIcon(id string) (artwork IncludedArtwork, known, ok bool) {
	for _, hosted := range s.hosted {
		if hosted.manifest.ID != id {
			continue
		}
		if hosted.presentation.icon == nil {
			return IncludedArtwork{}, true, false
		}
		return *hosted.presentation.icon, true, true
	}
	return IncludedArtwork{}, false, false
}

// IncludedScreenshot returns one screenshot of an included plugin.
func (s *Service) IncludedScreenshot(id string, index int) (artwork IncludedArtwork, known, ok bool) {
	for _, hosted := range s.hosted {
		if hosted.manifest.ID != id {
			continue
		}
		if index < 0 || index >= len(hosted.presentation.screenshots) {
			return IncludedArtwork{}, true, false
		}
		return hosted.presentation.screenshots[index], true, true
	}
	return IncludedArtwork{}, false, false
}
