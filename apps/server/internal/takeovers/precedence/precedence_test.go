package precedence

import (
	"strings"
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

func TestClassOrder(t *testing.T) {
	order := []plugin.TakeoverClass{plugin.TakeoverLifeSafety, plugin.TakeoverEmergency, plugin.TakeoverOperator, plugin.TakeoverAutomation}
	for index, class := range order {
		rank, ok := class.Rank()
		if !ok || rank != index {
			t.Fatalf("%s rank=%d ok=%v, want %d", class, rank, ok, index)
		}
		for _, weaker := range order[index+1:] {
			if !class.StrongerThan(weaker) || weaker.StrongerThan(class) {
				t.Fatalf("%s should outrank %s", class, weaker)
			}
		}
		if class.StrongerThan(class) {
			t.Fatalf("%s outranks itself", class)
		}
	}
	if plugin.TakeoverClass("").Valid() || plugin.TakeoverClass("critical").Valid() {
		t.Fatal("unknown classes are valid")
	}
	if plugin.TakeoverClass("critical").StrongerThan(plugin.TakeoverAutomation) {
		t.Fatal("an unknown class outranks a known one")
	}
}

func TestOrderSQLFollowsTheClassList(t *testing.T) {
	sql := OrderSQL("e")
	want := "CASE e.class WHEN 'life_safety' THEN 0 WHEN 'emergency' THEN 1 WHEN 'operator' THEN 2 WHEN 'automation' THEN 3 ELSE 4 END ASC,e.activated_at DESC,e.id DESC"
	if sql != want {
		t.Fatalf("OrderSQL=%q\nwant      %q", sql, want)
	}
	if effective := EffectiveIDSQL("es.screen_id", "now()"); !strings.Contains(effective, "pes.screen_id=es.screen_id") || !strings.Contains(effective, OrderSQL("pe")) {
		t.Fatalf("EffectiveIDSQL does not use the shared order: %s", effective)
	}
}
