package fonts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The catalog is Fontsource's read-only API, which mirrors every Google
// Fonts family with its license and pinned, versioned WOFF2 files. The
// server contacts it only when an administrator browses or adds a family;
// Players and Studio never contact it, and nothing depends on it after a
// family is stored.
const (
	DefaultCatalogAPI = "https://api.fontsource.org"
	DefaultCatalogCDN = "https://cdn.jsdelivr.net/fontsource/fonts/"

	catalogListTTL      = 24 * time.Hour
	catalogDetailTTL    = time.Hour
	catalogDetailLimit  = 256
	catalogPreviewLimit = 256
	catalogListBytes    = 8 << 20
	catalogDetailBytes  = 4 << 20
	catalogPreviewBytes = 2 << 20
)

var (
	sourceIDPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,99}$`)
	subsetPattern       = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	sliceKeyPattern     = regexp.MustCompile(`^[0-9]{1,4}$`)
	versionPattern      = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,40}$`)
	unicodeRangePattern = regexp.MustCompile(`^[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(\s*,\s*[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$`)
)

// CatalogEntry is one family in the catalog listing.
type CatalogEntry struct {
	ID            string   `json:"id"`
	Family        string   `json:"family"`
	Category      string   `json:"category"`
	License       string   `json:"license"`
	Subsets       []string `json:"subsets"`
	Weights       []int    `json:"weights"`
	Styles        []string `json:"styles"`
	DefaultSubset string   `json:"defaultSubset"`
	Variable      bool     `json:"variable"`
}

// CatalogDetail adds what an import needs to choose files.
type CatalogDetail struct {
	CatalogEntry
	Version string `json:"version"`
	// WeightRange is set when the family has a variable weight axis. One
	// variable file then covers every weight for a subset and style.
	WeightRange *[2]int `json:"weightRange"`

	unicodeRanges map[string]string
	// variants[weight][style][sliceKey] = WOFF2 URL.
	variants map[string]map[string]map[string]string
}

type CatalogPage struct {
	Families []CatalogEntry `json:"families"`
	Total    int            `json:"total"`
}

type Catalog struct {
	APIBase  string
	CDNBase  string
	Client   *http.Client
	Disabled bool
	Now      func() time.Time

	mu       sync.Mutex
	list     []CatalogEntry
	listAt   time.Time
	details  map[string]cachedDetail
	previews map[string]cachedPreview
}

type cachedDetail struct {
	detail CatalogDetail
	at     time.Time
}

type cachedPreview struct {
	data []byte
	at   time.Time
}

func NewCatalog(disabled bool) *Catalog {
	return &Catalog{
		APIBase:  DefaultCatalogAPI,
		CDNBase:  DefaultCatalogCDN,
		Client:   &http.Client{Timeout: 30 * time.Second},
		Disabled: disabled,
	}
}

func (c *Catalog) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Catalog) ready() error {
	if c == nil || c.Disabled {
		return ErrCatalogDisabled
	}
	return nil
}

type fontsourceListEntry struct {
	ID        string   `json:"id"`
	Family    string   `json:"family"`
	Subsets   []string `json:"subsets"`
	Weights   []int    `json:"weights"`
	Styles    []string `json:"styles"`
	DefSubset string   `json:"defSubset"`
	Variable  bool     `json:"variable"`
	Category  string   `json:"category"`
	License   string   `json:"license"`
	Type      string   `json:"type"`
}

type fontsourceDetail struct {
	fontsourceListEntry
	NPMVersion   string            `json:"npmVersion"`
	UnicodeRange map[string]string `json:"unicodeRange"`
	Variants     map[string]map[string]map[string]struct {
		URL map[string]string `json:"url"`
	} `json:"variants"`
}

type fontsourceVariable struct {
	Axes map[string]struct {
		Min string `json:"min"`
		Max string `json:"max"`
	} `json:"axes"`
}

func (e fontsourceListEntry) entry() CatalogEntry {
	return CatalogEntry{
		ID:            e.ID,
		Family:        e.Family,
		Category:      e.Category,
		License:       e.License,
		Subsets:       nonNil(e.Subsets),
		Weights:       nonNilInts(e.Weights),
		Styles:        nonNil(e.Styles),
		DefaultSubset: e.DefSubset,
		Variable:      e.Variable,
	}
}

