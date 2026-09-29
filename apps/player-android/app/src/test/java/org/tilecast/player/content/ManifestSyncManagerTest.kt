package org.tilecast.player.content

import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.tilecast.player.network.LayoutCanvas
import org.tilecast.player.network.LayoutDocument
import org.tilecast.player.network.LayoutPlacement
import org.tilecast.player.network.ComponentMediaRef
import org.tilecast.player.network.ComponentPresentation
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestLayout
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.PlayerManifest
import org.tilecast.player.network.WidgetPresentation
import org.tilecast.player.data.CachedAsset

class ManifestSyncManagerTest {
    @Test
    fun onlySendsConditionalManifestRequestAfterCacheVerification() {
        assertEquals("etag-1", manifestEtagForRequest(true, "etag-1"))
        assertEquals(null, manifestEtagForRequest(false, "etag-1"))
    }

    @Test
    fun downloadsLayoutBackgroundAndAssetPlacements() {
        val background = ManifestAsset("asset-background", "variant-background", "image/png", "background-hash", 10, downloadPath = "/background")
        val placementAsset = ManifestAsset("asset-placement", "variant-placement", "image/png", "placement-hash", 20, downloadPath = "/placement")
        val layout = ManifestLayout(
            id = "layout-1",
            revisionId = "revision-1",
            revision = 1,
            documentSha256 = "document-hash",
            document = LayoutDocument(
                schemaVersion = 1,
            canvas = LayoutCanvas(1920, 1080, "landscape", "#000000", backgroundAssetId = background.assetId, backgroundVariantId = background.variantId),
                placements = listOf(
                    LayoutPlacement("placement-1", "asset", "Photo", 0f, 0f, 100f, 100f, 1, 1f, true, false, assetId = placementAsset.assetId, variantId = placementAsset.variantId),
                ),
            ),
        )
        val manifest = PlayerManifest(
            schemaVersion = 13,
            manifestVersion = 1,
            screenId = "screen-1",
            generatedAt = "2026-07-18T00:00:00Z",
            mode = "presentation",
            layout = layout,
            layouts = listOf(layout),
            assets = listOf(background, placementAsset),
        )

        val selected = selectManifestDownloads(
            manifest = manifest,
            cacheUsedBytes = 0,
            usableSpaceBytes = 1_000,
            cacheLimitBytes = 1_000,
            minimumFreeBytes = 0,
            automaticVideoThresholdBytes = 100,
        )

        assertEquals(listOf("variant-background", "variant-placement"), selected.map { it.variantId })
        assertTrue(selected.all { it.fileSize > 0 })
    }

    @Test
    fun layoutReferencesSelectTheExactVariantWhenAnAssetHasSeveralVariants() {
        val requested = ManifestAsset("asset", "variant-requested", "image/png", "requested", 10, downloadPath = "/requested")
        val other = ManifestAsset("asset", "variant-other", "image/png", "other", 20, downloadPath = "/other")
        val layout = ManifestLayout(
            id = "layout",
            revisionId = "revision",
            revision = 1,
            documentSha256 = "hash",
            document = LayoutDocument(
                schemaVersion = 1,
                canvas = LayoutCanvas(1920, 1080, "landscape", "#000000", backgroundAssetId = "asset", backgroundVariantId = requested.variantId),
                placements = emptyList(),
            ),
        )
        val manifest = PlayerManifest(13, 1, "screen", "2026-07-18T00:00:00Z", "presentation", layout = layout, layouts = listOf(layout), assets = listOf(other, requested))

        assertEquals(listOf(requested.variantId), selectManifestDownloads(manifest, 0, 1_000, 1_000, 0, 100).map { it.variantId })
    }

