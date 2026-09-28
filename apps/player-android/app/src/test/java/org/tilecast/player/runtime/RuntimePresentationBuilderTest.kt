package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.content.PreparedContent
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestSyncGroup
import org.tilecast.player.network.ManifestWebsite
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.PlayerBranding
import org.tilecast.player.network.PlayerManifest

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

    @Test fun mapsYouTubeProviderWidget() {
        val config = buildJsonObject {
            put("url", "https://youtube.com/watch?v=x")
            put("videoId", "x")
            put("failureBehavior", "placeholder")
            put("playlistPlaybackMode", "until_end")
        }
        val widget = ManifestWidget("y1", "YT", "youtube", 1, config)
        val items = listOf(item("iy", "y1", null, "widget", null))
        val manifest = manifest(items).copy(widgets = listOf(widget))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        assertEquals("youtube", built["kind"]!!.jsonPrimitive.content)
        assertEquals(
            "x",
            built["remoteWeb"]!!.jsonObject["content"]!!.jsonObject["videoId"]!!.jsonPrimitive.content,
        )
        assertTrue(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun forwardsLegacyWidgetsOpaquelyWithoutInterpreting() {
        val config = buildJsonObject { put("timezone", "UTC") }
        val widget = ManifestWidget("c1", "Clock", "some-future-provider", 3, config)
        val items = listOf(item("ic", "c1", null, "widget", 5_000))
        val manifest = manifest(items).copy(widgets = listOf(widget))
        val presentation = RuntimePresentationBuilder.build(playing(manifest, items))
        val built = presentation["items"]!!.jsonArray[0].jsonObject
        assertEquals("widget", built["kind"]!!.jsonPrimitive.content)
        val opaque = built["widget"]!!.jsonObject
        assertEquals("some-future-provider", opaque["legacyProvider"]!!.jsonPrimitive.content)
        assertEquals(3, opaque["configVersion"]!!.jsonPrimitive.content.toInt())
        assertFalse(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
        assertFalse("root" in opaque)
        assertFalse("component" in opaque)
    }

    @Test fun invalidWebsiteConfigIsNotRenderable() {
        val widget = ManifestWidget("w2", "W", "website", 1, buildJsonObject { put("url", 42) })
        val items = listOf(item("iw", "w2", null, "widget", null))
        val manifest = manifest(items).copy(widgets = listOf(widget))
        assertFalse(RuntimePresentationBuilder.isRuntimeRenderable(manifest, items[0]))
    }

    @Test fun emitsSyncTimingForGroupedManifests() {
        val items = listOf(item(durationMs = 10_000), item("i2", "a1", "v1", "image", 20_000))
        val manifest = manifest(items, syncGroup = ManifestSyncGroup("g1", "epoch"))
        val message = RuntimePresentationBuilder.hostMessage(playing(manifest, items))
        assertEquals("presentation", message["type"]!!.jsonPrimitive.content)
        assertEquals(true, message["presentation"]!!.jsonObject["synchronized"]!!.jsonPrimitive.content.toBoolean())
        val timing = message["timing"]!!.jsonObject
        assertEquals("g1", timing["groupId"]!!.jsonPrimitive.content)
        assertEquals(1_000_000, timing["anchorMs"]!!.jsonPrimitive.content.toLong())
        assertEquals(500, timing["clockOffsetMs"]!!.jsonPrimitive.content.toInt())
        assertEquals(listOf(10_000L, 20_000L), timing["durationsMs"]!!.jsonArray.map { it.jsonPrimitive.content.toLong() })
        val activation = message["activation"]!!.jsonObject
        assertEquals("manifest-42", activation["activationId"]!!.jsonPrimitive.content)
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
