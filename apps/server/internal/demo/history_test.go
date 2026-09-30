package demo

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestStateHistoryIsContiguousDeterministicAndMostlyUp(t *testing.T) {
	screen := uuid.MustParse("de300003-0000-4000-8000-000000000001")
	until := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	from := until.Add(-historyDays * 24 * time.Hour)

	for _, silent := range []bool{false, true} {
		history := stateHistory(screen, from, until, silent)
		if len(history) < 3 {
			t.Fatalf("silent=%v: want a varied timeline, got %d intervals", silent, len(history))
		}
		if !history[0].Start.Equal(from) {
			t.Fatalf("silent=%v: history starts at %s, want %s", silent, history[0].Start, from)
		}
		var up, total time.Duration
		for i, interval := range history {
			last := i == len(history)-1
			if interval.End == nil {
				if !silent || !last {
					t.Fatalf("silent=%v: interval %d is open; only a silent screen's last one may be", silent, i)
				}
				if interval.State != "healthy" || !interval.Start.Before(until) {
					t.Fatalf("silent screen must end on a healthy interval opened before its last contact, got %+v", interval)
				}
				continue
			}
			if !interval.End.After(interval.Start) {
				t.Fatalf("silent=%v: interval %d is empty or reversed", silent, i)
			}
			if !last && !history[i+1].Start.Equal(*interval.End) {
				t.Fatalf("silent=%v: gap or overlap after interval %d", silent, i)
			}
			if interval.End.After(until) {
				t.Fatalf("silent=%v: interval %d runs past %s", silent, i, until)
			}
			if interval.State == "healthy" {
				up += interval.End.Sub(interval.Start)
			}
			total += interval.End.Sub(interval.Start)
		}
		if !silent && !history[len(history)-1].End.Equal(until) {
			t.Fatalf("a simulated screen's history must end exactly at the seed")
		}
		if share := float64(up) / float64(total); share < 0.95 || share >= 1 {
			t.Fatalf("silent=%v: healthy share %.3f, want high but imperfect", silent, share)
		}
	}

	first := stateHistory(screen, from, until, false)
	again := stateHistory(screen, from, until, false)
	if len(first) != len(again) || !first[len(first)/2].Start.Equal(again[len(again)/2].Start) {
		t.Fatal("the same screen must get the same history on every reset")
	}
	other := stateHistory(uuid.MustParse("de300003-0000-4000-8000-000000000002"), from, until, false)
	if len(other) == len(first) && other[1].Start.Equal(first[1].Start) {
		t.Fatal("different screens should not share one identical timeline")
	}
}
