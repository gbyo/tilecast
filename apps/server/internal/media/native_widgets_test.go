package media

import (
	"testing"
)

func TestValidateWidgetSizing(t *testing.T) {
	tooSmall, minimum, maximum, tooLarge := 24, 25, 500, 501
	for _, scale := range []*int{nil, &minimum, &maximum} {
		if err := validateWidgetSizing(scale, nil); err != nil {
			t.Fatalf("validateWidgetSizing(%v): %v", scale, err)
		}
	}
	for _, scale := range []*int{&tooSmall, &tooLarge} {
		if err := validateWidgetSizing(scale, nil); err == nil {
			t.Fatalf("validateWidgetSizing(%d) unexpectedly succeeded", *scale)
		}
	}
	negativePadding, noPadding, maximumPadding, excessivePadding := -1, 0, 40, 41
	for _, padding := range []*int{nil, &noPadding, &maximumPadding} {
		if err := validateWidgetSizing(nil, padding); err != nil {
			t.Fatalf("validateWidgetSizing padding %v: %v", padding, err)
		}
	}
	for _, padding := range []*int{&negativePadding, &excessivePadding} {
		if err := validateWidgetSizing(nil, padding); err == nil {
			t.Fatalf("validateWidgetSizing padding %d unexpectedly succeeded", *padding)
		}
	}
}
