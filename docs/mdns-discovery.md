# LAN discovery

Tilecast advertises `_tilecast._tcp.local` when `TILECAST_MDNS_ENABLED=true`. TXT records contain this information:

- Identity path
- Base URL
- API version
- Installation ID

Android Player uses the standard `NsdManager` DNS-SD APIs.

Multicast discovery is an optional aid. Network configuration can block it. Examples include VLAN boundaries, AP isolation, and multicast filters.

If discovery does not operate, enter the local server URL manually. Discovery does not downgrade HTTPS or find Cloudflare Tunnel hostnames.

Tilecast Edge uses Avahi's `org.freedesktop.Avahi.Server.ServiceBrowserNew` method. It subscribes to browser signals before it creates the browser so it can receive cached results. The Server interface works on Avahi versions before and after 0.8. [Avahi release notes](https://github.com/avahi/avahi/releases/tag/v0.8)

If the signal stream fails or ends before the browse completes, Edge reports that discovery is unavailable. A browse can also complete at its time limit and return the results it collected.

[Phone setup](phone-setup.md) is a third source of the server address. It also operates across VLANs and with Cloudflare Tunnel hostnames.
