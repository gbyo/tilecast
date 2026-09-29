package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeSupportTest {
    @Test fun trustedRequiresBothBridgeFeatures() {
        val full = RuntimeSupportAssessment.assess(isFeatureSupported = { true })
        assertTrue(full.trustedRuntimeSupported)
        assertFalse(full.componentRuntimeSupported)

        val missing = RuntimeSupportAssessment.assess(isFeatureSupported = { feature ->
            feature != androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT
        })
        assertFalse(missing.trustedRuntimeSupported)
        assertFalse(missing.componentRuntimeSupported)
    }

    @Test fun componentRequiresTrustedPlusProbe() {
        val probed = RuntimeSupportAssessment.assess(
            isFeatureSupported = { true },
            componentProbePassed = true,
        )
        assertTrue(probed.trustedRuntimeSupported)
        assertTrue(probed.componentRuntimeSupported)

        // A probe result alone never suffices without the trusted bridge.
        val untrusted = RuntimeSupportAssessment.assess(
            isFeatureSupported = { false },
            componentProbePassed = true,
        )
        assertFalse(untrusted.trustedRuntimeSupported)
        assertFalse(untrusted.componentRuntimeSupported)
    }

    @Test fun sdkLevelAloneNeverGrantsSupport() {
        // The assessment takes no SDK input: an exception in feature
        // detection fails closed instead of assuming support.
        val failed = RuntimeSupportAssessment.assess(isFeatureSupported = { throw RuntimeException("gone") })
        assertFalse(failed.trustedRuntimeSupported)
        assertFalse(failed.componentRuntimeSupported)
    }

    @Test fun advertisesSchemasAndCapabilitiesTruthfully() {
        val legacy = mapOf("layout.surface" to 1)
        val generated = mapOf("widget.tilecast.clock" to 1)

        val component = RuntimeSupport(trustedRuntimeSupported = true, componentRuntimeSupported = true)
        assertEquals(listOf(1, 2), RuntimeSupportAssessment.schemasFor(component))
        assertEquals(
            mapOf("layout.surface" to 1, "widget.tilecast.clock" to 1),
            RuntimeSupportAssessment.nativeCapabilitiesFor(component, legacy, generated),
        )

        val compatOnly = RuntimeSupport(trustedRuntimeSupported = true, componentRuntimeSupported = false)
        assertEquals(listOf(1), RuntimeSupportAssessment.schemasFor(compatOnly))
        assertEquals(legacy, RuntimeSupportAssessment.nativeCapabilitiesFor(compatOnly, legacy, generated))
    }

    @Test fun unsupportedRuntimeAdvertisesNothing() {
        // No fallback renderer exists: claiming schema 1 here would let
        // the server negotiate content this build cannot render.
        val unsupported = RuntimeSupport(trustedRuntimeSupported = false, componentRuntimeSupported = false)
        assertEquals(emptyList<Int>(), RuntimeSupportAssessment.schemasFor(unsupported))
        assertEquals(
            emptyMap<String, Int>(),
            RuntimeSupportAssessment.nativeCapabilitiesFor(
                unsupported,
                mapOf("layout.surface" to 1),
                mapOf("widget.tilecast.clock" to 1),
            ),
        )
    }

    @Test fun probeResultParsesOnlyFullPasses() {
        // evaluateJavascript delivers the script result JSON-encoded, so the
        // outer string carries escaped quotes; encode the same way here.
        fun probeRaw(flags: Map<String, Boolean>): String {
            val inner = buildJsonObject { flags.forEach { (k, v) -> put(k, v) } }.toString()
            return Json.encodeToString(JsonPrimitive(inner))
        }
        val all = mapOf(
            "customElements" to true, "shadowDOM" to true, "adoptedStyleSheets" to true,
            "containerQueries" to true, "containerUnits" to true, "cspBlocksInlineStyle" to true,
            "cssomStyle" to true, "webAnimations" to true,
        )
        assertTrue(RuntimeComponentProbe.parseResult(probeRaw(all)))
        assertFalse(RuntimeComponentProbe.parseResult(probeRaw(all + ("shadowDOM" to false))))
        assertFalse(RuntimeComponentProbe.parseResult(probeRaw(emptyMap())))
        assertFalse(RuntimeComponentProbe.parseResult(null))
        assertFalse(RuntimeComponentProbe.parseResult("null"))
        assertFalse(RuntimeComponentProbe.parseResult(Json.encodeToString(JsonPrimitive("not-json"))))
        // A bare object is not a script result and must fail closed.
        assertFalse(RuntimeComponentProbe.parseResult(all.toString()))
    }

    @Test fun probeOutcomeGatesComponentAdvertisement() {
        RuntimeComponentProbe.record(false)
        var support = RuntimeSupportAssessment.assess(
            isFeatureSupported = { true },
            componentProbePassed = RuntimeComponentProbe.passed,
        )
        assertFalse(support.componentRuntimeSupported)
        assertEquals(listOf(1), RuntimeSupportAssessment.schemasFor(support))
        RuntimeComponentProbe.record(true)
        try {
            support = RuntimeSupportAssessment.assess(
                isFeatureSupported = { true },
                componentProbePassed = RuntimeComponentProbe.passed,
            )
            assertTrue(support.componentRuntimeSupported)
            assertEquals(listOf(1, 2), RuntimeSupportAssessment.schemasFor(support))
        } finally {
            RuntimeComponentProbe.record(false)
        }
    }

    @Test fun generatedCapabilitiesMatchWidgetDiscovery() {
        val caps = WidgetComponentCapabilities.WIDGET_COMPONENT_CAPABILITIES
        assertTrue(caps.isNotEmpty())
        assertTrue(caps.keys.all { it.startsWith("widget.") })
        assertTrue(caps.values.all { it in 1..100 })
        assertEquals(2, WidgetComponentCapabilities.COMPONENT_PRESENTATION_SCHEMA_VERSION)
        assertTrue((caps["widget.tilecast.clock"] ?: 0) >= 1)
    }
}
