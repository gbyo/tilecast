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
        assertFalse(script.contains('id:""'))
    }
}

class RuntimeEvidenceRouterTest {
    private val items = listOf(
        ManifestItem("i1", "a1", "v1", "image", 10_000, "contain", "none", false, 0.5f, deliveryPolicy = "cache"),
    )

    private inner class Sink {
        val boundaries = mutableListOf<Pair<String, String>>()
        val errors = mutableListOf<String>()
        var progress = 0
        val firstFrames = mutableListOf<String>()
        fun router(activation: String) = RuntimeEvidenceRouter(
            items, activation,
            onBoundary = { id, asset -> boundaries.add(id to asset) },
            onError = { errors.add(it) },
            onProgress = { progress++ },
            onFirstFrame = { firstFrames.add(it) },
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
    }

    @Test fun cutoverStaysOffUntilValidated() {
        val manifest = PlayerManifest(
            15, 1, "s", "t", "single-zone",
            assets = listOf(ManifestAsset("a1", "v1", "image/png", "sha", 100, downloadPath = "/dl")),
        )
        val cached = org.tilecast.player.content.PreparedContent(manifest, mapOf("v1" to "/tmp/v1"))
        val uncached = org.tilecast.player.content.PreparedContent(manifest, emptyMap())
        assertFalse(RuntimeCutover.enabled)
        assertFalse(RuntimeCutover.useSharedRuntime(cached, items))
        RuntimeCutover.enabled = true
        try {
            assertTrue(RuntimeCutover.useSharedRuntime(cached, items))
            assertFalse(RuntimeCutover.useSharedRuntime(uncached, items))
            assertFalse(RuntimeCutover.useSharedRuntime(cached, emptyList()))
        } finally {
            RuntimeCutover.enabled = false
        }
    }
}
