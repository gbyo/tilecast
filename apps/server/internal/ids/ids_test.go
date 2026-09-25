package ids

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestNewIsRandomWithoutReservation(t *testing.T) {
	ctx := context.Background()
	if New(ctx) == New(ctx) {
		t.Fatal("expected distinct random IDs")
	}
}

func TestWithNextIsConsumedOnce(t *testing.T) {
	want := uuid.MustParse("5b0c6a39-6f0e-4d7e-9a3c-1f1f7d1c0001")
	ctx := WithNext(context.Background(), want)
	if got := New(ctx); got != want {
		t.Fatalf("first ID = %s, want %s", got, want)
	}
	if got := New(ctx); got == want {
		t.Fatal("a reserved ID was handed out twice")
	}
}
