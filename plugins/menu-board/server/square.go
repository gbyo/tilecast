package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// The Square Catalog client. Every request goes through http.fetch@1 on the
// menu's oauth2 connection; the host adds the bearer token, and this code
// never sees it. It only reads: ListCatalog with ITEMS_READ.

// SquareVersion is the Square API version every request names, checked
// against Square's API reference on 2026-11-23. A new version is a
// deliberate change with its own tests.
const SquareVersion = "2026-11-18"

// maxCatalogPages bounds one read: ListCatalog returns at most 100 objects
// a page, so a read sees at most 3,000 objects.
const maxCatalogPages = 30

type money struct {
	Amount   *int64 `json:"amount"`
	Currency string `json:"currency"`
}

type locationOverride struct {
	LocationID string `json:"location_id"`
	SoldOut    bool   `json:"sold_out"`
}

type catalogObject struct {
	Type                  string   `json:"type"`
	ID                    string   `json:"id"`
	IsDeleted             bool     `json:"is_deleted"`
	PresentAtAllLocations *bool    `json:"present_at_all_locations"`
	PresentAtLocationIDs  []string `json:"present_at_location_ids"`
	AbsentAtLocationIDs   []string `json:"absent_at_location_ids"`
	ItemData              *struct {
		Name                 string `json:"name"`
		DescriptionPlaintext string `json:"description_plaintext"`
		IsArchived           bool   `json:"is_archived"`
		Categories           []struct {
			ID      string `json:"id"`
			Ordinal *int64 `json:"ordinal"`
		} `json:"categories"`
		ImageIDs   []string        `json:"image_ids"`
		Variations []catalogObject `json:"variations"`
	} `json:"item_data"`
	ItemVariationData *struct {
		Name              string             `json:"name"`
		Ordinal           int64              `json:"ordinal"`
		PricingType       string             `json:"pricing_type"`
		PriceMoney        *money             `json:"price_money"`
		Sellable          *bool              `json:"sellable"`
		LocationOverrides []locationOverride `json:"location_overrides"`
	} `json:"item_variation_data"`
	CategoryData *struct {
		Name string `json:"name"`
	} `json:"category_data"`
	ImageData *struct {
		URL string `json:"url"`
	} `json:"image_data"`
}

type catalogPage struct {
	Objects []catalogObject `json:"objects"`
	Cursor  string          `json:"cursor"`
	Errors  []struct {
		Category string `json:"category"`
		Code     string `json:"code"`
	} `json:"errors"`
}

// squareError is a Square answer other than 200.
type squareError struct {
	Status int
	Code   string
}

func (e *squareError) Error() string { return fmt.Sprintf("square: status %d %s", e.Status, e.Code) }

type fetcher interface {
	Fetch(ctx context.Context, request plugin.HTTPRequest) (plugin.HTTPResponse, error)
}

// catalog is one complete read.
type catalog struct {
	Objects []catalogObject
	Pages   int
	// Complete is false when the page bound stopped the read.
	Complete bool
}

// listCatalog reads items, categories, and images page by page.
func listCatalog(ctx context.Context, client fetcher, connection uuid.UUID) (catalog, error) {
	result := catalog{}
	cursor := ""
	for page := 0; page < maxCatalogPages; page++ {
		query := url.Values{"types": {"ITEM,CATEGORY,IMAGE"}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		response, err := client.Fetch(ctx, plugin.HTTPRequest{Connection: connection, Method: http.MethodGet, URL: "/v2/catalog/list?" + query.Encode(),
			Headers: []plugin.HTTPHeader{{Name: "Square-Version", Value: SquareVersion}, {Name: "Accept", Value: "application/json"}}})
		if err != nil {
			return catalog{}, err
		}
		var body catalogPage
		decodeErr := json.Unmarshal(response.Body, &body)
		if response.Status != http.StatusOK {
			code := ""
			if decodeErr == nil && len(body.Errors) > 0 {
				code = body.Errors[0].Code
			}
			return catalog{}, &squareError{Status: response.Status, Code: code}
		}
		if decodeErr != nil {
			return catalog{}, fmt.Errorf("square: decode catalog: %w", decodeErr)
		}
		result.Objects = append(result.Objects, body.Objects...)
		result.Pages++
		if body.Cursor == "" {
			result.Complete = true
			return result, nil
		}
		cursor = body.Cursor
	}
	return result, nil
}
