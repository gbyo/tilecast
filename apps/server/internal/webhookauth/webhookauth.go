// Package webhookauth verifies the signatures of inbound plugin webhooks
// (docs/plugin-webhooks.md). It is pure: the caller passes the exact raw
// body, the request headers, the signing secret, the configured endpoint
// address, and the host clock. Nothing here reads a request, a database, or
// a header the caller did not choose.
//
// Every comparison of a signature is constant time. A failure reports a
// stable code for the plugin's status and never a detail that tells a
// sender how close a signature was.
package webhookauth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Failure is a verification failure with a stable code. The HTTP answer of
// every Failure is the same; only the plugin's status shows the code.
type Failure struct{ Code string }

func (f *Failure) Error() string { return "webhook verification failed: " + f.Code }

// Failure codes.
const (
	CodeSignatureMissing   = "signature_missing"
	CodeSignatureInvalid   = "signature_invalid"
	CodeTimestampMissing   = "timestamp_missing"
	CodeTimestampOutOfSpan = "timestamp_out_of_range"
	CodeDeliveryIDMissing  = "delivery_id_missing"
)

// ErrSecretUnusable answers a signing secret the scheme cannot use, such as
// a standard-webhooks secret that is not base64. The host fails closed.
var ErrSecretUnusable = errors.New("the signing secret cannot be used by this scheme")

func fail(code string) error { return &Failure{Code: code} }

// StandardSecretPrefix starts a serialized symmetric Standard Webhooks key.
const StandardSecretPrefix = "whsec_"

// StandardKey decodes a Standard Webhooks symmetric secret: the whsec_
// prefix is removed and the rest is the base64 key material. The HMAC key
// is the decoded bytes, never the text of the secret.
func StandardKey(secret string) ([]byte, error) {
	encoded := strings.TrimPrefix(strings.TrimSpace(secret), StandardSecretPrefix)
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) == 0 {
		return nil, ErrSecretUnusable
	}
	return key, nil
}

// Standard verifies a Standard Webhooks request: HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<body>", sent as space-separated
// "v1,<base64>" entries. Entries of other versions, such as the asymmetric
// v1a, are ignored: this release verifies only the symmetric form. It
// returns the webhook-id, the delivery ID of the request.
func Standard(secret string, header http.Header, body []byte, now time.Time) (string, error) {
	key, err := StandardKey(secret)
	if err != nil {
		return "", err
	}
	id := header.Get("webhook-id")
	if !ValidDeliveryID(id) {
		return "", fail(CodeDeliveryIDMissing)
	}
	timestamp, err := checkTimestamp(header.Get("webhook-timestamp"), now)
	if err != nil {
		return "", err
	}
	signatures := header.Get("webhook-signature")
	if signatures == "" || len(signatures) > plugin.MaxWebhookSignatureHeaderBytes {
		return "", fail(CodeSignatureMissing)
	}
	expected := mac(key, []byte(id), []byte("."), []byte(timestamp), []byte("."), body)
	var candidates [][]byte
	for _, entry := range strings.Fields(signatures) {
		version, value, ok := strings.Cut(entry, ",")
		if !ok || version != "v1" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			continue
		}
		candidates = append(candidates, decoded)
	}
	if err := anyMatches(expected, candidates); err != nil {
		return "", err
	}
	return id, nil
}

