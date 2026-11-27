package outbound

import "errors"

// Stable failure codes. Plugin code, Studio, and diagnostics see only these
// codes and their fixed messages. A resolver, socket, or TLS error stays in
// Failure.Cause for the Server's own tests and is never returned to plugin
// code or written to a log.
const (
	CodeRequestInvalid         = "request_invalid"
	CodeOriginNotAllowed       = "origin_not_allowed"
	CodePrivateNetworkRefused  = "private_network_refused"
	CodePlainHTTPRefused       = "plain_http_refused"
	CodePlaintextSecretRefused = "plaintext_secret_refused"
	CodeDNSFailed              = "dns_failed"
	CodeDNSAddressRefused      = "dns_address_refused"
	CodeConnectFailed          = "connect_failed"
	CodeTLSFailed              = "tls_failed"
	CodeRedirectRefused        = "redirect_refused"
	CodeTimeout                = "timeout"
	CodeResponseTooLarge       = "response_too_large"
	CodeConnectionUnavailable  = "connection_unavailable"
	CodeRequestFailed          = "request_failed"
)

var messages = map[string]string{
	CodeRequestInvalid:         "The request is not valid for this connection.",
	CodeOriginNotAllowed:       "The address is not an approved origin of this connection.",
	CodePrivateNetworkRefused:  "The host resolves to a private address, and this connection may not reach the private network.",
	CodePlainHTTPRefused:       "Plain HTTP is not allowed for this request.",
	CodePlaintextSecretRefused: "A secret cannot travel over plain HTTP on this connection.",
	CodeDNSFailed:              "The host name could not be resolved.",
	CodeDNSAddressRefused:      "The host resolves to an address a plugin connection never reaches.",
	CodeConnectFailed:          "The connection to the host failed.",
	CodeTLSFailed:              "The secure connection to the host failed.",
	CodeRedirectRefused:        "The host redirected to an address this connection may not follow.",
	CodeTimeout:                "The request did not complete in time.",
	CodeResponseTooLarge:       "The response is larger than this connection allows.",
	CodeConnectionUnavailable:  "The connection is not ready to use.",
	CodeRequestFailed:          "The request failed.",
}

// Failure is a categorized refusal or transport failure.
type Failure struct {
	Code string
	// Cause is the underlying error, for tests. It is never shown to plugin
	// code or logged: resolver and TLS text can name internal hosts.
	Cause error
}

func (f *Failure) Error() string { return f.Code + ": " + f.Message() }

// Message is the fixed text for the code.
func (f *Failure) Message() string {
	if message, ok := messages[f.Code]; ok {
		return message
	}
	return messages[CodeRequestFailed]
}

func (f *Failure) Unwrap() error { return f.Cause }

func failure(code string, cause error) *Failure {
	return &Failure{Code: code, Cause: cause}
}

// FailureCode returns the stable code of err, or "" when err is not a
// Failure.
func FailureCode(err error) string {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}
