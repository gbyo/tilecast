package server

import (
	"math"
	"sort"
	"strings"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Assembly of the menu feed from catalog objects. One record for each sellable
// item variation; record IDs are the Square variation IDs, so they stay
// stable across reads.

// maxMenuRecords bounds a menu below the feed's 2,000 records.
const maxMenuRecords = 1000

// zeroDecimalCurrencies are ISO 4217 currencies with no minor unit among
// those Square supports. Every other currency has two decimals.
var zeroDecimalCurrencies = map[string]bool{"JPY": true, "KRW": true, "CLP": true, "VND": true, "ISK": true, "UGX": true}

func majorUnits(m *money) (float64, bool) {
	if m == nil || m.Amount == nil || *m.Amount < 0 {
		return 0, false
	}
	if zeroDecimalCurrencies[strings.ToUpper(m.Currency)] {
		return float64(*m.Amount), true
	}
	return math.Round(float64(*m.Amount)) / 100, true
}

func presentAt(object catalogObject, location string) bool {
	if location == "" {
		return true
	}
	for _, absent := range object.AbsentAtLocationIDs {
		if absent == location {
			return false
		}
	}
	if object.PresentAtAllLocations == nil || *object.PresentAtAllLocations {
		return true
	}
	for _, present := range object.PresentAtLocationIDs {
		if present == location {
			return true
		}
	}
	return false
}

func clip(value string, maximum int) string {
	value = strings.TrimSpace(value)
	if runes := []rune(value); len(runes) > maximum {
		return string(runes[:maximum])
	}
	return value
}

// assemble turns catalog objects into feed records, in category order and
// then item and variation order. A missing category, image, or price is
// left empty; an object without the data its type needs is skipped.
func assemble(objects []catalogObject, location string, withImages bool) []plugin.FeedRecord {
	categories, images := map[string]string{}, map[string]string{}
	for _, object := range objects {
		switch {
		case object.IsDeleted:
		case object.Type == "CATEGORY" && object.CategoryData != nil:
			categories[object.ID] = object.CategoryData.Name
		case object.Type == "IMAGE" && object.ImageData != nil && strings.HasPrefix(object.ImageData.URL, "https://"):
			images[object.ID] = object.ImageData.URL
		}
	}
	type row struct {
		category string
		catOrder int64
		item     string
		varOrder int64
		record   plugin.FeedRecord
	}
	rows := []row{}
	for _, object := range objects {
		item := object.ItemData
		if object.Type != "ITEM" || object.IsDeleted || item == nil || item.IsArchived || strings.TrimSpace(item.Name) == "" || !presentAt(object, location) {
			continue
		}
		category, catOrder := "", int64(math.MaxInt32)
		if len(item.Categories) > 0 {
			category = categories[item.Categories[0].ID]
			if item.Categories[0].Ordinal != nil {
				catOrder = *item.Categories[0].Ordinal
			}
		}
		photo := ""
		if withImages && len(item.ImageIDs) > 0 {
			photo = images[item.ImageIDs[0]]
		}
		sellable := 0
		for _, variation := range item.Variations {
			if data := variation.ItemVariationData; data != nil && (data.Sellable == nil || *data.Sellable) {
				sellable++
			}
		}
		for _, variation := range item.Variations {
			data := variation.ItemVariationData
			if variation.IsDeleted || data == nil || (data.Sellable != nil && !*data.Sellable) || variation.ID == "" || len(variation.ID) > 80 ||
				!presentAt(variation, location) {
				continue
			}
			name := item.Name
			if sellable > 1 && strings.TrimSpace(data.Name) != "" {
				name += " (" + strings.TrimSpace(data.Name) + ")"
			}
			available := true
			for _, override := range data.LocationOverrides {
				if location != "" && override.LocationID == location && override.SoldOut {
					available = false
				}
			}
			values := map[string]any{
				"providerId": variation.ID, "name": clip(name, 160), "description": clip(item.DescriptionPlaintext, 500),
				"category": clip(category, 80), "available": available, "photo": nil,
			}
			if price, ok := majorUnits(data.PriceMoney); ok && data.PricingType != "VARIABLE_PRICING" {
				values["price"] = price
				values["currency"] = strings.ToUpper(clip(data.PriceMoney.Currency, 3))
			}
			if photo != "" {
				values["photo"] = photo
			}
			rows = append(rows, row{category: category, catOrder: catOrder, item: item.Name, varOrder: data.Ordinal,
				record: plugin.FeedRecord{ID: variation.ID, Values: values}})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		switch {
		case a.catOrder != b.catOrder:
			return a.catOrder < b.catOrder
		case a.category != b.category:
			return a.category < b.category
		case a.item != b.item:
			return a.item < b.item
		default:
			return a.varOrder < b.varOrder
		}
	})
	out := make([]plugin.FeedRecord, 0, len(rows))
	for index, row := range rows {
		if index == maxMenuRecords {
			break
		}
		row.record.Values["order"] = index
		out = append(out, row.record)
	}
	return out
}

// sampleMenu is a fixed menu for Demo Mode and for trying a sign before
// connecting Square.
func sampleMenu() []plugin.FeedRecord {
	items := []struct {
		id, name, category string
		price              float64
		available          bool
	}{
		{"sample-latte", "Latte", "Coffee", 4.5, true},
		{"sample-americano", "Americano", "Coffee", 3.25, true},
		{"sample-chai", "Chai latte", "Tea", 4.75, true},
		{"sample-matcha", "Matcha", "Tea", 5, false},
		{"sample-croissant", "Croissant", "Bakery", 3.5, true},
		{"sample-muffin", "Blueberry muffin", "Bakery", 3.75, true},
	}
	out := make([]plugin.FeedRecord, 0, len(items))
	for index, item := range items {
		out = append(out, plugin.FeedRecord{ID: item.id, Values: map[string]any{"providerId": item.id, "name": item.name, "category": item.category,
			"price": item.price, "currency": "USD", "available": item.available, "order": index}})
	}
	return out
}