func (e fontsourceListEntry) valid() bool {
	return e.Type == "google" && sourceIDPattern.MatchString(e.ID) && strings.TrimSpace(e.Family) != "" && len(e.Family) <= MaxFamilyNameLength && knownCategory(e.Category)
}

func knownCategory(category string) bool {
	switch category {
	case "sans-serif", "serif", "display", "handwriting", "monospace", "icons":
		return true
	}
	return false
}

// Search filters the cached listing. Matching is a case-insensitive
// substring of the family name.
func (c *Catalog) Search(ctx context.Context, query, category string, limit, offset int) (CatalogPage, error) {
	list, err := c.listing(ctx)
	if err != nil {
		return CatalogPage{}, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	matches := make([]CatalogEntry, 0, len(list))
	for _, entry := range list {
		if category != "" && entry.Category != category {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(entry.Family), query) {
			continue
		}
		matches = append(matches, entry)
	}
	if limit <= 0 || limit > 100 {
		limit = 48
	}
	if offset < 0 {
		offset = 0
	}
	page := CatalogPage{Families: []CatalogEntry{}, Total: len(matches)}
	if offset < len(matches) {
		end := min(offset+limit, len(matches))
		page.Families = matches[offset:end]
	}
	return page, nil
}

func (c *Catalog) listing(ctx context.Context) ([]CatalogEntry, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.list != nil && c.now().Sub(c.listAt) < catalogListTTL {
		list := c.list
		c.mu.Unlock()
		return list, nil
	}
	c.mu.Unlock()
	var raw []fontsourceListEntry
	if err := c.fetchJSON(ctx, strings.TrimRight(c.APIBase, "/")+"/v1/fonts?type=google", catalogListBytes, &raw); err != nil {
		return nil, err
	}
	list := make([]CatalogEntry, 0, len(raw))
	for _, entry := range raw {
		if entry.valid() {
			list = append(list, entry.entry())
		}
	}
	sort.Slice(list, func(i, j int) bool { return strings.ToLower(list[i].Family) < strings.ToLower(list[j].Family) })
	c.mu.Lock()
	c.list, c.listAt = list, c.now()
	c.mu.Unlock()
	return list, nil
}

// Detail reads one family, including its variable weight axis when present.
func (c *Catalog) Detail(ctx context.Context, id string) (CatalogDetail, error) {
	if err := c.ready(); err != nil {
		return CatalogDetail{}, err
	}
	if !sourceIDPattern.MatchString(id) {
		return CatalogDetail{}, ErrNotFound
	}
	c.mu.Lock()
	if cached, ok := c.details[id]; ok && c.now().Sub(cached.at) < catalogDetailTTL {
		c.mu.Unlock()
		return cached.detail, nil
	}
	c.mu.Unlock()
	base := strings.TrimRight(c.APIBase, "/")
	var raw fontsourceDetail
	if err := c.fetchJSON(ctx, base+"/v1/fonts/"+id, catalogDetailBytes, &raw); err != nil {
		return CatalogDetail{}, err
	}
	if raw.ID != id || !raw.valid() || !versionPattern.MatchString(raw.NPMVersion) {
		return CatalogDetail{}, ErrNotFound
	}
	detail := CatalogDetail{
		CatalogEntry:  raw.entry(),
		Version:       raw.NPMVersion,
		unicodeRanges: map[string]string{},
		variants:      map[string]map[string]map[string]string{},
	}
	for key, value := range raw.UnicodeRange {
		detail.unicodeRanges[key] = value
	}
	for weight, styles := range raw.Variants {
		for style, slices := range styles {
			for key, urls := range slices {
				if detail.variants[weight] == nil {
					detail.variants[weight] = map[string]map[string]string{}
				}
				if detail.variants[weight][style] == nil {
					detail.variants[weight][style] = map[string]string{}
				}
				detail.variants[weight][style][key] = urls.URL["woff2"]
			}
		}
	}
	if raw.Variable {
		var variable fontsourceVariable
		if err := c.fetchJSON(ctx, base+"/v1/variable/"+id, catalogDetailBytes, &variable); err == nil {
			if axis, ok := variable.Axes["wght"]; ok {
				low, lowErr := strconv.ParseFloat(axis.Min, 64)
				high, highErr := strconv.ParseFloat(axis.Max, 64)
				if lowErr == nil && highErr == nil && low >= 1 && high <= 1000 && low <= high {
					detail.WeightRange = &[2]int{int(low), int(high)}
				}
			}
		} else if !errors.Is(err, ErrNotFound) {
			return CatalogDetail{}, err
		}
	}
	c.mu.Lock()
	if c.details == nil {
		c.details = map[string]cachedDetail{}
	}
	if len(c.details) >= catalogDetailLimit {
		c.details = map[string]cachedDetail{}
	}
	c.details[id] = cachedDetail{detail: detail, at: c.now()}
	c.mu.Unlock()
	return detail, nil
}

// Preview returns one small static file, the regular face of the default
// subset, so Studio can show a family's name in its own type while an
// administrator browses.
func (c *Catalog) Preview(ctx context.Context, id string) ([]byte, error) {
	detail, err := c.Detail(ctx, id)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if cached, ok := c.previews[id]; ok && c.now().Sub(cached.at) < catalogDetailTTL {
		c.mu.Unlock()
		return cached.data, nil
	}
	c.mu.Unlock()
	url := ""
	weight := strconv.Itoa(nearestWeight(detail.Weights, 400))
	for _, style := range []string{"normal", "italic"} {
		slices := detail.variants[weight][style]
		if candidate := slices[detail.DefaultSubset]; candidate != "" {
			url = candidate
			break
		}
		keys := sortedSliceKeys(slices)
		if len(keys) > 0 {
			url = slices[keys[0]]
			break
		}
	}
	if url == "" {
		return nil, ErrNotFound
	}
	data, err := c.download(ctx, url, catalogPreviewBytes)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.previews == nil {
		c.previews = map[string]cachedPreview{}
	}
	if len(c.previews) >= catalogPreviewLimit {
		c.previews = map[string]cachedPreview{}
	}
	c.previews[id] = cachedPreview{data: data, at: c.now()}
	c.mu.Unlock()
	return data, nil
}

func (c *Catalog) fetchJSON(ctx context.Context, url string, limit int64, target any) error {
	body, err := c.get(ctx, url, limit)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("%w: invalid catalog response", ErrCatalogUnavailable)
	}
	return nil
}

