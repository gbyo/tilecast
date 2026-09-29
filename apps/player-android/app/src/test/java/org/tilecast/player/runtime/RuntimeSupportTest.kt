package org.tilecast.player.runtime

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

    @Test fun probeResultParsesOnlyFullPasses() {
        val allTrue = "\"" +
            "{\"customElements\":true,\"shadowDOM\":true,\"adoptedStyleSheets\":true," +
            "\"containerQueries\":true,\"containerUnits\":true,\"cspBlocksInlineStyle\":true," +
            "\"cssomStyle\":true,\"webAnimations\":true}" + "\""
        assertTrue(RuntimeComponentProbe.parseResult(allTrue))
        val oneFalse = "\"" +
            "{\"customElements\":true,\"shadowDOM\":false,\"adoptedStyleSheets\":true," +
            "\"containerQueries\":true,\"containerUnits\":true,\"cspBlocksInlineStyle\":true," +
            "\"cssomStyle\":true,\"webAnimations\":true}" + "\""
        assertFalse(RuntimeComponentProbe.parseResult(oneFalse))
        assertFalse(RuntimeComponentProbe.parseResult(null))
        assertFalse(RuntimeComponentProbe.parseResult("null"))
        assertFalse(RuntimeComponentProbe.parseResult("\"not-json\""))
        assertFalse(RuntimeComponentProbe.parseResult("\"{}\""))
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
