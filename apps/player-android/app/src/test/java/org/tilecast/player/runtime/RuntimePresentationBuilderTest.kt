package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.content.PlaybackCursor
import org.tilecast.player.content.PlaybackSession
import org.tilecast.player.content.PreparedContent
import org.tilecast.player.content.nextRuntimeActivationIdentity
import org.tilecast.player.content.runtimePlaylistItems
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestSyncGroup
import org.tilecast.player.network.ManifestWebsite
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.PlayerBranding
import org.tilecast.player.network.PlayerManifest
import org.tilecast.player.network.WebSandboxPresentation
import org.tilecast.player.network.WidgetPresentation

class RuntimePresentationBuilderTest {
    private fun item(
        id: String = "i1",
        assetId: String = "a1",
        variantId: String? = "v1",
        assetType: String = "image",
        durationMs: Long? = 10_000,
    ) = ManifestItem(
        id = id, assetId = assetId, variantId = variantId, assetType = assetType,
        durationMs = durationMs, fitMode = "contain", transition = "none",
        audioEnabled = false, volume = 0.5f, deliveryPolicy = "cache",
    )

    private fun asset(assetId: String = "a1", variantId: String = "v1", mime: String = "image/png") =
        ManifestAsset(assetId, variantId, mime, "sha", 100, downloadPath = "/dl")

    private fun manifest(
        items: List<ManifestItem> = listOf(item()),
        schemaVersion: Int = 15,
        syncGroup: ManifestSyncGroup? = null,
    ) = PlayerManifest(
        schemaVersion = schemaVersion, manifestVersion = 42, screenId = "s1",
        generatedAt = "t", mode = "single-zone",
        playlist = org.tilecast.player.network.ManifestPlaylist("p1", 1, "P", items),
        assets = listOf(asset()),
        syncGroup = syncGroup,
    )

    private fun playing(
        manifest: PlayerManifest = manifest(),
        items: List<ManifestItem>? = null,
    ) = RuntimeScreenState.Playing(
        content = PreparedContent(manifest, emptyMap()),
        items = items ?: manifest.playlist!!.items,
        fullscreenLayout = null,
        playbackDefaults = null,
        websitePolicy = null,
        activationId = "manifest-42",
        generation = 42,
        takeover = false,
        nowMillis = 1_000_000,
        clockOffsetMillis = 500,
    )

