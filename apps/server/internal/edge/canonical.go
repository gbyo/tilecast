package edge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Canonical JSON for signed Edge bodies: the RFC 8785 (JCS) subset shared
// with edge_protocol::canonical in the Rust daemon. Values are null,
// booleans, strings, arrays, objects and integers in the IEEE-754 safe range;
// any other number is rejected so a signature never depends on float
// formatting. Object members are sorted by UTF-16 code units and strings are
// escaped exactly as ECMAScript JSON.stringify does. Both implementations are
// held to packages/edge-protocol/fixtures/canonical-json.

const maxSafeInteger = 1<<53 - 1

const maxCanonicalDepth = 16

var (
	ErrUnsupportedNumber = errors.New("signed JSON may contain only integers in the safe range")
	ErrCanonicalDepth    = errors.New("signed JSON nesting is too deep")
	ErrNotCanonical      = errors.New("body is not in canonical form")
)

// Canonicalize serializes a value built from map[string]any, []any, string,
// bool, nil, json.Number and Go integer types.
func Canonicalize(value any) ([]byte, error) {
	var out bytes.Buffer
	if err := writeCanonical(&out, value, 0); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// CanonicalizeJSON parses JSON text (preserving number text) and returns its
// canonical form.
func CanonicalizeJSON(text []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if decoder.More() {
		return nil, errors.New("invalid JSON: trailing data")
	}
	return Canonicalize(value)
}

// ParseCanonical decodes text and requires it to already be canonical,
// rejecting duplicate keys, whitespace and escape variants.
func ParseCanonical(text []byte) (map[string]any, error) {
	again, err := CanonicalizeJSON(text)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(again, text) {
		return nil, ErrNotCanonical
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func writeCanonical(out *bytes.Buffer, value any, depth int) error {
	if depth > maxCanonicalDepth {
		return ErrCanonicalDepth
	}
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if v {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case string:
		writeCanonicalString(out, v)
	case json.Number:
		text := v.String()
		if strings.ContainsAny(text, ".eE") {
			return ErrUnsupportedNumber
		}
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil || n > maxSafeInteger || n < -maxSafeInteger {
			return ErrUnsupportedNumber
		}
		out.WriteString(strconv.FormatInt(n, 10))
	case int:
		return writeCanonical(out, int64(v), depth)
	case int32:
		return writeCanonical(out, int64(v), depth)
	case int64:
		if v > maxSafeInteger || v < -maxSafeInteger {
			return ErrUnsupportedNumber
		}
		out.WriteString(strconv.FormatInt(v, 10))
	case uint32:
		return writeCanonical(out, int64(v), depth)
	case uint64:
		if v > maxSafeInteger {
			return ErrUnsupportedNumber
		}
		out.WriteString(strconv.FormatUint(v, 10))
	case float64, float32:
		f := toFloat(v)
		if math.Trunc(f) != f {
			return ErrUnsupportedNumber
		}
		// Integers decoded without UseNumber arrive as float64; accept only
		// exact values in range.
		if f > maxSafeInteger || f < -maxSafeInteger {
			return ErrUnsupportedNumber
		}
		out.WriteString(strconv.FormatInt(int64(f), 10))
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := writeCanonical(out, item, depth+1); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			writeCanonicalString(out, key)
			out.WriteByte(':')
			if err := writeCanonical(out, v[key], depth+1); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("unsupported canonical JSON value %T", value)
	}
	return nil
}

func toFloat(v any) float64 {
	switch f := v.(type) {
	case float32:
		return float64(f)
	case float64:
		return f
	}
	return math.NaN()
}

func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func writeCanonicalString(out *bytes.Buffer, value string) {
	const hex = "0123456789abcdef"
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				out.WriteString(`\u00`)
				out.WriteByte(hex[r>>4])
				out.WriteByte(hex[r&0x0f])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}