// HMAC verifies a generic hmac-sha256 signature. endpoint is the configured
// public endpoint address; only the url.body form uses it.
func HMAC(declaration plugin.WebhookSignature, secret string, header http.Header, endpoint string, body []byte, now time.Time) error {
	if secret == "" {
		return ErrSecretUnusable
	}
	raw := header.Get(declaration.Header)
	if raw == "" || len(raw) > plugin.MaxWebhookSignatureHeaderBytes {
		return fail(CodeSignatureMissing)
	}
	var values []string
	var timestamp string
	switch declaration.Format {
	case plugin.SignatureFormatPairs:
		for _, pair := range strings.Split(raw, ",") {
			key, value, ok := strings.Cut(strings.TrimSpace(pair), "=")
			if !ok {
				continue
			}
			switch key {
			case declaration.SignatureKey:
				values = append(values, value)
			case declaration.TimestampKey:
				if declaration.TimestampKey != "" {
					if timestamp != "" {
						return fail(CodeTimestampMissing)
					}
					timestamp = value
				}
			}
		}
	default:
		values = strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' })
		if declaration.TimestampHeader != "" {
			timestamp = header.Get(declaration.TimestampHeader)
		}
	}
	var message [][]byte
	switch declaration.SignedPayload {
	case plugin.SignedTimestampBody:
		checked, err := checkTimestamp(timestamp, now)
		if err != nil {
			return err
		}
		message = [][]byte{[]byte(checked), []byte("."), body}
	case plugin.SignedURLBody:
		message = [][]byte{[]byte(endpoint), body}
	default:
		message = [][]byte{body}
	}
	// The secret text is the key, as providers document it. A secret that
	// happens to look like hex or base64 is still used as text.
	expected := mac([]byte(secret), message...)
	var candidates [][]byte
	for _, value := range values {
		if declaration.Prefix != "" {
			trimmed, ok := strings.CutPrefix(value, declaration.Prefix)
			if !ok {
				continue
			}
			value = trimmed
		}
		var decoded []byte
		var err error
		if declaration.Encoding == plugin.SignatureEncodingHex {
			decoded, err = hex.DecodeString(value)
		} else {
			decoded, err = base64.StdEncoding.DecodeString(value)
		}
		if err == nil {
			candidates = append(candidates, decoded)
		}
	}
	return anyMatches(expected, candidates)
}

func mac(key []byte, parts ...[]byte) []byte {
	h := hmac.New(sha256.New, key)
	for _, part := range parts {
		h.Write(part)
	}
	return h.Sum(nil)
}

// anyMatches compares each candidate with the expected MAC in constant
// time. At most MaxWebhookSignatures candidates are tried.
func anyMatches(expected []byte, candidates [][]byte) error {
	if len(candidates) == 0 {
		return fail(CodeSignatureMissing)
	}
	if len(candidates) > plugin.MaxWebhookSignatures {
		candidates = candidates[:plugin.MaxWebhookSignatures]
	}
	matched := 0
	for _, candidate := range candidates {
		matched |= boolInt(hmac.Equal(expected, candidate))
	}
	if matched != 1 {
		return fail(CodeSignatureInvalid)
	}
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// checkTimestamp parses Unix seconds and refuses a time more than the
// tolerance away from now. It returns the timestamp text exactly as signed.
func checkTimestamp(value string, now time.Time) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 20 {
		return "", fail(CodeTimestampMissing)
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return "", fail(CodeTimestampMissing)
	}
	delta := now.Sub(time.Unix(seconds, 0))
	if delta > plugin.WebhookTimestampTolerance || delta < -plugin.WebhookTimestampTolerance {
		return "", fail(CodeTimestampOutOfSpan)
	}
	return value, nil
}

// ValidDeliveryID reports whether an external delivery ID is 1 to 200
// visible ASCII characters.
func ValidDeliveryID(id string) bool {
	if id == "" || len(id) > plugin.MaxWebhookDeliveryIDBytes {
		return false
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 0x21 || id[i] > 0x7e {
			return false
		}
	}
	return true
}

// Pointer resolves a JSON Pointer (RFC 6901) in a JSON document to a string
// or an integer, the forms a provider uses for an ID. Any other value, a
// missing member, or an invalid document answers false.
func Pointer(document []byte, pointer string) (string, bool) {
	if !plugin.ValidWebhookPointer(pointer) {
		return "", false
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", false
	}
	for _, token := range strings.Split(pointer[1:], "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		switch node := value.(type) {
		case map[string]any:
			next, ok := node[token]
			if !ok {
				return "", false
			}
			value = next
		case []any:
			index, err := strconv.Atoi(token)
			if err != nil || index < 0 || index >= len(node) || (len(token) > 1 && token[0] == '0') {
				return "", false
			}
			value = node[index]
		default:
			return "", false
		}
	}
	switch leaf := value.(type) {
	case string:
		return leaf, true
	case json.Number:
		if _, err := leaf.Int64(); err == nil {
			return leaf.String(), true
		}
	}
	return "", false
}