    @Test fun mapsImageAndVideoToTcmedia() {
        val items = listOf(item(assetType = "image"), item("i2", "a1", "v2", "video", null))
        val manifest = manifest(items).copy(
            assets = listOf(asset(), asset("a1", "v2", "video/mp4")),
        )
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray
        assertEquals("image", built[0].jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("tcmedia:a1/v1", built[0].jsonObject["src"]!!.jsonPrimitive.content)
        assertEquals("video", built[1].jsonObject["kind"]!!.jsonPrimitive.content)
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[1]))
    }

    @Test fun mapsManifestWebsiteToRemoteWebPage() {
        val site = ManifestWebsite(
            assetId = "w1", name = "W", url = "https://example.com/start",
            allowedHosts = listOf("example.com"), javascriptEnabled = true,
            domStorageEnabled = true, cookiePolicy = "first_party",
            reloadPolicy = "on_each_activation", loadTimeoutSeconds = 20,
            zoomPercent = 100, scrollX = 0, scrollY = 0, failureBehavior = "placeholder",
        )
        val items = listOf(item("i9", "w1", null, "website", 30_000))
        val manifest = manifest(items).copy(websites = listOf(site))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        assertEquals("website", built["kind"]!!.jsonPrimitive.content)
        val remote = built["remoteWeb"]!!.jsonObject
        assertEquals("page", remote["content"]!!.jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals(
            "example.com",
            remote["content"]!!.jsonObject["allowedHosts"]!!.jsonArray[0].jsonPrimitive.content,
        )
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun mapsYouTubeProviderWidgetToReference() {
        val config = buildJsonObject {
            put("url", "https://youtube.com/watch?v=x")
            put("videoId", "x")
            put("failureBehavior", "placeholder")
            put("playlistPlaybackMode", "until_end")
        }
        val widget = ManifestWidget("y1", "YT", "youtube", 1, config)
        val items = listOf(item("iy", "y1", null, "widget", null).copy(audioEnabled = true))
        val manifest = manifest(items).copy(widgets = listOf(widget))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        // The shared runtime projector owns YouTube remote-web projection;
        // Android sends only the generic reference, never per-provider config.
        assertEquals("widget", built["kind"]!!.jsonPrimitive.content)
        assertEquals("y1", built["widget"]!!.jsonObject["widgetAssetId"]!!.jsonPrimitive.content)
        assertFalse("remoteWeb" in built)
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun mapsRemoteWebWidgetToReference() {
        val descriptor = WebSandboxPresentation(
            mode = "remote",
            url = "https://example.com/widget",
            allowedHosts = listOf("example.com"),
            lifecycle = "keep_warm",
            warmSeconds = 45,
        )
        val widget = ManifestWidget(
            assetId = "rw1",
            name = "Remote",
            presentation = WidgetPresentation(schemaVersion = 1, kind = "web", web = descriptor),
        )
        val items = listOf(item("irw", "rw1", null, "widget", 15_000))
        val manifest = manifest(items).copy(widgets = listOf(widget))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        // Lifecycle/warmth live in the manifest the projection carries; the
        // item itself is a generic reference the projector expands.
        assertEquals("widget", built["kind"]!!.jsonPrimitive.content)
        assertEquals("rw1", built["widget"]!!.jsonObject["widgetAssetId"]!!.jsonPrimitive.content)
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
        val message = RuntimePresentationBuilder.hostMessage(playing(manifest, items))
        assertTrue("projection" in message)
    }

    @Test fun runtimeResumeProjectsSavedCursorWithoutAffectingSyncOrder() {
        val items = listOf(
            item("i1", "a1", "v1", "image", 10_000),
            item("i2", "a1", "v1", "image", 10_000),
            item("i3", "a1", "v1", "image", 10_000),
        )
        val plainManifest = manifest(items)
        val resumed = PlaybackSession(
            content = PreparedContent(plainManifest, emptyMap()),
            serverUrl = "https://example.com",
            credential = "c",
            initialCursor = PlaybackCursor(1, 0),
            startedAtElapsedRealtimeMs = 0L,
            startedAtWallClock = java.time.Instant.EPOCH,
        )
        assertEquals(listOf("i2", "i3", "i1"), runtimePlaylistItems(resumed).map { it.id })

        val synchronized = resumed.copy(
            content = PreparedContent(
                plainManifest.copy(syncGroup = ManifestSyncGroup("g1", "2026-09-01T12:00:00Z")),
                emptyMap(),
            ),
        )
        assertEquals(listOf("i1", "i2", "i3"), runtimePlaylistItems(synchronized).map { it.id })
    }

    @Test fun runtimeActivationIdentityChangesMonotonically() {
        val first = nextRuntimeActivationIdentity()
        val second = nextRuntimeActivationIdentity()
        assertNotEquals(first.id, second.id)
        assertTrue(second.generation > first.generation)
    }

    @Test fun forwardsUnknownWidgetsAsGenericReferences() {
        // Architectural guard: a future Widget provider must flow through
        // without an Android source edit, so no provider/type switch may
        // reappear in the runtime bridge.
        val config = buildJsonObject { put("timezone", "UTC") }
        val widget = ManifestWidget("c1", "Clock", "some-future-provider", 3, config)
        val items = listOf(item("ic", "c1", null, "widget", 5_000))
        val manifest = manifest(items).copy(widgets = listOf(widget))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        assertEquals("widget", built["kind"]!!.jsonPrimitive.content)
        val reference = built["widget"]!!.jsonObject
        assertEquals("c1", reference["widgetAssetId"]!!.jsonPrimitive.content)
        assertEquals(setOf("widgetAssetId"), reference.keys)
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun forwardsComponentWidgetsAsGenericReferences() {
        val component = org.tilecast.player.network.ComponentPresentation(
            type = "tilecast.clock",
            version = 1,
            config = buildJsonObject {},
        )
        val widget = ManifestWidget(
            assetId = "cc1",
            name = "Clock",
            presentation = WidgetPresentation(
                schemaVersion = 2,
                kind = "component",
                requiredCapabilities = mapOf("widget.tilecast.clock" to 1),
                component = component,
            ),
        )
        val items = listOf(item("icc", "cc1", null, "widget", 5_000))
        val manifest = manifest(items, schemaVersion = 16).copy(widgets = listOf(widget))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        assertEquals("widget", built["kind"]!!.jsonPrimitive.content)
        assertEquals("cc1", built["widget"]!!.jsonObject["widgetAssetId"]!!.jsonPrimitive.content)
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun invalidWebsiteConfigIsNotRenderable() {
        val widget = ManifestWidget("w2", "W", "website", 1, buildJsonObject { put("url", 42) })
        val items = listOf(item("iw", "w2", null, "widget", null))
        val manifest = manifest(items).copy(widgets = listOf(widget))
        assertFalse(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun emitsSyncTimingForGroupedManifests() {
        val items = listOf(item(durationMs = 10_000), item("i2", "a1", "v1", "image", 20_000))
        val epoch = "2026-09-01T12:00:00Z"
        val manifest = manifest(items, syncGroup = ManifestSyncGroup("g1", epoch))
        val message = RuntimePresentationBuilder.hostMessage(playing(manifest, items))
        assertEquals("presentation", message["type"]!!.jsonPrimitive.content)
        assertEquals(true, message["presentation"]!!.jsonObject["synchronized"]!!.jsonPrimitive.content.toBoolean())
        val timing = message["timing"]!!.jsonObject
        assertEquals("g1", timing["groupId"]!!.jsonPrimitive.content)
        assertEquals(java.time.Instant.parse(epoch).toEpochMilli(), timing["anchorMs"]!!.jsonPrimitive.content.toLong())
        assertEquals(500, timing["clockOffsetMs"]!!.jsonPrimitive.content.toInt())
        assertEquals(listOf(10_000L, 20_000L), timing["durationsMs"]!!.jsonArray.map { it.jsonPrimitive.content.toLong() })
        val activation = message["activation"]!!.jsonObject
        assertEquals("manifest-42", activation["activationId"]!!.jsonPrimitive.content)
    }

    @Test fun selectedScheduleOrTakeoverAnchorOverridesGroupEpoch() {
        val items = listOf(item(durationMs = 10_000))
        val manifest = manifest(
            items,
            syncGroup = ManifestSyncGroup("g1", "2026-09-01T12:00:00Z"),
        )
        val state = playing(manifest, items).copy(playbackAnchorMillis = 123_456L)
        val timing = RuntimePresentationBuilder.hostMessage(state)["timing"]!!.jsonObject
        assertEquals(123_456L, timing["anchorMs"]!!.jsonPrimitive.content.toLong())
    }

    @Test fun forwardsLayoutItemsAsGenericReferences() {
        val document = org.tilecast.player.network.LayoutDocument(
            schemaVersion = 1,
            canvas = org.tilecast.player.network.LayoutCanvas(1920, 1080, "landscape", "#000000"),
        )
        val layout = org.tilecast.player.network.ManifestLayout("l1", "r1", 1, "hash", document)
        val items = listOf(item("il", "a1", "v1", "image", 10_000).copy(assetType = "layout", layoutId = "l1"))
        val manifest = manifest(items).copy(layouts = listOf(layout))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        assertEquals("layout", built["kind"]!!.jsonPrimitive.content)
        assertEquals("l1", built["layout"]!!.jsonObject["layoutId"]!!.jsonPrimitive.content)
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun rootLayoutPlaysAsOneLayoutReferenceWithoutDuration() {
        val document = org.tilecast.player.network.LayoutDocument(
            schemaVersion = 1,
            canvas = org.tilecast.player.network.LayoutCanvas(1920, 1080, "landscape", "#000000"),
        )
        val layout = org.tilecast.player.network.ManifestLayout("l1", "r1", 1, "hash", document)
        val manifest = manifest(emptyList()).copy(layout = layout, layouts = listOf(layout))
        val items = listOf(org.tilecast.player.content.rootLayoutItem(layout))
        assertEquals("layout-l1", items[0].id)
        assertNull(items[0].durationMs)
        val rawManifest = buildJsonObject {
            put("layout", buildJsonObject { put("id", "l1") })
            putJsonArray("layouts") { addJsonObject { put("id", "l1") } }
        }
        val state = playing(manifest, items).copy(
            content = PreparedContent(manifest, emptyMap(), projectionManifest = rawManifest),
            fullscreenLayout = layout,
        )
        val presentation = RuntimePresentationBuilder.build(state)
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        assertEquals("layout", built["kind"]!!.jsonPrimitive.content)
        assertEquals("l1", built["layout"]!!.jsonObject["layoutId"]!!.jsonPrimitive.content)
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0], layout))
        // The reference persists until replacement: projection carries the
        // manifest subset so zones and availability project in the runtime.
        val message = RuntimePresentationBuilder.hostMessage(state)
        assertTrue("projection" in message)
        assertTrue("layout" in message["projection"]!!.jsonObject["manifest"]!!.jsonObject)
    }

    @Test fun projectionCarriesVerifiedManifestMediaClockAndPlayback() {
        val widget = ManifestWidget("c1", "Clock", "clock", 1, buildJsonObject {})
        val items = listOf(item("ic", "c1", null, "widget", 5_000))
        val manifest = manifest(items).copy(
            widgets = listOf(widget),
            assets = listOf(asset(), asset("a1", "v2", "video/mp4")),
        )
        val rawManifest = buildJsonObject {
            put("widgets", buildJsonObject { put("count", 1) })
            put("futureField", "future-value")
        }
        val state = playing(manifest, items).copy(
            content = PreparedContent(
                manifest,
                mapOf("v1" to "/data/cached/v1.png"),
                projectionManifest = rawManifest,
            ),
            playbackDefaults = org.tilecast.player.network.PlayerPlaybackDefaults(),
        )
        val message = RuntimePresentationBuilder.hostMessage(state)
        val projection = message["projection"]!!.jsonObject
        assertEquals(1, projection["schema"]!!.jsonPrimitive.content.toInt())
        assertEquals(500, projection["clockOffsetMs"]!!.jsonPrimitive.content.toInt())
        // The projection carries the Edge manifest subset: modeled sections
        // arrive, while the preserved raw manifest (not the projection) is
        // what keeps unknown fields lossless.
        assertTrue("widgets" in projection["manifest"]!!.jsonObject)
        val media = projection["media"]!!.jsonArray
        assertEquals(1, media.size)
        assertEquals("a1", media[0].jsonObject["assetId"]!!.jsonPrimitive.content)
        assertEquals("v1", media[0].jsonObject["variantId"]!!.jsonPrimitive.content)
        assertEquals("tcmedia://variant/a1/v1", media[0].jsonObject["uri"]!!.jsonPrimitive.content)
        // Host-private state never crosses into the projection.
        val encoded = projection.toString()
        assertFalse("/data/cached/v1.png" in encoded)
        assertFalse("Bearer" in encoded)
        assertTrue("playback" in projection)
    }

    @Test fun projectionOmittedWithoutReferences() {
        val items = listOf(item(assetType = "image"))
        val manifest = manifest(items)
        val message = RuntimePresentationBuilder.hostMessage(playing(manifest, items))
        assertFalse("projection" in message)
    }

    @Test fun unknownManifestFieldSurvivesIntoProjectionManifest() {
        val envelope = """{"data":{"schemaVersion":16,"futureWidgetKind":"hologram","widgets":[]}}"""
        val raw = org.tilecast.player.content.projectionManifestFromEnvelope(envelope)
        assertEquals("hologram", raw["futureWidgetKind"]!!.jsonPrimitive.content)
    }

    @Test fun buildsBrandedStatusStates() {
        val branding = PlayerBranding()
        val idle = RuntimePresentationBuilder.build(RuntimeScreenState.Idle(branding))
        assertEquals("idle", idle["state"]!!.jsonPrimitive.content)
        assertEquals(branding.noContentTitle, idle["title"]!!.jsonPrimitive.contentOrNull)
        val disabled = RuntimePresentationBuilder.build(RuntimeScreenState.Disabled(branding))
        assertEquals("disabled", disabled["state"]!!.jsonPrimitive.content)
        val pairing = RuntimePresentationBuilder.build(
            RuntimeScreenState.Pairing("ABC123", "https://studio.example/pair", "Org"),
        )
        assertEquals("ABC123", pairing["code"]!!.jsonPrimitive.content)
        val sleep = RuntimePresentationBuilder.build(RuntimeScreenState.Sleep("black", null, null))
        assertEquals("sleep", sleep["state"]!!.jsonPrimitive.content)
    }
}