    @Test
    fun downloadsValidatedComponentMediaGrants() {
        val media = ManifestAsset("media-asset", "media-variant", "image/png", "media-hash", 30, downloadPath = "/media")
        val widget = ManifestWidget(
            assetId = "widget-1",
            name = "Clock",
            provider = "clock",
            presentation = WidgetPresentation(
                schemaVersion = 2,
                kind = "component",
                requiredCapabilities = mapOf("widget.tilecast.clock" to 1),
                component = ComponentPresentation(
                    type = "tilecast.clock",
                    version = 1,
                    media = listOf(ComponentMediaRef("media-asset", "media-variant")),
                ),
            ),
        )
        val manifest = PlayerManifest(
            schemaVersion = 16,
            manifestVersion = 1,
            screenId = "screen-1",
            generatedAt = "2026-07-18T00:00:00Z",
            mode = "presentation",
            widgets = listOf(widget),
            assets = listOf(media),
        )

        val selected = selectManifestDownloads(
            manifest = manifest,
            cacheUsedBytes = 0,
            usableSpaceBytes = 1_000,
            cacheLimitBytes = 1_000,
            minimumFreeBytes = 0,
            automaticVideoThresholdBytes = 100,
        )

        assertEquals(listOf("media-variant"), selected.map { it.variantId })
    }

    @Test
    fun rejectsMultiDotComponentTypes() {
        val media = ManifestAsset("media-asset", "media-variant", "image/png", "media-hash", 30, downloadPath = "/media")
        val widget = ManifestWidget(
            assetId = "widget-1",
            name = "Bad",
            provider = "clock",
            presentation = WidgetPresentation(
                schemaVersion = 2,
                kind = "component",
                requiredCapabilities = mapOf("widget.tilecast.foo.bar" to 1),
                component = ComponentPresentation(
                    type = "tilecast.foo.bar",
                    version = 1,
                ),
            ),
        )
        val manifest = PlayerManifest(
            schemaVersion = 16,
            manifestVersion = 1,
            screenId = "screen-1",
            generatedAt = "2026-07-18T00:00:00Z",
            mode = "presentation",
            widgets = listOf(widget),
            assets = listOf(media),
        )
        try {
            validateWidgetComponentPresentation(
                widget.presentation!!,
                emptyMap(),
                manifest,
            )
            fail("multi-dot component type must be rejected")
        } catch (error: IllegalArgumentException) {
            // Expected: mirrors schema v16 and the runtime projector.
        }
    }

    @Test
    fun onlyVerifiesFilesRequiredByTheActiveManifest() {
        val active = cachedAsset("active", required = true)
        val unprotected = cachedAsset("unprotected", required = false)
        val verified = mutableListOf<String>()

        val result = validateActiveCache(listOf(active, unprotected)) { record ->
            verified += record.variantId
            true
        }

        assertEquals(listOf("active"), verified)
        assertEquals(mapOf("active" to active.localPath), result.localFiles)
        assertTrue(result.complete)
    }

    @Test
    fun rejectsAnInvalidFileRequiredByTheActiveManifest() {
        val result = validateActiveCache(listOf(cachedAsset("active", required = true))) { false }

        assertTrue(result.localFiles.isEmpty())
        assertTrue(!result.complete)
    }

    @Test
    fun acceptsAValidComponentPresentation() {
        validateWidgetComponentPresentation(
            componentPresentation(),
            mapOf("source-1" to dataSource("source-1")),
            manifestWithAssets(listOf(ManifestAsset("asset-1", "variant-1", "image/png", "hash", 10, downloadPath = "/dl"))),
        )
    }

