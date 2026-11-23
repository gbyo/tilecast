package plugins

import (
	plugin "github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ServiceReview is one Server service a Plugin Manifest API 3 plugin
// declares, as the install review shows it: the same registry-resolved
// shape a package's service grant has, contexts included, so Studio renders
// both the same way and says when a grant works while the plugin runs
// automatically.
type ServiceReview struct {
	ID          string                   `json:"id"`
	Version     int                      `json:"version"`
	Name        string                   `json:"name"`
	Description string                   `json:"description"`
	Category    string                   `json:"category"`
	Contexts    []string                 `json:"contexts"`
	Operations  []ServiceOperationReview `json:"operations"`
}

// ServiceOperationReview is one operation of a reviewed service.
type ServiceOperationReview struct {
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Mutating    bool     `json:"mutating"`
	Contexts    []string `json:"contexts"`
}

// serviceReviews resolves the manifest's declared Server services against
// the generated registry catalog. Manifest validation already refused any
// declaration the catalog does not know.
func serviceReviews(m plugin.Manifest) []ServiceReview {
	reviews := []ServiceReview{}
	for _, value := range m.Services {
		reference, ok := plugin.ParseServiceReference(value)
		if !ok {
			continue
		}
		service, ok := plugin.LookupServerService(reference.Name, reference.Version)
		if !ok {
			continue
		}
		review := ServiceReview{
			ID: service.ID, Version: service.Version, Name: service.Name, Description: service.Description,
			Category: service.Category, Contexts: append([]string{}, service.Contexts...),
			Operations: make([]ServiceOperationReview, 0, len(service.Operations)),
		}
		for _, operation := range service.Operations {
			review.Operations = append(review.Operations, ServiceOperationReview{
				Name: operation.Name, Title: operation.Title, Description: operation.Description,
				Mutating: operation.Mutating, Contexts: append([]string{}, operation.Contexts...),
			})
		}
		reviews = append(reviews, review)
	}
	return reviews
}

func cloneServiceReviews(reviews []ServiceReview) []ServiceReview {
	out := make([]ServiceReview, 0, len(reviews))
	for _, review := range reviews {
		copied := review
		copied.Contexts = append([]string{}, review.Contexts...)
		copied.Operations = append([]ServiceOperationReview{}, review.Operations...)
		out = append(out, copied)
	}
	return out
}
