// Automation describes the resolved operator mapping a plugin embeds.
//
// A plugin with an HTTP API maps its existing operations to automation
// presentation in automation.yaml (Automation Contract v1). pluginctl
// validates that file and resolves it against the plugin's own OpenAPI
// fragment into automation.gen.json, which the plugin embeds and the
// host serves to operator clients. The resolved document redefines no
// HTTP path, schema, authorization, or validation; the server stays
// authoritative for all of those.
package plugin

import (
	"encoding/json"
	"fmt"
)

// AutomationProvider is implemented by plugins that expose their API to
// operator automation. Automation returns the embedded resolved document
// (automation.gen.json). A plugin without an automation mapping does not
// implement this interface, and operator clients treat it as having no
// automation surface.
type AutomationProvider interface {
	Automation() []byte
}

// AutomationRisk is one class of the durable risk model. Risk annotations
// describe; the server authorizes.
type AutomationRisk string

// Automation risks, matching Automation Contract v1. Break-glass is
// absent by construction: local recovery never enters automation.
const (
	AutomationRead             AutomationRisk = "read"
	AutomationRoutine          AutomationRisk = "routine"
	AutomationSensitive        AutomationRisk = "sensitive"
	AutomationHighImpact       AutomationRisk = "high-impact"
	AutomationSecurityCritical AutomationRisk = "security-critical"
)

// AutomationOperation is one automated operation with its HTTP binding.
type AutomationOperation struct {
	OperationID string         `json:"operationId"`
	Method      string         `json:"method"`
	Path        string         `json:"path"`
	Risk        AutomationRisk `json:"risk"`
	CLIPath     []string       `json:"cliPath"`
	MCPAction   string         `json:"mcpAction"`
	Input       string         `json:"input,omitempty"`
	Description string         `json:"description,omitempty"`
}

// AutomationExclusion is an operation that stays out of automation, with
// the reason stated.
type AutomationExclusion struct {
	OperationID string `json:"operationId"`
	Reason      string `json:"reason"`
}

// Automation is a plugin's resolved automation document.
type Automation struct {
	APIVersion int                   `json:"apiVersion"`
	Plugin     string                `json:"plugin"`
	Operations []AutomationOperation `json:"operations"`
	Exclusions []AutomationExclusion `json:"exclusions"`
}

// ParseAutomation validates embedded automation bytes. It reports a build
// defect, not a runtime condition: the file is generated from a document
// pluginctl already validated, so an error here means the embedded copy
// went stale or was edited by hand.
func ParseAutomation(data []byte) (Automation, error) {
	var document Automation
	if err := json.Unmarshal(data, &document); err != nil {
		return Automation{}, fmt.Errorf("automation: invalid JSON: %w", err)
	}
	if document.APIVersion != 1 {
		return Automation{}, fmt.Errorf("automation: unsupported apiVersion %d", document.APIVersion)
	}
	if document.Plugin == "" {
		return Automation{}, fmt.Errorf("automation: plugin id is required")
	}
	if len(document.Operations) == 0 {
		return Automation{}, fmt.Errorf("automation: at least one operation is required")
	}
	seen := make(map[string]struct{}, len(document.Operations))
	for i, operation := range document.Operations {
		where := fmt.Sprintf("automation: operations[%d]", i)
		if operation.OperationID == "" {
			return Automation{}, fmt.Errorf("%s: operationId is required", where)
		}
		if _, ok := seen[operation.OperationID]; ok {
			return Automation{}, fmt.Errorf("%s: duplicate operationId %q", where, operation.OperationID)
		}
		seen[operation.OperationID] = struct{}{}
		switch operation.Method {
		case "get", "post", "put", "patch", "delete":
		default:
			return Automation{}, fmt.Errorf("%s: unsupported method %q", where, operation.Method)
		}
		if operation.Path == "" || operation.Path[0] != '/' {
			return Automation{}, fmt.Errorf("%s: path must be an absolute path", where)
		}
		switch operation.Risk {
		case AutomationRead, AutomationRoutine, AutomationSensitive, AutomationHighImpact, AutomationSecurityCritical:
		default:
			return Automation{}, fmt.Errorf("%s: unknown risk %q", where, operation.Risk)
		}
		if len(operation.CLIPath) == 0 {
			return Automation{}, fmt.Errorf("%s: cliPath needs at least one segment", where)
		}
		if operation.MCPAction == "" {
			return Automation{}, fmt.Errorf("%s: mcpAction is required", where)
		}
	}
	for _, exclusion := range document.Exclusions {
		if exclusion.OperationID == "" || exclusion.Reason == "" {
			return Automation{}, fmt.Errorf("automation: exclusions need an operationId and a reason")
		}
		if _, ok := seen[exclusion.OperationID]; ok {
			return Automation{}, fmt.Errorf("automation: exclusion %q is also automated", exclusion.OperationID)
		}
	}
	return document, nil
}
