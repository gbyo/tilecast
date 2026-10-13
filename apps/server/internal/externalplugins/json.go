package externalplugins

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
)

// normalizeState bounds both source and canonical encoding. A depth/node
// limit prevents a small but deeply nested document from reaching Players.
func normalizeState(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || len(raw) > 2*MaxStateBytes {
		return nil, fmt.Errorf("%w: state must fit 16 KiB", ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil || object == nil {
		return nil, fmt.Errorf("%w: state must be an object", ErrInvalid)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("%w: trailing JSON", ErrInvalid)
	}
	nodes := 0
	var visit func(any, int) error
	visit = func(value any, depth int) error {
		nodes++
		if depth > 16 || nodes > 2048 {
			return fmt.Errorf("%w: state exceeds structural bounds", ErrInvalid)
		}
		switch value := value.(type) {
		case map[string]any:
			for _, child := range value {
				if err := visit(child, depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range value {
				if err := visit(child, depth+1); err != nil {
					return err
				}
			}
		case json.Number:
			n, err := strconv.ParseFloat(string(value), 64)
			if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
				return fmt.Errorf("%w: number is not finite", ErrInvalid)
			}
		}
		return nil
	}
	if err := visit(object, 0); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return nil, err
	}
	if len(encoded) > MaxStateBytes {
		return nil, fmt.Errorf("%w: canonical state exceeds 16 KiB", ErrInvalid)
	}
	return encoded, nil
}
