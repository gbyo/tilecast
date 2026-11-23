// Package keyset is the position of keyset-paginated reads: the ordering
// value and the unique id of the last row a page returned. A read that
// continues from a position re-runs its own visibility predicate, so a
// position never grants access to a row.
package keyset

import (
	"strconv"
	"time"

	"github.com/google/uuid"
)

// After is the last row a page returned.
type After struct {
	At time.Time
	ID uuid.UUID
}

// Ascending returns the predicate "the row orders after the position" for
// an ascending (time, id) order and appends its arguments. A nil position is
// the first page.
func Ascending(after *After, timeColumn, idColumn string, args *[]any) string {
	return clause(after, timeColumn, idColumn, ">", args)
}

// Descending is Ascending for a descending (time, id) order.
func Descending(after *After, timeColumn, idColumn string, args *[]any) string {
	return clause(after, timeColumn, idColumn, "<", args)
}

func clause(after *After, timeColumn, idColumn, operator string, args *[]any) string {
	if after == nil {
		return "TRUE"
	}
	*args = append(*args, after.At, after.ID)
	n := len(*args)
	return "(" + timeColumn + "," + idColumn + ")" + operator + "($" + strconv.Itoa(n-1) + "," + "$" + strconv.Itoa(n) + ")"
}
