package org.tilecast.player.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.PlayerPresentationSupport
import org.tilecast.player.network.PresentationCapabilities
import org.tilecast.player.runtime.RuntimeSupport
import org.tilecast.player.runtime.WidgetComponentCapabilities

/**
 * Parity between the ready report the live renderer sends and the contract the
 * native crate prepares manifests against.
 *
 * `apps/player-android/renderer-profile.json` is the one definition. This test
 * rebuilds the expected report from that file plus the generated capability
 * tables, independently of how [RendererReadyReport] assembles it; the Rust
 * `packaged_profile_equals_the_live_report_contract` test rebuilds the same
 * report for the packaged profile. Both fail the build when either side adds,
 * drops, or renumbers a capability alone.
 */
class RendererReadyReportTest {
    private val full = RuntimeSupport(trustedRuntimeSupported = true, componentRuntimeSupported = true)
    private val compatOnly = RuntimeSupport(trustedRuntimeSupported = true, componentRuntimeSupported = false)
    private val untrusted = RuntimeSupport(trustedRuntimeSupported = false, componentRuntimeSupported = false)

    private val contract: JsonObject by lazy {
        // Gradle runs unit tests with the module directory as the working directory.
        val file = listOf("../renderer-profile.json", "apps/player-android/renderer-profile.json")
            .map(::File).first { it.isFile }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    /**
     * The Plugin API v2 host and the Shared Runtime services, read from the
     * canonical vocabulary rather than from the generated constants: a
     * service with a `hostCapability` needs host help, which Android does
     * not provide yet.
     */
    private val pluginServices: JsonObject by lazy {
        val file = listOf(
            "../../../packages/plugin-sdk/player-services.json",
            "packages/plugin-sdk/player-services.json",
        ).map(::File).first { it.isFile }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun expectedPluginCapabilities(): Map<String, Int> {
        val host = pluginServices["host"]!!.jsonObject
        val services = pluginServices["services"]!!.jsonArray.map { it.jsonObject }
            .filter {
                it["execution"]!!.jsonPrimitive.content == "runtime" && it["hostCapability"] == null
            }
            .associate { it["name"]!!.jsonPrimitive.content to it["version"]!!.jsonPrimitive.int }
        return services + (host["capability"]!!.jsonPrimitive.content to host["version"]!!.jsonPrimitive.int)
    }

    private fun report(support: RuntimeSupport): JsonObject =
        Json.parseToJsonElement(RendererReadyReport.build(7, support)).jsonObject["report"]!!.jsonObject

    private fun names(array: JsonArray) = array.map { it.jsonPrimitive.content }

    private fun table(value: JsonObject) = value.mapValues { it.value.jsonPrimitive.int }

    @Test fun aFullySupportedRendererAdvertisesExactlyTheContract() {
        val sent = report(full)
        assertEquals(names(contract["features"]!!.jsonArray), names(sent["features"]!!.jsonArray))

        val support = sent["support"]!!.jsonObject
        val schemas = contract["presentationSchemas"]!!.jsonObject
        assertEquals(
            (schemas["baseline"]!!.jsonArray + schemas["componentRuntime"]!!.jsonArray).map { it.jsonPrimitive.int },
            support["presentationSchemas"]!!.jsonArray.map { it.jsonPrimitive.int },
        )

        val webRemote = contract["webRemote"]!!.jsonObject
        val declarative = PresentationCapabilities.SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES +
            (webRemote["name"]!!.jsonPrimitive.content to webRemote["version"]!!.jsonPrimitive.int) +
            expectedPluginCapabilities()
        assertEquals(declarative, table(support["declarativeCapabilities"]!!.jsonObject))

        val external = contract["externalWidgetRuntime"]!!.jsonObject
        val widgets = WidgetComponentCapabilities.WIDGET_COMPONENT_CAPABILITIES +
            (external["name"]!!.jsonPrimitive.content to external["version"]!!.jsonPrimitive.int)
        assertEquals(widgets, table(support["widgetComponents"]!!.jsonObject))
    }

    @Test fun theLiveReportAdvertisesEveryFeatureAndCapabilityPreparationAccepts() {
        val features = names(report(full)["features"]!!.jsonArray)
        // The packaged profile accepts these plugins; the live report once omitted them.
        assertTrue("plugin.countdown_bar" in features)
        assertTrue("plugin.alert_ticker" in features)
        // No surface exists for the retired plugin.
        assertFalse("plugin.brand_bug" in features)

        // environment.time is in the shared runtime table but not the legacy baseline.
        val declarative = table(report(full)["support"]!!.jsonObject["declarativeCapabilities"]!!.jsonObject)
        assertEquals(1, declarative["environment.time"])
        assertTrue(PresentationCapabilities.BASELINE_DECLARATIVE_PRESENTATION_CAPABILITIES.keys.none { it == "environment.time" })
        assertEquals(PlayerPresentationSupport.webRuntimeVersion, declarative["web.remote"])
    }

    @Test fun anUnprovenComponentRuntimeAdvertisesOnlyTheBaseline() {
        val support = report(compatOnly)["support"]!!.jsonObject
        assertEquals(listOf(1), support["presentationSchemas"]!!.jsonArray.map { it.jsonPrimitive.int })
        assertTrue(support["widgetComponents"]!!.jsonObject.isEmpty())
        assertTrue(support["declarativeCapabilities"]!!.jsonObject.isNotEmpty())
    }

    @Test fun anUntrustedRuntimeAdvertisesNoSupportAtAll() {
        val support = report(untrusted)["support"]!!.jsonObject
        assertTrue(support["presentationSchemas"]!!.jsonArray.isEmpty())
        assertTrue(support["declarativeCapabilities"]!!.jsonObject.isEmpty())
        assertTrue(support["widgetComponents"]!!.jsonObject.isEmpty())
    }

    @Test fun hostPinnedVersionsMatchTheSharedFixturesAndGeneratedTables() {
        val frames = listOf("../../../packages/player-contracts/fixtures/widget-frames.json", "packages/player-contracts/fixtures/widget-frames.json")
            .map(::File).first { it.isFile }
        val constants = Json.parseToJsonElement(frames.readText()).jsonObject["constants"]!!.jsonObject
        assertEquals(constants["capability"]!!.jsonPrimitive.content, RendererProfile.EXTERNAL_WIDGET_RUNTIME_CAPABILITY)
        assertEquals(constants["capabilityVersion"]!!.jsonPrimitive.int, RendererProfile.EXTERNAL_WIDGET_RUNTIME_VERSION)
        assertTrue(
            WidgetComponentCapabilities.COMPONENT_PRESENTATION_SCHEMA_VERSION in RendererProfile.COMPONENT_PRESENTATION_SCHEMAS,
        )
    }

    @Test fun pluginApiTwoIsAdvertisedOnlyWhereTheTrustedRuntimeRuns() {
        for (support in listOf(full, compatOnly)) {
            val declarative = table(report(support)["support"]!!.jsonObject["declarativeCapabilities"]!!.jsonObject)
            for ((name, version) in expectedPluginCapabilities()) assertEquals(name, version, declarative[name])
            // Events need a transport this host does not have.
            assertFalse("player.events" in declarative)
            // Nothing in the report names a native service this build lacks.
            assertTrue(declarative.keys.none { it.startsWith("player.reference.") })
        }
        val untrusted = table(report(untrusted)["support"]!!.jsonObject["declarativeCapabilities"]!!.jsonObject)
        assertFalse("plugin.host" in untrusted)
        assertEquals(expectedPluginCapabilities(), RendererProfile.SHARED_RUNTIME_PLAYER_SERVICES +
            (RendererProfile.PLUGIN_HOST_CAPABILITY to RendererProfile.PLUGIN_HOST_VERSION))
    }

    @Test fun theGeneratedProfileIsTheContractFile() {
        assertEquals(names(contract["features"]!!.jsonArray), RendererProfile.FEATURES)
        val webRemote = contract["webRemote"]!!.jsonObject
        assertEquals(webRemote["name"]!!.jsonPrimitive.content, RendererProfile.WEB_REMOTE_CAPABILITY)
        assertEquals(webRemote["version"]!!.jsonPrimitive.int, RendererProfile.WEB_REMOTE_VERSION)
    }
}
