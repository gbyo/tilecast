package org.tilecast.player.content

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.DataDocument
import org.tilecast.player.network.PlayerPresentationSupport
import org.tilecast.player.network.WidgetPresentation

class DeclarativeContractTest {
    private val json = Json { ignoreUnknownKeys = false }

    @Test
    fun decodesTypedDataWithoutProviderMetadata() {
        val document = json.decodeFromString<DataDocument>(
            """{"schemaVersion":1,"datasets":[{"id":"records","kind":"records","fields":[{"key":"value","label":"Value","type":"number"}],"records":[{"id":"one","values":{"value":{"kind":"number","number":42.5}}}],"cache":{"usingCachedData":false,"unavailable":false}}]}"""
        )
        assertEquals(42.5, document.datasets.single().records.single().values.getValue("value").number!!, 0.0)
    }

    @Test
    fun capabilitiesCoverClosedNodeRuntime() {
        val presentation = json.decodeFromString<WidgetPresentation>(
            """{"schemaVersion":1,"kind":"native","requiredCapabilities":{"layout.surface":1,"content.text":1},"native":{"root":{"type":"surface","children":[{"type":"text","binding":{"source":"literal","value":"Hello"}}]}}}"""
        )
        assertTrue(presentation.requiredCapabilities.all { (name, version) -> (PlayerPresentationSupport.native[name] ?: 0) >= version })
    }

    @Test
    fun decodesMultiSeriesTimeDataAndAdvancedBindings() {
        val document = json.decodeFromString<DataDocument>(
            """{"schemaVersion":1,"datasets":[{"id":"hourly","kind":"time_series","fields":[{"key":"pm2_5","label":"PM2.5","type":"number"},{"key":"aqi","label":"AQI","type":"integer"}],"points":[{"at":"2026-07-16T12:00:00Z","values":{"pm2_5":{"kind":"number","number":8.5},"aqi":{"kind":"integer","integer":42}}}],"cache":{"usingCachedData":false,"unavailable":false}}]}"""
        )
        assertEquals(8.5, document.datasets.single().points.single().values.getValue("pm2_5").number!!, 0.0)
        val presentation = json.decodeFromString<WidgetPresentation>(
            """{"schemaVersion":1,"kind":"native","requiredCapabilities":{"content.line_chart":2,"binding.core":2},"native":{"root":{"type":"line_chart","binding":{"source":"dataset","dataset":"source:hourly","fields":["pm2_5","aqi"]}}}}"""
        )
        assertTrue(presentation.requiredCapabilities.all { (name, version) -> (PlayerPresentationSupport.native[name] ?: 0) >= version })
    }

    @Test
    fun advancedPrimitiveCapabilitiesAreVersioned() {
        assertTrue((PlayerPresentationSupport.native["content.asset_image"] ?: 0) >= 2)
        assertTrue((PlayerPresentationSupport.native["content.progress"] ?: 0) >= 2)
        assertTrue((PlayerPresentationSupport.native["content.donut_chart"] ?: 0) >= 2)
        assertTrue((PlayerPresentationSupport.native["collection.conditional"] ?: 0) >= 2)
    }

    @Test
    fun decodesBoundedPeriodicWebReload() {
        val presentation = json.decodeFromString<WidgetPresentation>(
            """{"schemaVersion":1,"kind":"web","requiredCapabilities":{"web.remote":2},"web":{"mode":"remote","url":"https://docs.google.com/presentation/d/example/embed","allowedHosts":["docs.google.com"],"externalNetworkAccess":true,"onlineOnly":true,"fallbackBehavior":"placeholder","loadTimeoutSeconds":30,"lifecycle":"keep_warm","warmSeconds":60,"reload":{"mode":"periodic","intervalSeconds":900}}}"""
        )
        assertEquals(2, PlayerPresentationSupport.webRuntimeVersion)
        assertEquals("periodic", presentation.web?.reload?.mode)
        assertEquals(900, presentation.web?.reload?.intervalSeconds)
    }
}
