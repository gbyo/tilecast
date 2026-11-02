# LAN discovery

Tilecast advertises `_tilecast._tcp.local` when `TILECAST_MDNS_ENABLED=true`. TXT records contain this information:

- Identity path
- Base URL
- API version
- Installation ID

Android Player uses the standard `NsdManager` DNS-SD APIs.

Multicast discovery is an optional aid. Network configuration can block it. Examples include VLAN boundaries, AP isolation, and multicast filters.

If discovery does not operate, enter the local server URL manually. Discovery does not downgrade HTTPS or find Cloudflare Tunnel hostnames.

[Phone setup](phone-setup.md) is a third source of the server address. It also operates across VLANs and with Cloudflare Tunnel hostnames.
