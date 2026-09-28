package server

import "encoding/json"

// Optional distinguishes the three JSON states a PATCH field can be in: omitted (Set=false),
// explicit null (Set=true, Value=nil), and a supplied value (Set=true, Value non-nil). This lets
// an update preserve a stored value when the field is omitted, clear it on explicit null, and
// replace it when a value is provided.
type Optional[T any] struct {
	Set   bool
	Value *T
}

// UnmarshalJSON records that the field was present and captures null vs. a concrete value.
func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	if string(data) == "null" {
		o.Value = nil
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

// clears reports whether the field was explicitly set to null.
func (o Optional[T]) clears() bool { return o.Set && o.Value == nil }
