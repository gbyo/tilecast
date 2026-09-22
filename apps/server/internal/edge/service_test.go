package edge

import (
	"context"
	"testing"
)

// Retry must never initialize (and so never generate keys) after a missing
// authority or when Edge is disabled. The nil pool makes any database use
// panic, which is the failure this test detects.
func TestRetryLeavesRecoveryConditionsAlone(t *testing.T) {
	for _, err := range []error{ErrAuthorityMissing, ErrDisabled} {
		service := &Service{authorityErr: err}
		service.Retry(context.Background())
		if _, got := service.Authority(); got != err {
			t.Fatalf("Retry changed %v to %v", err, got)
		}
	}
}
