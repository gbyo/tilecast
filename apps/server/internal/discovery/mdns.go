package discovery

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/grandcat/zeroconf"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

type Server struct{ server *zeroconf.Server }

func Advertise(identity devices.Identity, publicURL string) (*Server, error) {
	port, err := advertisedPort(publicURL)
	if err != nil {
		return nil, err
	}
	instance := strings.TrimSpace("Tilecast - " + identity.OrganizationName)
	server, err := zeroconf.Register(instance, "_tilecast._tcp", "local.", port, []string{
		"path=/api/v1/system/identity",
		"base-url=" + strings.TrimRight(publicURL, "/"),
		"installation-id=" + identity.InstallationID,
		"api-version=v1",
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("advertise Tilecast with mDNS: %w", err)
	}
	return &Server{server: server}, nil
}

func advertisedPort(publicURL string) (int, error) {
	parsed, err := url.Parse(publicURL)
	if err != nil || parsed.Hostname() == "" {
		return 0, fmt.Errorf("mDNS requires a valid TILECAST_PUBLIC_URL")
	}

	var port int
	switch parsed.Scheme {
	case "http":
		port = 80
	case "https":
		port = 443
	default:
		return 0, fmt.Errorf("mDNS requires TILECAST_PUBLIC_URL to use http or https")
	}

	if parsed.Port() != "" {
		port, err = strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65535 {
			return 0, fmt.Errorf("mDNS requires TILECAST_PUBLIC_URL to use a valid TCP port")
		}
	}
	return port, nil
}

func (s *Server) Shutdown() {
	if s != nil && s.server != nil {
		s.server.Shutdown()
	}
}
