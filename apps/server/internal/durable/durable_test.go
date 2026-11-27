package durable

import (
	"testing"
	"time"
)

func TestBackoffDoublesAndStopsAtTheMaximum(t *testing.T) {
	for attempt, want := range map[int]time.Duration{
		0: 5 * time.Second, 1: 5 * time.Second, 2: 10 * time.Second, 3: 20 * time.Second, 10: 2560 * time.Second, 11: time.Hour, 1000: time.Hour,
	} {
		if got := Backoff(attempt, 5*time.Second, time.Hour); got != want {
			t.Errorf("Backoff(%d) = %v, want %v", attempt, got, want)
		}
	}
	if got := Backoff(1, 2*time.Hour, time.Hour); got != time.Hour {
		t.Fatalf("a base above the maximum = %v", got)
	}
}
