package contentdefs

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

var googleDocumentID = regexp.MustCompile(`^[A-Za-z0-9_-]{12,200}$`)
var googleSheetGID = regexp.MustCompile(`^[0-9]{1,20}$`)
var googleSheetRange = regexp.MustCompile(`^[A-Za-z0-9_ '!.:$-]{1,120}$`)

// WebPresentationURL validates and canonicalizes one release-defined Web Integration.
// Every transform is compiled into Tilecast; catalog JSON cannot provide code or regexes.
func WebPresentationURL(definition WidgetDefinition, configuration map[string]any) (string, []string, error) {
	spec := definition.WebIntegration
	if spec == nil {
		return "", nil, errors.New("web integration descriptor is missing")
	}
	raw, _ := configuration[spec.URLField].(string)
	if spec.Transform == "canva_embed" {
		parsed, err := CanvaURL(raw)
		if err != nil {
			return "", nil, err
		}
		if parsed.Host == "canva.link" {
			return "", nil, errors.New("Canva short link must be resolved before playback; save the Widget again")
		}
		return parsed.String(), []string{"www.canva.com"}, nil
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || len(raw) > 2048 {
		return "", nil, errors.New("integration URL must be an HTTPS URL")
	}
	host := canonicalHTTPSHost(parsed.Hostname())
	if spec.AllowAnyHTTPSHost {
		// Open-host definitions are reserved for integrations such as self-hosted Grafana where
		// a fixed release allowlist is impossible. They still require the author to approve the
		// exact hostname explicitly instead of turning a branded App into an unrestricted Website.
		trustedHost, trustErr := trustedHTTPSHost(configuration["trustedHost"])
		if trustErr != nil {
			return "", nil, trustErr
		}
		if trustedHost != host {
			return "", nil, errors.New("integration URL must use the explicitly trusted host")
		}
	} else if !containsHost(spec.AllowedHosts, host) {
		return "", nil, fmt.Errorf("integration URL must use %s", strings.Join(spec.AllowedHosts, " or "))
	}
	if spec.RequiredPathPrefix != "" && !strings.HasPrefix(parsed.EscapedPath(), spec.RequiredPathPrefix) {
		return "", nil, errors.New("integration URL does not match the provider's supported public or embed URL")
	}
	fragment := parsed.Fragment
	parsed.Fragment = ""
	switch spec.Transform {
	case "passthrough":
	case "google_sheets":
		gid := strings.TrimSpace(stringConfig(configuration["sheetGid"]))
		if gid == "" {
			gid = parsed.Query().Get("gid")
		}
		if gid == "" && strings.HasPrefix(fragment, "gid=") {
			gid = strings.TrimPrefix(fragment, "gid=")
		}
		if gid != "" && !googleSheetGID.MatchString(gid) {
			return "", nil, errors.New("Google Sheets tab ID must contain digits only")
		}
		sheetRange := strings.TrimSpace(stringConfig(configuration["sheetRange"]))
		if sheetRange != "" && !googleSheetRange.MatchString(sheetRange) {
			return "", nil, errors.New("Google Sheets range contains unsupported characters")
		}
		id, published, extractErr := googleResourceID(parsed.Path, "spreadsheets")
		if extractErr != nil {
			return "", nil, errors.New("Google Sheets URL is not a supported shared or published spreadsheet URL")
		}
		if published {
			parsed.Path = "/spreadsheets/d/e/" + id + "/pubhtml"
		} else {
			parsed.Path = "/spreadsheets/d/" + id + "/preview"
		}
		query := url.Values{}
		query.Set("widget", boolQuery(configuration["showTabs"], true))
		query.Set("headers", boolQuery(configuration["showHeaders"], false))
		if gid != "" {
			query.Set("gid", gid)
		}
		if sheetRange != "" {
			query.Set("range", sheetRange)
		}
		parsed.RawQuery = query.Encode()
	case "google_slides":
		id, published, extractErr := googleResourceID(parsed.Path, "presentation")
		if extractErr != nil {
			return "", nil, errors.New("Google Slides URL is not a supported shared or published presentation URL")
		}
		if published {
			parsed.Path = "/presentation/d/e/" + id + "/embed"
		} else {
			parsed.Path = "/presentation/d/" + id + "/embed"
		}
		query := url.Values{}
		query.Set("start", boolQuery(configuration["autoAdvance"], true))
		query.Set("loop", boolQuery(configuration["loop"], true))
		if seconds, ok := integerConfig(configuration["slideDurationSeconds"]); ok {
			query.Set("delayms", fmt.Sprint(seconds*1000))
		}
		parsed.RawQuery = query.Encode()
	default:
		return "", nil, errors.New("web integration transform is unsupported")
	}
	hosts := append([]string(nil), spec.AllowedHosts...)
	if spec.AllowAnyHTTPSHost {
		hosts = []string{host}
	}
	return parsed.String(), hosts, nil
}

func trustedHTTPSHost(value any) (string, error) {
	raw := strings.TrimSpace(stringConfig(value))
	if raw == "" {
		return "", errors.New("integration requires an explicitly trusted HTTPS host")
	}
	candidate := strings.Trim(raw, "[]")
	if ip := net.ParseIP(candidate); ip != nil {
		return ip.String(), nil
	}
	candidate = strings.ToLower(strings.TrimSuffix(candidate, "."))
	if candidate == "" || len(candidate) > 253 || strings.ContainsAny(candidate, "/:@?#") || strings.Contains(candidate, "..") {
		return "", errors.New("trusted host must be a hostname or IP address, without a scheme, path, or port")
	}
	for _, label := range strings.Split(candidate, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errors.New("trusted host must be a valid hostname or IP address")
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return "", errors.New("trusted host must be a valid hostname or IP address")
			}
		}
	}
	return candidate, nil
}

func canonicalHTTPSHost(host string) string {
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return ip.String()
	}
	return strings.ToLower(strings.TrimSuffix(host, "."))
}

func stringConfig(value any) string {
	text, _ := value.(string)
	return text
}

func containsHost(hosts []string, wanted string) bool {
	for _, host := range hosts {
		if canonicalHTTPSHost(host) == wanted {
			return true
		}
	}
	return false
}

func googleResourceID(path, resource string) (string, bool, error) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 3 || parts[0] != resource || parts[1] != "d" {
		return "", false, errors.New("path does not contain a document id")
	}
	published := parts[2] == "e"
	index := 2
	if published {
		index = 3
	}
	if index >= len(parts) || !googleDocumentID.MatchString(parts[index]) {
		return "", false, errors.New("document id is invalid")
	}
	return parts[index], published, nil
}

func boolQuery(value any, fallback bool) string {
	boolean, ok := value.(bool)
	if !ok {
		boolean = fallback
	}
	if boolean {
		return "true"
	}
	return "false"
}

func integerConfig(value any) (int, bool) {
	switch number := value.(type) {
	case int:
		return number, true
	case float64:
		return int(number), number == float64(int(number))
	default:
		return 0, false
	}
}
