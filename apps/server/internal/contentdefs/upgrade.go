package contentdefs

import (
	"encoding/json"
	"sort"
)

// UpgradeAuthorConfiguration upgrades a saved Widget configuration to the
// provider's current authoring schema (docs/widgets-v2-catalog.md §8). It
// mirrors upgradeAuthorConfiguration in packages/widget-sdk/src/upgrade.ts:
//
//  1. A schema key missing from the configuration is filled from the
//     default of its component configTemplate node when that default reads
//     a key the configuration has.
//  2. A legacy key that only such defaults read is consumed and removed.
//  3. Every other key stays; the caller validates the result.
//
// The component configTemplate is therefore the one source of a migrated
// provider's legacy key mapping. A definition without a component returns
// its configuration unchanged.
func UpgradeAuthorConfiguration(definition WidgetDefinition, configuration map[string]any) (map[string]any, []string) {
	out := make(map[string]any, len(configuration))
	for key, value := range configuration {
		out[key] = value
	}
	if definition.Component == nil {
		return out, nil
	}
	var template any
	if err := json.Unmarshal(definition.Component.ConfigTemplate, &template); err != nil {
		return out, nil
	}
	schema := map[string]bool{}
	for _, field := range definition.ConfigurationSchema.Fields {
		schema[field.Key] = true
	}
	references := map[string]map[string]any{}
	collectTemplateReferences(template, references)
	var fallbackReads []string
	for _, field := range definition.ConfigurationSchema.Fields {
		if _, present := out[field.Key]; present {
			continue
		}
		reference, ok := references[field.Key]
		if !ok {
			continue
		}
		fallback, hasFallback := reference["default"]
		if !hasFallback {
			continue
		}
		var reads []string
		collectTemplateReads(fallback, &reads)
		upgrades := false
		for _, key := range reads {
			if _, present := out[key]; present && !schema[key] {
				upgrades = true
				break
			}
		}
		if !upgrades {
			continue
		}
		value, err := resolveComponentTemplate(fallback, out)
		if err != nil || value == nil {
			continue
		}
		out[field.Key] = value
		fallbackReads = append(fallbackReads, reads...)
	}
	var allReads []string
	collectTemplateReads(template, &allReads)
	count := func(list []string, key string) int {
		n := 0
		for _, item := range list {
			if item == key {
				n++
			}
		}
		return n
	}
	var consumed []string
	seen := map[string]bool{}
	for _, key := range fallbackReads {
		if seen[key] {
			continue
		}
		seen[key] = true
		if _, present := out[key]; !present || schema[key] {
			continue
		}
		if count(fallbackReads, key) == count(allReads, key) {
			delete(out, key)
			consumed = append(consumed, key)
		}
	}
	return out, consumed
}

// TemplateReads reports every configuration key a component configTemplate
// reads. A key the template reads belongs to the provider's persisted
// contract even when no authoring field shows it.
func TemplateReads(spec ComponentSpec) map[string]bool {
	var template any
	reads := map[string]bool{}
	if err := json.Unmarshal(spec.ConfigTemplate, &template); err != nil {
		return reads
	}
	var list []string
	collectTemplateReads(template, &list)
	for _, key := range list {
		reads[key] = true
	}
	return reads
}

func isTemplateReference(value any) (map[string]any, bool) {
	node, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	_, isKey := node["$config"].(string)
	return node, isKey
}

func collectTemplateReads(value any, into *[]string) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectTemplateReads(item, into)
		}
	case map[string]any:
		if node, ok := isTemplateReference(typed); ok {
			*into = append(*into, node["$config"].(string))
			if flag, ok := node["when"].(string); ok && flag != "" {
				*into = append(*into, flag)
			}
			if fallback, ok := node["default"]; ok {
				collectTemplateReads(fallback, into)
			}
			return
		}
		for _, item := range typed {
			collectTemplateReads(item, into)
		}
	}
}

// collectTemplateReferences records the first reference node for each key,
// visiting object members in sorted key order so the TypeScript mirror
// finds the same node.
func collectTemplateReferences(value any, into map[string]map[string]any) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectTemplateReferences(item, into)
		}
	case map[string]any:
		if node, ok := isTemplateReference(typed); ok {
			key := node["$config"].(string)
			if _, exists := into[key]; !exists {
				into[key] = node
			}
			if fallback, ok := node["default"]; ok {
				collectTemplateReferences(fallback, into)
			}
			return
		}
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			collectTemplateReferences(typed[key], into)
		}
	}
}
