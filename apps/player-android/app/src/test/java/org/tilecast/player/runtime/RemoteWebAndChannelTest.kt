package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.PlayerManifest

class RemoteWebCallHandlerTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun call(call: String, payload: JsonObject) =
        HostChannel.PageMessage.Call("req1", call, payload)

    private fun pagePayload(url: String = "https://example.com/a") = buildJsonObject {
        put("surfaceId", "s1")
        putJsonObject("content") {
            put("kind", "page")
            put("url", url)
            put("allowedHosts", kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive("example.com"))))
            put("javascriptEnabled", true)
            put("domStorageEnabled", true)
            put("cookiePolicy", "first_party")
            put("userAgent", "")
            put("zoomPercent", 100)
            put("scrollX", 0)
            put("scrollY", 0)
            put("backgroundColor", "#000000")
        }
        putJsonObject("viewport") {
            put("x", 0.0)
            put("y", 0.0)
            put("width", 1920.0)
            put("height", 1080.0)
            put("deviceScale", 1.0)
        }
        put("muted", false)
        put("visible", true)
    }

    @Test fun createsPageSurfaceAsHostLayer() {
        val tracker = RemoteWebHostManager.Tracker(7)
        val outcome = RemoteWebCallHandler.handle(call("remoteWeb.create", pagePayload()), tracker, 7)
        assertTrue(outcome is RemoteWebCallHandler.CallOutcome.Created)
        assertEquals(1, tracker.snapshot().size)
    }

    @Test fun refusesDisallowedNavigationTargets() {
        val tracker = RemoteWebHostManager.Tracker(7)
        val outcome = RemoteWebCallHandler.handle(
            call("remoteWeb.create", pagePayload("javascript:alert(1)")), tracker, 7,
        )
        assertTrue(outcome is RemoteWebCallHandler.CallOutcome.Refused)
        assertEquals("bad_content", (outcome as RemoteWebCallHandler.CallOutcome.Refused).code)
        assertTrue(tracker.snapshot().isEmpty())
    }

    @Test fun refusesUnknownCallsAndStaleGenerations() {
        val tracker = RemoteWebHostManager.Tracker(7)
        assertTrue(
            RemoteWebCallHandler.handle(call("setup.submitServerUrl", buildJsonObject {}), tracker, 7)
                is RemoteWebCallHandler.CallOutcome.Refused,
        )
        assertTrue(
            RemoteWebCallHandler.handle(call("remoteWeb.create", pagePayload()), tracker, 9)
                is RemoteWebCallHandler.CallOutcome.Refused,
        )
    }

    @Test fun appliesOpsAndUnknownSurfaces() {
        val tracker = RemoteWebHostManager.Tracker(7)
        RemoteWebCallHandler.handle(call("remoteWeb.create", pagePayload()), tracker, 7)
        val viewportOp = buildJsonObject {
            put("surfaceId", "s1")
            putJsonObject("viewport") {
                put("x", 10.0)
                put("y", 10.0)
                put("width", 100.0)
                put("height", 100.0)
                put("deviceScale", 2.0)
            }
        }
        assertTrue(
            RemoteWebCallHandler.handle(call("remoteWeb.updateViewport", viewportOp), tracker, 7)
                is RemoteWebCallHandler.CallOutcome.Ack,
        )
        assertEquals(20, tracker.snapshot().single().viewportPx.x)
        assertTrue(
            RemoteWebCallHandler.handle(call("remoteWeb.destroy", viewportOp), tracker, 7)
                is RemoteWebCallHandler.CallOutcome.Ack,
        )
        assertTrue(
            RemoteWebCallHandler.handle(call("remoteWeb.destroy", viewportOp), tracker, 7)
                is RemoteWebCallHandler.CallOutcome.Refused,
        )
    }

    @Test fun malformedShapesAreRefusedNeverThrown() {
        val tracker = RemoteWebHostManager.Tracker(7)
        val badPayload = Json.parseToJsonElement(
            """{"surfaceId":{},"content":[],"viewport":1,"muted":"yes"}""",
        ).jsonObject
        val outcome = RemoteWebCallHandler.handle(
            HostChannel.PageMessage.Call("c", "remoteWeb.create", badPayload), tracker, 7,
        )
        assertTrue(outcome is RemoteWebCallHandler.CallOutcome.Refused)
        assertNull(HostChannel.parsePageMessage("""{"type":"host-call","id":{},"call":"x","payload":{}}"""))
    }

    @Test fun advertisesHostViewWithoutSetupOrDiscovery() {
        val caps = RemoteWebCallHandler.capabilities()
        assertEquals("host-view", caps["remoteWeb"])
        assertEquals(true, caps["synchronizedPlayback"])
        assertEquals(false, caps["setup"])
        assertEquals(false, caps["discovery"])
    }
}

