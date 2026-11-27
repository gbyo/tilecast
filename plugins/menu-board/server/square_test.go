package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

type fakeSquare struct {
	pages    map[string]string
	status   int
	requests []plugin.HTTPRequest
}

func (f *fakeSquare) Fetch(_ context.Context, request plugin.HTTPRequest) (plugin.HTTPResponse, error) {
	f.requests = append(f.requests, request)
	if f.status != 0 {
		return plugin.HTTPResponse{Status: f.status, Body: []byte(`{"errors":[{"category":"AUTHENTICATION_ERROR","code":"UNAUTHORIZED"}]}`)}, nil
	}
	parsed, _ := url.Parse(request.URL)
	body, ok := f.pages[parsed.Query().Get("cursor")]
	if !ok {
		return plugin.HTTPResponse{Status: http.StatusNotFound}, nil
	}
	return plugin.HTTPResponse{Status: http.StatusOK, Body: []byte(body)}, nil
}

const catalogPage1 = `{"cursor":"c2","objects":[
 {"type":"CATEGORY","id":"cat-coffee","category_data":{"name":"Coffee"}},
 {"type":"IMAGE","id":"img-latte","image_data":{"url":"https://items-images-production.s3.us-west-2.amazonaws.com/files/latte.png"}},
 {"type":"ITEM","id":"item-latte","item_data":{"name":"Latte","description_plaintext":"Espresso and milk","categories":[{"id":"cat-coffee","ordinal":1}],"image_ids":["img-latte"],
  "variations":[{"type":"ITEM_VARIATION","id":"var-latte-s","item_variation_data":{"name":"Small","ordinal":0,"pricing_type":"FIXED_PRICING","price_money":{"amount":450,"currency":"USD"}}},
                {"type":"ITEM_VARIATION","id":"var-latte-l","item_variation_data":{"name":"Large","ordinal":1,"pricing_type":"FIXED_PRICING","price_money":{"amount":525,"currency":"USD"},
                 "location_overrides":[{"location_id":"LOC1","sold_out":true}]}}]}}]}`

const catalogPage2 = `{"objects":[
 {"type":"CATEGORY","id":"cat-tea","category_data":{"name":"Tea"}},
 {"type":"ITEM","id":"item-chai","item_data":{"name":"Chai","categories":[{"id":"cat-tea","ordinal":2}],"image_ids":["img-missing"],
  "variations":[{"type":"ITEM_VARIATION","id":"var-chai","item_variation_data":{"name":"Regular","pricing_type":"VARIABLE_PRICING"}}]}},
 {"type":"ITEM","id":"item-old","item_data":{"name":"Old","is_archived":true,"variations":[{"type":"ITEM_VARIATION","id":"var-old","item_variation_data":{"name":"Regular"}}]}},
 {"type":"ITEM","id":"item-elsewhere","present_at_all_locations":false,"present_at_location_ids":["LOC2"],"item_data":{"name":"Elsewhere",
  "variations":[{"type":"ITEM_VARIATION","id":"var-elsewhere","item_variation_data":{"name":"Regular","price_money":{"amount":100,"currency":"USD"}}}]}},
 {"type":"ITEM","id":"item-noname","item_data":{"name":"  ","variations":[]}},
 {"type":"ITEM","id":"item-ramen","item_data":{"name":"Ramen","variations":[{"type":"ITEM_VARIATION","id":"var-ramen","item_variation_data":{"name":"Bowl","price_money":{"amount":1200,"currency":"JPY"},"sellable":true}},
  {"type":"ITEM_VARIATION","id":"var-ramen-off","item_variation_data":{"name":"Secret","sellable":false}}]}}]}`

func TestListCatalogPaginatesWithTheSquareVersion(t *testing.T) {
	square := &fakeSquare{pages: map[string]string{"": catalogPage1, "c2": catalogPage2}}
	read, err := listCatalog(context.Background(), square, uuid.New())
	if err != nil || !read.Complete || read.Pages != 2 || len(read.Objects) != 9 {
		t.Fatalf("read = %+v %v", read, err)
	}
	for _, request := range square.requests {
		parsed, _ := url.Parse(request.URL)
		if parsed.Path != "/v2/catalog/list" || parsed.Query().Get("types") != "ITEM,CATEGORY,IMAGE" || request.Method != http.MethodGet ||
			request.Headers[0].Name != "Square-Version" || request.Headers[0].Value != SquareVersion {
			t.Fatalf("request = %+v", request)
		}
	}
}

func TestProviderErrors(t *testing.T) {
	_, err := listCatalog(context.Background(), &fakeSquare{status: http.StatusUnauthorized}, uuid.New())
	var failure *squareError
	if !errors.As(err, &failure) || failure.Status != http.StatusUnauthorized || failure.Code != "UNAUTHORIZED" {
		t.Fatalf("401 = %v", err)
	}
	if _, err := listCatalog(context.Background(), &fakeSquare{pages: map[string]string{"": "not json"}}, uuid.New()); err == nil {
		t.Fatal("invalid JSON was accepted")
	}
	// The page bound stops an endless cursor.
	pages := map[string]string{"": `{"cursor":"x","objects":[]}`, "x": `{"cursor":"x","objects":[]}`}
	read, err := listCatalog(context.Background(), &fakeSquare{pages: pages}, uuid.New())
	if err != nil || read.Complete || read.Pages != maxCatalogPages {
		t.Fatalf("bounded = %+v %v", read, err)
	}
}

func TestAssemblyAtALocation(t *testing.T) {
	var first, second catalogPage
	_ = json.Unmarshal([]byte(catalogPage1), &first)
	_ = json.Unmarshal([]byte(catalogPage2), &second)
	objects := append(first.Objects, second.Objects...)
	records := assemble(objects, "LOC1", true)
	ids := []string{}
	for _, record := range records {
		ids = append(ids, record.ID)
	}
	// Category order, then item, then variation; archived, unnamed,
	// unsellable, and other-location items are left out.
	if strings.Join(ids, ",") != "var-latte-s,var-latte-l,var-chai,var-ramen" {
		t.Fatalf("records = %v", ids)
	}
	small, large, chai, ramen := records[0].Values, records[1].Values, records[2].Values, records[3].Values
	if small["name"] != "Latte (Small)" || small["price"] != 4.5 || small["currency"] != "USD" || small["category"] != "Coffee" ||
		small["photo"] != "https://items-images-production.s3.us-west-2.amazonaws.com/files/latte.png" || small["available"] != true || small["order"] != 0 {
		t.Fatalf("small = %v", small)
	}
	if large["available"] != false || large["price"] != 5.25 {
		t.Fatalf("sold out at LOC1 = %v", large)
	}
	// A missing image and variable pricing leave fields empty.
	if chai["photo"] != nil || chai["price"] != nil || chai["name"] != "Chai" {
		t.Fatalf("chai = %v", chai)
	}
	if ramen["price"] != float64(1200) || ramen["currency"] != "JPY" || ramen["name"] != "Ramen" || ramen["category"] != "" {
		t.Fatalf("ramen = %v", ramen)
	}
	// Without an images connection no record names a picture; without a
	// location every item is present and nothing is sold out.
	for _, record := range assemble(objects, "", false) {
		if record.Values["photo"] != nil || record.Values["available"] != true {
			t.Fatalf("no location = %v", record.Values)
		}
	}
	if len(sampleMenu()) != 6 {
		t.Fatal("sample menu")
	}
}