    @Test
    fun rejectsAMismatchedComponentCapability() {
        try {
            validateWidgetComponentPresentation(
                componentPresentation(requiredCapabilities = mapOf("widget.tilecast.clock" to 2)),
                emptyMap(),
                null,
            )
            fail("expected capability mismatch to fail")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("capability"))
        }
    }

    @Test
    fun rejectsComponentCapabilitiesThePlayerDoesNotAdvertise() {
        val unsupported = listOf(
            componentPresentation(
                type = "tilecast.unknown",
                requiredCapabilities = mapOf("widget.tilecast.unknown" to 1),
            ),
            componentPresentation(
                type = "tilecast.clock",
                version = 3,
                requiredCapabilities = mapOf("widget.tilecast.clock" to 3),
            ),
        )

        unsupported.forEach { presentation ->
            try {
                validateWidgetComponentPresentation(presentation, emptyMap(), null)
                fail("expected unsupported component capability to fail")
            } catch (error: IllegalArgumentException) {
                assertTrue(error.message!!.contains("Missing presentation capability"))
            }
        }
    }

    @Test
    fun rejectsCachedComponentWhenRuntimeProbeHasNotPassed() {
        try {
            validateWidgetComponentPresentation(
                componentPresentation(),
                emptyMap(),
                null,
                componentRuntimeSupported = false,
            )
            fail("expected an unproven component runtime to fail")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("runtime is unavailable"))
        }
    }

    @Test
    fun rejectsAnUnknownComponentDataSource() {
        try {
            validateWidgetComponentPresentation(
                componentPresentation(dataSources = listOf("missing")),
                emptyMap(),
                null,
            )
            fail("expected unknown Data Source to fail")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("Data Source"))
        }
    }

    @Test
    fun rejectsAnUnknownComponentMediaGrant() {
        try {
            validateWidgetComponentPresentation(
                componentPresentation(media = listOf(org.tilecast.player.network.ComponentMediaRef("asset-1", "variant-9"))),
                emptyMap(),
                manifestWithAssets(listOf(ManifestAsset("asset-1", "variant-1", "image/png", "hash", 10, downloadPath = "/dl"))),
            )
            fail("expected unknown media grant to fail")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("media"))
        }
    }

    @Test
    fun rejectsDuplicateComponentDataSources() {
        try {
            validateWidgetComponentPresentation(
                componentPresentation(dataSources = listOf("source-1", "source-1")),
                mapOf("source-1" to dataSource("source-1")),
                null,
            )
            fail("expected duplicates to fail")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("Data Source"))
        }
    }

    @Test
    fun rejectsAnOversizedComponentConfigString() {
        try {
            validateWidgetComponentPresentation(
                componentPresentation(config = kotlinx.serialization.json.buildJsonObject { put("note", "x".repeat(2001)) }),
                emptyMap(),
                null,
            )
            fail("expected oversized config to fail")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("configuration"))
        }
    }

    @Test
    fun rejectsAnInvalidComponentType() {
        try {
            validateWidgetComponentPresentation(
                componentPresentation(type = "Clock"),
                emptyMap(),
                null,
            )
            fail("expected bad type to fail")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("type"))
        }
    }

    @Test
    fun preservesUnknownEnvelopeFieldsLosslessly() {
        val raw = projectionManifestFromEnvelope(
            """{"data":{"schemaVersion":16,"widgets":[],"futureSection":{"nested":true}}}""",
        )
        assertTrue(raw.containsKey("futureSection"))
    }

    private fun componentPresentation(
        type: String = "tilecast.clock",
        version: Int = 1,
        config: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.buildJsonObject {},
        dataSources: List<String> = emptyList(),
        media: List<org.tilecast.player.network.ComponentMediaRef> = emptyList(),
        requiredCapabilities: Map<String, Int> = mapOf("widget.tilecast.clock" to 1),
    ) = org.tilecast.player.network.WidgetPresentation(
        schemaVersion = 2,
        kind = "component",
        requiredCapabilities = requiredCapabilities,
        component = org.tilecast.player.network.ComponentPresentation(type, version, config, dataSources, media),
    )

    private fun dataSource(id: String) = org.tilecast.player.network.ManifestDataSource(id, "Source")

    private fun manifestWithAssets(assets: List<ManifestAsset>) = PlayerManifest(
        schemaVersion = 16,
        manifestVersion = 1,
        screenId = "screen",
        generatedAt = "2026-09-01T00:00:00Z",
        mode = "presentation",
        assets = assets,
    )

    private fun cachedAsset(variantId: String, required: Boolean) = CachedAsset(
        variantId = variantId,
        assetId = "asset-$variantId",
        sha256 = "hash-$variantId",
        expectedFileSize = 10,
        localPath = "/cache/$variantId",
        downloadStatus = "ready",
        requiredByActiveManifest = required,
    )
}