// download fetches one file from the fixed CDN prefix only, so catalog
// data can never steer the server to another host.
func (c *Catalog) download(ctx context.Context, url string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(url, c.CDNBase) || strings.ContainsAny(url[len(c.CDNBase):], "?#\\") || strings.Contains(url, "..") {
		return nil, fmt.Errorf("%w: unexpected file location", ErrCatalogUnavailable)
	}
	data, err := c.get(ctx, url, limit)
	if err != nil {
		return nil, err
	}
	if len(data) < 4 || string(data[:4]) != "wOF2" {
		return nil, fmt.Errorf("%w: the catalog returned a file that is not WOFF2", ErrCatalogUnavailable)
	}
	return data, nil
}

// checkRedirect holds every redirect hop to the same origins as the first
// request, so a response can never send the server to another host.
func (c *Catalog) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 3 {
		return errors.New("too many redirects")
	}
	target := req.URL.String()
	if strings.HasPrefix(target, c.CDNBase) || strings.HasPrefix(target, strings.TrimRight(c.APIBase, "/")+"/") {
		return nil
	}
	return errors.New("redirect to an unexpected location")
}

func (c *Catalog) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "Tilecast-Server")
	request.Header.Set("Accept", "application/json, font/woff2")
	base := http.DefaultClient
	if c.Client != nil {
		base = c.Client
	}
	// A copy, so a caller-supplied client is not changed.
	client := *base
	client.CheckRedirect = c.checkRedirect
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCatalogUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: catalog responded %d", ErrCatalogUnavailable, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCatalogUnavailable, err)
	}
	if int64(len(data)) > limit {
		return nil, ErrTooLarge
	}
	return data, nil
}

// plannedFile is one file a Google import downloads.
type plannedFile struct {
	URL          string
	Subset       string
	Style        string
	WeightMin    int
	WeightMax    int
	UnicodeRange string
}

