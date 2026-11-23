package outbound

import "net/netip"

// AddressClass is what the engine decides about one resolved address.
type AddressClass int

const (
	// ClassPublic is a globally routed unicast address.
	ClassPublic AddressClass = iota + 1
	// ClassPrivate is an RFC 1918 IPv4 address or an IPv6 unique local
	// address. A connection reaches it only with private network consent.
	ClassPrivate
	// ClassForbidden is never reached through a plugin connection:
	// loopback, link-local (which holds cloud metadata addresses),
	// unspecified, multicast, broadcast, and special-use space.
	ClassForbidden
)

func (c AddressClass) String() string {
	switch c {
	case ClassPublic:
		return "public"
	case ClassPrivate:
		return "private"
	default:
		return "forbidden"
	}
}

var privatePrefixes = mustPrefixes(
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"fc00::/7",
)

// forbiddenPrefixes are special-use ranges the standard library predicates
// do not cover. Ranges that embed or translate an IPv4 address (NAT64,
// 6to4, Teredo, IPv4-compatible) are refused because the embedded address
// could be local.
var forbiddenPrefixes = mustPrefixes(
	"0.0.0.0/8",       // "this network"
	"100.64.0.0/10",   // carrier-grade NAT
	"169.254.0.0/16",  // link-local, cloud metadata
	"192.0.0.0/24",    // IETF protocol assignments
	"192.0.2.0/24",    // documentation
	"192.88.99.0/24",  // 6to4 relay anycast
	"198.18.0.0/15",   // benchmarking
	"198.51.100.0/24", // documentation
	"203.0.113.0/24",  // documentation
	"224.0.0.0/4",     // multicast
	"240.0.0.0/4",     // reserved, and the limited broadcast address
	"::/96",           // IPv4-compatible (deprecated)
	"64:ff9b::/96",    // NAT64
	"64:ff9b:1::/48",  // local NAT64
	"100::/64",        // discard
	"2001::/32",       // Teredo
	"2001:2::/48",     // benchmarking
	"2001:db8::/32",   // documentation
	"2002::/16",       // 6to4
	"fe80::/10",       // link-local
	"fec0::/10",       // site-local (deprecated)
	"ff00::/8",        // multicast
)

func mustPrefixes(values ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		out = append(out, netip.MustParsePrefix(value))
	}
	return out
}

// Classify decides one address. An IPv4-mapped IPv6 address is classified
// as the IPv4 address it carries.
func Classify(address netip.Addr) AddressClass {
	address = address.Unmap().WithZone("")
	if !address.IsValid() || address.IsUnspecified() || address.IsLoopback() ||
		address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsInterfaceLocalMulticast() || address.IsMulticast() {
		return ClassForbidden
	}
	for _, prefix := range forbiddenPrefixes {
		if prefix.Contains(address) {
			return ClassForbidden
		}
	}
	for _, prefix := range privatePrefixes {
		if prefix.Contains(address) {
			return ClassPrivate
		}
	}
	if !address.IsGlobalUnicast() {
		return ClassForbidden
	}
	return ClassPublic
}

// checkAddresses applies the policy to a complete resolution answer. A
// mixed answer fails as a whole: the engine never picks a convenient
// address out of an answer that also names a refused one, because the
// answer comes from a resolver an attacker may control.
func checkAddresses(addresses []netip.Addr, policy addressPolicy) ([]netip.Addr, *Failure) {
	if len(addresses) == 0 {
		return nil, failure(CodeDNSFailed, nil)
	}
	out := make([]netip.Addr, 0, len(addresses))
	for _, address := range addresses {
		address = address.Unmap().WithZone("")
		switch Classify(address) {
		case ClassForbidden:
			return nil, failure(CodeDNSAddressRefused, nil)
		case ClassPrivate:
			if !policy.privateNetwork {
				return nil, failure(CodePrivateNetworkRefused, nil)
			}
		case ClassPublic:
			if policy.plainHTTP {
				// Plain HTTP stays on the local network.
				return nil, failure(CodePlainHTTPRefused, nil)
			}
		}
		out = append(out, address)
	}
	return out, nil
}

type addressPolicy struct {
	privateNetwork bool
	// plainHTTP is set for a plain HTTP dial: every address must be
	// private.
	plainHTTP bool
}