class HostChannelTest {
    @Test fun parsesStateWantCallAndReports() {
        val want = HostChannel.parsePageMessage("""{"type":"host-state","wantGeneration":4}""")
        assertEquals(HostChannel.PageMessage.StateWant(4L), want)
        val call = HostChannel.parsePageMessage("""{"type":"host-call","id":"c1","call":"remoteWeb.reload","payload":{"surfaceId":"s1"}}""")
        assertTrue(call is HostChannel.PageMessage.Call)
        val report = HostChannel.parsePageMessage("""{"type":"evidence","kind":"image-shown"}""")
        assertTrue(report is HostChannel.PageMessage.Report)
        assertNull(HostChannel.parsePageMessage("""{"type":"host-call","id":"","call":"x","payload":{}}"""))
        assertNull(HostChannel.parsePageMessage(""))
        assertNull(HostChannel.parsePageMessage("""{"type":{}}"""))
    }

    @Test fun buildsStateBundleAndCallResults() {
        val bundle = Json.parseToJsonElement(
            HostChannel.stateBundle(3, listOf(buildJsonObject { put("type", "plugins") })),
        ).jsonObject
        assertEquals(3, bundle["generation"]!!.jsonPrimitive.content.toInt())
        assertEquals("plugins", bundle["messages"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
        val ok = Json.parseToJsonElement(HostChannel.callResult("c1", true, null, null)).jsonObject
        assertEquals(true, ok["ok"]!!.jsonPrimitive.content.toBoolean())
        val refused = Json.parseToJsonElement(HostChannel.callResult("c1", false, null, "bad_content")).jsonObject
        assertEquals("bad_content", refused["code"]!!.jsonPrimitive.content)
        val event = Json.parseToJsonElement(HostChannel.remoteEvent("s1", "loaded", null)).jsonObject
        assertEquals("host-event", event["type"]!!.jsonPrimitive.content)
    }

    @Test fun nudgeCarriesNumbersOnly() {
        assertEquals("__tilecastHostNudge(7);", RuntimeBridgeProtocol.nudgeJs(7))
        assertEquals("__tilecastHostNudge(0);", RuntimeBridgeProtocol.nudgeJs(-3))
    }

    @Test fun installScriptPublishesContractHostNeutrally() {
        val script = HostChannel.installScript("0.25.0+", "WebView/1\";evil()")
        assertTrue(script.contains("tilecastRuntimeHost"))
        assertTrue(script.contains("host:\"android\""))
        assertTrue(script.contains("remoteWeb:\"host-view\"") || script.contains("\"host-view\""))
        assertFalse(script.contains("evil()"))
        assertFalse(script.contains("if (host =="))
        assertTrue(script.contains("resolve({ok:true,target:message.result})"))
        assertFalse(script.contains("id:\"\""))
    }
}

class RuntimeEvidenceRouterTest {
    private val items = listOf(
        ManifestItem("i1", "a1", "v1", "image", 10_000, "contain", "none", false, 0.5f, deliveryPolicy = "cache"),
    )

    private inner class Sink(
        val widgetProviders: Map<String, String> = emptyMap(),
        val websiteAssets: Set<String> = emptySet(),
    ) {
        val boundaries = mutableListOf<Pair<String, String>>()
        val errors = mutableListOf<String>()
        val itemErrors = mutableListOf<Pair<String?, String>>()
        var progress = 0
        val firstFrames = mutableListOf<String>()
        val widgetStatuses = mutableListOf<org.tilecast.player.content.WidgetPlaybackStatus>()
        val websiteStatuses = mutableListOf<org.tilecast.player.content.WebsitePlaybackStatus>()
        fun router(activation: String) = RuntimeEvidenceRouter(
            items, activation,
            onBoundary = { id, asset -> boundaries.add(id to asset) },
            onError = { errors.add(it) },
            onProgress = { progress++ },
            onFirstFrame = { firstFrames.add(it) },
            onPlaybackError = { itemId, message -> itemErrors.add(itemId to message) },
            onWidgetStatus = { widgetStatuses.add(it) },
            onWebsiteStatus = { websiteStatuses.add(it) },
            widgetProviders = widgetProviders,
            websiteAssets = websiteAssets,
        )
    }

    @Test fun routesBoundariesProgressAndFirstFrameOnce() {
        val sink = Sink()
        val router = sink.router("act1")
        assertTrue(router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "i1", "item-started", null), "act1"))
        assertEquals(listOf("i1" to "a1"), sink.boundaries)
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "i1", "image-shown", null), "act1")
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "i1", "image-shown", null), "act1")
        assertEquals(listOf("i1"), sink.firstFrames)
        assertTrue(sink.progress >= 2)
    }

    @Test fun dropsStaleActivationsAndSurfacesErrors() {
        val sink = Sink()
        val router = sink.router("act1")
        assertFalse(router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act0", "i1", "item-started", null), "act0"))
        assertTrue(sink.boundaries.isEmpty())
        assertFalse(router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence(null, "i1", "item-started", null), null))
        assertTrue(sink.boundaries.isEmpty())
        router.handle(RuntimeBridgeProtocol.RuntimeReport.PresentationResult("act1", "rejected"), "act1")
        router.handle(RuntimeBridgeProtocol.RuntimeReport.PlaybackError("act1", "i1", "boom"), "act1")
        assertEquals(listOf("shared presentation rejected", "boom"), sink.errors)
        assertEquals(listOf("i1" to "boom"), sink.itemErrors)
    }

    @Test fun authoritativeRoutingCoversEveryPresentableKind() {
        // No cutover gate remains: renderability alone decides, and anything
        // else fails closed with an explicit error upstream.
        val manifest = PlayerManifest(
            15, 1, "s", "t", "single-zone",
            assets = listOf(ManifestAsset("a1", "v1", "image/png", "sha", 100, downloadPath = "/dl")),
        )
        for (item in items) {
            assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, item))
        }
    }

    @Test fun publishesWidgetAndWebsiteStatusFromEvidence() {
        val widgetItems = listOf(
            ManifestItem("w1", "widget-1", null, "widget", 5_000, "contain", "none", false, 0f, deliveryPolicy = "stream"),
            ManifestItem("s1", "site-1", null, "website", 10_000, "contain", "none", false, 0f, deliveryPolicy = "stream"),
        )
        val statuses = mutableListOf<org.tilecast.player.content.WidgetPlaybackStatus>()
        val siteStatuses = mutableListOf<org.tilecast.player.content.WebsitePlaybackStatus>()
        val router = RuntimeEvidenceRouter(
            widgetItems, "act1",
            onBoundary = { _, _ -> },
            onError = {},
            onProgress = {},
            onWidgetStatus = { statuses.add(it) },
            onWebsiteStatus = { siteStatuses.add(it) },
            widgetProviders = mapOf("widget-1" to "clock"),
            websiteAssets = setOf("site-1"),
        )
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "w1", "widget-shown", null), "act1")
        assertEquals(listOf(Triple("widget-1", "clock", "shown")), statuses.map { Triple(it.widgetId, it.provider, it.state) })
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "s1", "website-loaded", null), "act1")
        assertEquals(listOf(Pair("site-1", "loaded")), siteStatuses.map { it.assetId to it.state })
        // Image evidence publishes no status; unknown assets stay silent.
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "i1", "image-shown", null), "act1")
        assertTrue(statuses.size == 1 && siteStatuses.size == 1)
        router.handle(RuntimeBridgeProtocol.RuntimeReport.PlaybackError("act1", "w1", "boom"), "act1")
        assertEquals("error", statuses.last().state)
        assertEquals("boom", statuses.last().error)
        router.handle(RuntimeBridgeProtocol.RuntimeReport.PlaybackError("act1", "s1", "tls"), "act1")
        assertEquals("failed", siteStatuses.last().state)
        assertEquals("tls", siteStatuses.last().failureCategory)
    }

    @Test fun itemStartAndActivationReplaceClearStaleStatuses() {
        val mixed = listOf(
            ManifestItem("w1", "widget-1", null, "widget", 5_000, "contain", "none", false, 0f, deliveryPolicy = "stream"),
            ManifestItem("i1", "a1", "v1", "image", 10_000, "contain", "none", false, 0f, deliveryPolicy = "cache"),
        )
        val statuses = mutableListOf<org.tilecast.player.content.WidgetPlaybackStatus>()
        val siteStatuses = mutableListOf<org.tilecast.player.content.WebsitePlaybackStatus>()
        val router = RuntimeEvidenceRouter(
            mixed, "act1",
            onBoundary = { _, _ -> },
            onError = {},
            onProgress = {},
            onWidgetStatus = { statuses.add(it) },
            onWebsiteStatus = { siteStatuses.add(it) },
            widgetProviders = mapOf("widget-1" to "clock"),
            websiteAssets = emptySet(),
        )
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "w1", "widget-shown", null), "act1")
        assertEquals("widget-1", statuses.last().widgetId)
        // Rebinding the same activation (state replay) clears nothing.
        router.replace(mixed, "act1", mapOf("widget-1" to "clock"), emptySet())
        assertEquals(1, statuses.size)
        // A later image item displaces the Widget: the stale widgetId must
        // go so the foreground watchdog resumes.
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "i1", "item-started", null), "act1")
        assertEquals(null, statuses.last().widgetId)
        // Activation replacement disposes the presentation: both clear.
        router.handle(RuntimeBridgeProtocol.RuntimeReport.Evidence("act1", "w1", "widget-shown", null), "act1")
        router.replace(mixed, "act2", mapOf("widget-1" to "clock"), emptySet())
        assertEquals(null, statuses.last().widgetId)
        assertEquals(null, siteStatuses.last().assetId)
    }

    @Test fun authoritativeRoutingResolvesThreadedRootLayouts() {
        val document = org.tilecast.player.network.LayoutDocument(
            schemaVersion = 1,
            canvas = org.tilecast.player.network.LayoutCanvas(1920, 1080, "landscape", "#000000"),
        )
        val layout = org.tilecast.player.network.ManifestLayout("l1", "r1", 1, "hash", document)
        val manifest = PlayerManifest(
            15, 1, "s", "t", "single-zone",
            assets = listOf(ManifestAsset("a1", "v1", "image/png", "sha", 100, downloadPath = "/dl")),
            layout = layout,
            layouts = listOf(layout),
        )
        val rootItems = listOf(org.tilecast.player.content.rootLayoutItem(layout))
        // The threaded Layout wins on id match so selected roots outside
        // manifest.layouts resolve; anything else falls back to the list.
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, rootItems[0], layout))
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, rootItems[0]))
        val other = layout.copy(id = "l2")
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, rootItems[0], other))
    }
}
