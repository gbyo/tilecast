package kvstore

import (
	"errors"
	"strings"
	"testing"
)

func TestBounds(t *testing.T) {
	if CheckKey(strings.Repeat("k", MaxKeyBytes)) != nil || !errors.Is(CheckKey(strings.Repeat("k", MaxKeyBytes+1)), ErrInvalidKey) ||
		!errors.Is(CheckKey(""), ErrInvalidKey) {
		t.Fatal("key bounds")
	}
	if CheckEntry("k", make([]byte, MaxValueBytes)) != nil || !errors.Is(CheckEntry("k", make([]byte, MaxValueBytes+1)), ErrValueTooLarge) {
		t.Fatal("value bounds")
	}
	if CheckQuota(MaxNamespaceBytes-10, 10) != nil || !errors.Is(CheckQuota(MaxNamespaceBytes-10, 11), ErrQuotaExceeded) {
		t.Fatal("quota")
	}
}