// planGoogleImport turns a selection into the exact file list. It is pure,
// so the selection rules are tested without the network.
func planGoogleImport(detail CatalogDetail, cdnBase string, request GoogleImport) ([]plannedFile, []string, error) {
	subsets := uniqueStrings(request.Subsets)
	if len(subsets) == 0 {
		subsets = []string{detail.DefaultSubset}
	}
	styles := uniqueStrings(request.Styles)
	if len(styles) == 0 {
		styles = []string{"normal"}
	}
	for _, subset := range subsets {
		if !subsetPattern.MatchString(subset) || !contains(detail.Subsets, subset) {
			return nil, nil, fmt.Errorf("%w: subset %q is not available", ErrInvalid, subset)
		}
	}
	for _, style := range styles {
		if (style != "normal" && style != "italic") || !contains(detail.Styles, style) {
			return nil, nil, fmt.Errorf("%w: style %q is not available", ErrInvalid, style)
		}
	}
	type weightRange struct{ low, high int }
	weights := []weightRange{}
	variable := detail.WeightRange != nil
	if variable {
		weights = append(weights, weightRange{detail.WeightRange[0], detail.WeightRange[1]})
	} else {
		requested := uniqueInts(request.Weights)
		if len(requested) == 0 {
			requested = []int{nearestWeight(detail.Weights, 400)}
		}
		for _, weight := range requested {
			if !containsInt(detail.Weights, weight) {
				return nil, nil, fmt.Errorf("%w: weight %d is not available", ErrInvalid, weight)
			}
			weights = append(weights, weightRange{weight, weight})
		}
	}
	files := []plannedFile{}
	for _, style := range styles {
		for _, weight := range weights {
			sample := detail.variants[strconv.Itoa(weight.low)][style]
			if variable {
				sample = anyStyleSlices(detail, style)
			}
			for _, subset := range subsets {
				keys := sliceKeys(detail, sample, subset)
				if len(keys) == 0 {
					return nil, nil, fmt.Errorf("%w: subset %q has no files for this style", ErrInvalid, subset)
				}
				for _, key := range keys {
					file := plannedFile{Subset: subset, Style: style, WeightMin: weight.low, WeightMax: weight.high}
					if variable {
						file.URL = cdnBase + detail.ID + ":vf@" + detail.Version + "/" + key + "-wght-" + style + ".woff2"
					} else {
						file.URL = sample[key]
					}
					if file.URL == "" || !strings.HasPrefix(file.URL, cdnBase) {
						return nil, nil, fmt.Errorf("%w: the catalog has no file for %s %s", ErrCatalogUnavailable, subset, style)
					}
					rangeKey := key
					if sliceKeyPattern.MatchString(key) {
						rangeKey = "[" + key + "]"
					}
					file.UnicodeRange = strings.TrimSpace(detail.unicodeRanges[rangeKey])
					if file.UnicodeRange != "" && !unicodeRangePattern.MatchString(file.UnicodeRange) {
						return nil, nil, fmt.Errorf("%w: invalid character range", ErrCatalogUnavailable)
					}
					files = append(files, file)
				}
			}
		}
	}
	if len(files) > MaxImportFiles {
		return nil, nil, fmt.Errorf("%w: choose fewer subsets, styles, or weights", ErrTooLarge)
	}
	return files, subsets, nil
}

// sliceKeys maps one subset to its file keys. Most subsets are one file
// named after the subset. Large scripts (Japanese, Korean, Chinese) are cut
// into numbered slices, which all belong to the one subset that is not a
// file name itself.
func sliceKeys(detail CatalogDetail, slices map[string]string, subset string) []string {
	if _, ok := slices[subset]; ok {
		return []string{subset}
	}
	keys := []string{}
	for _, key := range sortedSliceKeys(slices) {
		if sliceKeyPattern.MatchString(key) {
			keys = append(keys, key)
		}
	}
	return keys
}

func anyStyleSlices(detail CatalogDetail, style string) map[string]string {
	weights := make([]string, 0, len(detail.variants))
	for weight := range detail.variants {
		weights = append(weights, weight)
	}
	sort.Strings(weights)
	for _, weight := range weights {
		if slices := detail.variants[weight][style]; len(slices) > 0 {
			return slices
		}
	}
	return nil
}

func sortedSliceKeys(slices map[string]string) []string {
	keys := make([]string, 0, len(slices))
	for key := range slices {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, aErr := strconv.Atoi(keys[i])
		b, bErr := strconv.Atoi(keys[j])
		if aErr == nil && bErr == nil {
			return a < b
		}
		return keys[i] < keys[j]
	})
	return keys
}

func nearestWeight(weights []int, target int) int {
	if len(weights) == 0 {
		return target
	}
	best := weights[0]
	for _, weight := range weights[1:] {
		if abs(weight-target) < abs(best-target) {
			best = weight
		}
	}
	return best
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func uniqueInts(values []int) []int {
	seen := map[int]bool{}
	result := []int{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nonNilInts(values []int) []int {
	if values == nil {
		return []int{}
	}
	return values
}
