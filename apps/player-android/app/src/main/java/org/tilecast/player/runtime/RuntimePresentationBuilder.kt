package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.tilecast.player.content.PreparedContent
import org.tilecast.player.content.effectiveDurationMs
import org.tilecast.player.content.resolveWebsitePolicy
import org.tilecast.player.content.withPlaybackDefaults
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestLayout
import org.tilecast.player.network.ManifestWebsite
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.PlayerBranding
import org.tilecast.player.network.PlayerManifest
import org.tilecast.player.network.PlayerPlaybackDefaults
import org.tilecast.player.network.PlayerWebsitePolicy
import org.tilecast.player.network.WebsiteSourceConfig
import java.time.Instant

/** Screen states the shared runtime can present, mapped from native player state. */
sealed interface RuntimeScreenState {
    data object Setup : RuntimeScreenState
    data class Pairing(val code: String, val approvalUrl: String, val organizationName: String?) : RuntimeScreenState
    data class Idle(val branding: PlayerBranding, val logoSrc: String? = null) : RuntimeScreenState
    data class Disabled(val branding: PlayerBranding, val logoSrc: String? = null) : RuntimeScreenState
    data object Unavailable : RuntimeScreenState
    data class SafeMode(val reason: String) : RuntimeScreenState
    data class Sleep(val display: String, val text: String?, val textColor: String?) : RuntimeScreenState
    data class Playing(
        val content: PreparedContent,
        val items: List<ManifestItem>,
        val fullscreenLayout: ManifestLayout?,
        val playbackDefaults: PlayerPlaybackDefaults?,
        val websitePolicy: PlayerWebsitePolicy?,
        val activationId: String,
        val generation: Long,
        val takeover: Boolean,
        val nowMillis: Long,
        val clockOffsetMillis: Long,
        val playbackAnchorMillis: Long? = null,
    ) : RuntimeScreenState
}

/** One built playlist item plus whether the shared runtime can render it.
 *
 * Widget and Layout items travel as generic references plus a projection
 * context: the shared runtime projector owns V2 components, legacy
 * compatibility Widgets, web/YouTube Widgets (remote-web), Layout
 * primitives, placements, zones, and availability. There is intentionally no
 * branch over widget provider or component type here; an unknown future
 * Widget flows through untouched.
 */
data class BuiltRuntimeItem(val json: JsonObject, val runtimeRenderable: Boolean)

object RuntimePresentationBuilder {
    private val json = Json { ignoreUnknownKeys = true }

    fun build(state: RuntimeScreenState): JsonObject = when (state) {
        is RuntimeScreenState.Setup -> buildJsonObject { put("state", "setup") }
        is RuntimeScreenState.Pairing -> buildJsonObject {
            put("state", "pairing")
            put("code", state.code.take(16))
            put("approvalUrl", state.approvalUrl.take(512))
            state.organizationName?.take(128)?.let { put("organizationName", it) }
        }
        is RuntimeScreenState.Idle -> branded("idle", state.branding, state.logoSrc)
        is RuntimeScreenState.Disabled -> branded("disabled", state.branding, state.logoSrc)
        is RuntimeScreenState.Unavailable -> buildJsonObject { put("state", "unavailable") }
        is RuntimeScreenState.SafeMode -> buildJsonObject {
            put("state", "safe-mode")
            put("reason", state.reason.take(240))
        }
        is RuntimeScreenState.Sleep -> buildJsonObject {
            put("state", "sleep")
            put("display", state.display.takeIf { it in setOf("bouncing_logo", "custom_text", "black") } ?: "black")
            state.text?.take(240)?.let { put("text", it) }
            state.textColor?.take(32)?.let { put("textColor", it) }
        }
        is RuntimeScreenState.Playing -> buildPlaying(state)
    }

    /** Full host message envelope for the bridge, with sync timing when grouped
     * and a projection context whenever items travel as references. */
    fun hostMessage(state: RuntimeScreenState.Playing): JsonObject {
        val presentation = build(state)
        return buildJsonObject {
            put("type", "presentation")
            put("presentation", presentation)
            putJsonObject("activation") {
                put("activationId", state.activationId.take(64))
                put("generation", state.generation)
            }
            timingOf(state)?.let { put("timing", it) }
            projectionOf(state)?.let { put("projection", it) }
        }
    }

    /**
     * Projection context for reference items, mirroring the Edge reference
     * host: the preserved verified manifest subset, one media alias per
     * manifest variant Android has verified and cached, the corrected clock
     * offset, and the playback/regional section. Never carries file paths,
     * auth headers, credentials, or arbitrary network URLs; the host alone
     * translates authorized tcmedia identities to cached bytes.
     */
    internal fun projectionOf(state: RuntimeScreenState.Playing): JsonObject? {
        val manifest = state.content.manifest
        val built = state.items.map { buildItem(manifest, it, state.playbackDefaults, state.websitePolicy) }
        if (built.none { needsProjection(it.json) }) return null
        val raw = state.content.projectionManifest
        return buildJsonObject {
            put("schema", 1)
            put("clockOffsetMs", state.clockOffsetMillis)
            putJsonObject("manifest") {
                PROJECTION_MANIFEST_KEYS.forEach { key ->
                    raw[key]?.let { put(key, it) }
                }
            }
            putJsonArray("media") {
                manifest.assets
                    .filter { state.content.localFiles.containsKey(it.variantId) }
                    .distinctBy { it.variantId }
                    .forEach { asset ->
                        addJsonObject {
                            put("assetId", asset.assetId.take(128))
                            put("variantId", asset.variantId.take(128))
                            put("uri", "tcmedia://variant/${asset.assetId}/${asset.variantId}".take(512))
                        }
                    }
            }
            state.playbackDefaults?.let { defaults ->
                runCatching { json.encodeToJsonElement(PlayerPlaybackDefaults.serializer(), defaults) as JsonObject }
                    .getOrNull()?.let { put("playback", it) }
            }
        }
    }

    internal fun needsProjection(item: JsonObject): Boolean {
        val widget = item["widget"] as? JsonObject
        if (widget?.get("widgetAssetId") is kotlinx.serialization.json.JsonPrimitive) return true
        val layout = item["layout"] as? JsonObject
        return layout?.get("layoutId") is kotlinx.serialization.json.JsonPrimitive
    }

    private val PROJECTION_MANIFEST_KEYS = listOf(
        "assets", "playlist", "directFallbackPlaylist", "playlists",
        "widgets", "dataSources", "layouts", "layout", "canvas", "viewport",
    )

    fun isRuntimeRenderable(manifest: PlayerManifest, item: ManifestItem): Boolean =
        buildItem(manifest, item, null, null).runtimeRenderable

    private fun branded(state: String, branding: PlayerBranding, logoSrc: String?): JsonObject =
        buildJsonObject {
            put("state", state)
            put("title", if (state == "idle") branding.noContentTitle else branding.disabledTitle)
            put("message", if (state == "idle") branding.noContentMessage else branding.disabledMessage)
            put("backgroundColor", branding.backgroundColor.take(32))
            put("textColor", branding.textColor.take(32))
            logoSrc?.take(512)?.let { put("logoSrc", it) }
            put("footerText", branding.footerText.take(240))
        }

    private fun buildPlaying(state: RuntimeScreenState.Playing): JsonObject {
        val manifest = state.content.manifest
        val built = state.items.map { buildItem(manifest, it, state.playbackDefaults, state.websitePolicy) }
        return buildJsonObject {
            put("state", "playing")
            putJsonArray("items") { built.forEach { add(it.json) } }
            put("generation", state.generation)
            if (state.takeover) put("takeover", true)
            if (manifest.syncGroup != null) put("synchronized", true)
        }
    }

    private fun timingOf(state: RuntimeScreenState.Playing): JsonObject? {
        val group = state.content.manifest.syncGroup ?: return null
        val assets = state.content.manifest.assets
        val groupEpoch = runCatching { Instant.parse(group.playbackEpoch).toEpochMilli() }.getOrNull()
        val anchor = state.playbackAnchorMillis ?: groupEpoch ?: return null
        return buildJsonObject {
            put("groupId", group.id.take(64))
            put("anchorMs", anchor)
            putJsonArray("durationsMs") {
                state.items.forEach { add(effectiveDurationMs(it, assets)) }
            }
            put("clockOffsetMs", state.clockOffsetMillis)
        }
    }

    internal fun buildItem(
        manifest: PlayerManifest,
        item: ManifestItem,
        defaults: PlayerPlaybackDefaults?,
        websitePolicy: PlayerWebsitePolicy?,
    ): BuiltRuntimeItem {
        val resolved = item.withPlaybackDefaults(defaults)
        val website = manifest.websites.firstOrNull { it.assetId == item.assetId }?.let {
            resolveWebsitePolicy(it, websitePolicy)
        }
        val widget = manifest.widgets.firstOrNull { it.assetId == item.assetId }
        val layout = item.layoutId?.let { id -> manifest.layouts.firstOrNull { it.id == id } }
        val asset = item.variantId?.let { variant -> manifest.assets.firstOrNull { it.variantId == variant } }

        if (item.assetType == "layout" && layout != null) {
            return BuiltRuntimeItem(layoutReference(resolved, layout.id), true)
        }
        if (manifest.schemaVersion >= 13 && widget?.presentation?.kind == "web") {
            val descriptor = widget.presentation.web
            if (descriptor != null && descriptor.mode == "remote") {
                // The shared runtime projector turns this reference into the
                // remote-web spec itself (host-view on Android).
                return BuiltRuntimeItem(widgetReference(resolved, widget), true)
            }
            return BuiltRuntimeItem(unresolvableItem(resolved), false)
        }
        if (widget?.provider == "website") {
            val config = runCatching { json.decodeFromJsonElement<WebsiteSourceConfig>(widget.configuration) }.getOrNull()
                ?: return BuiltRuntimeItem(unresolvableItem(resolved), false)
            return BuiltRuntimeItem(websiteItem(resolved, remoteWebPage(
                url = config.url,
                allowedHosts = config.allowedHosts,
                javascriptEnabled = config.javascriptEnabled,
                domStorageEnabled = config.domStorageEnabled,
                cookiePolicy = mapCookiePolicy(config.cookiePolicy),
                userAgent = config.customUserAgent,
                zoomPercent = config.zoomPercent,
                scrollX = config.scrollX,
                scrollY = config.scrollY,
                backgroundColor = config.backgroundColor,
                loadTimeoutSeconds = config.loadTimeoutSeconds,
                reloadIntervalSeconds = config.refreshIntervalSeconds
                    .takeIf { config.reloadPolicy == "interval" },
                lifecycle = "destroy_on_hide",
                warmSeconds = 0,
                onlineOnly = true,
                failureBehavior = config.failureBehavior,
                fallbackSrc = fallbackSrc(manifest, config.fallbackImageAssetId, config.fallbackVariantId),
                playUntilEnd = false,
            )), true)
        }
        if (widget?.provider == "youtube") {
            // The projector's remote-web branch owns YouTube projection from
            // the server-normalized configuration; duration/audio fallbacks
            // follow the reference host path.
            return BuiltRuntimeItem(widgetReference(resolved, widget), true)
        }
        if (website != null) {
            return BuiltRuntimeItem(websiteItem(resolved, remoteWebPage(
                url = website.url,
                allowedHosts = website.allowedHosts,
                javascriptEnabled = website.javascriptEnabled,
                domStorageEnabled = website.domStorageEnabled,
                cookiePolicy = mapCookiePolicy(website.cookiePolicy),
                userAgent = website.customUserAgent,
                zoomPercent = website.zoomPercent,
                scrollX = website.scrollX,
                scrollY = website.scrollY,
                backgroundColor = website.backgroundColor,
                loadTimeoutSeconds = website.loadTimeoutSeconds,
                reloadIntervalSeconds = website.refreshIntervalSeconds
                    .takeIf { website.reloadPolicy == "interval" },
                lifecycle = "destroy_on_hide",
                warmSeconds = 0,
                onlineOnly = true,
                failureBehavior = website.failureBehavior,
                fallbackSrc = fallbackSrc(manifest, website.fallbackImageAssetId, website.fallbackVariantId),
                playUntilEnd = false,
            )), true)
        }
        if (widget != null) {
            // Component, legacy compatibility, and web/YouTube Widgets all
            // travel as the same generic reference. The shared runtime
            // projector owns the per-category decision (component projection,
            // legacy render, remote-web), so a future Widget needs no Android
            // source edit. Provider "website" without a kind "web"
            // presentation keeps the direct remote-web mapping above: the
            // projector has no website-provider branch.
            return BuiltRuntimeItem(widgetReference(resolved, widget), true)
        }
        if (asset != null) {
            val variantId = item.variantId
            if (variantId == null) return BuiltRuntimeItem(unresolvableItem(resolved), false)
            return if (asset.mimeType.startsWith("image/")) {
                BuiltRuntimeItem(mediaItem(resolved, "image", mediaSrc(item.assetId, variantId)), true)
            } else {
                BuiltRuntimeItem(mediaItem(resolved, "video", mediaSrc(item.assetId, variantId)), true)
            }
        }
        return BuiltRuntimeItem(unresolvableItem(resolved), false)
    }

    private fun mediaSrc(assetId: String, variantId: String): String =
        "${MediaAuthorization.SCHEME}:$assetId/$variantId"

    private fun fallbackSrc(manifest: PlayerManifest, assetId: String?, variantId: String?): String? {
        if (assetId.isNullOrBlank() || variantId.isNullOrBlank()) return null
        val known = manifest.assets.any { it.assetId == assetId && it.variantId == variantId }
        return if (known) mediaSrc(assetId, variantId) else null
    }

    internal fun mapCookiePolicy(raw: String): String = when (raw) {
        "disabled", "none" -> "disabled"
        "first_and_third_party" -> "first_and_third_party"
        else -> "first_party"
    }

    private fun baseItem(resolved: ManifestItem, kind: String, src: String): JsonObject =
        buildJsonObject {
            put("id", resolved.id.take(128))
            put("kind", kind)
            put("src", src.take(512))
            resolved.durationMs?.let { put("durationMs", it) }
            put("fitMode", resolved.fitMode.take(32))
            put("transition", resolved.transition.take(32))
            put("audioEnabled", resolved.audioEnabled)
            put("volume", resolved.volume.toDouble().coerceIn(0.0, 1.0))
            resolved.videoStartOffsetMs?.let { put("videoStartOffsetMs", it) }
            resolved.videoEndOffsetMs?.let { put("videoEndOffsetMs", it) }
        }

    private fun mediaItem(resolved: ManifestItem, kind: String, src: String): JsonObject =
        baseItem(resolved, kind, src)

    private fun websiteItem(resolved: ManifestItem, remoteWeb: JsonObject): JsonObject =
        buildJsonObject {
            baseItem(resolved, "website", "").toMap().forEach { (k, v) -> put(k, v) }
            put("audioEnabled", false)
            put("volume", 0.0)
            put("remoteWeb", remoteWeb)
        }

    private fun remoteWebPage(
        url: String,
        allowedHosts: List<String>,
        javascriptEnabled: Boolean,
        domStorageEnabled: Boolean,
        cookiePolicy: String,
        userAgent: String,
        zoomPercent: Int,
        scrollX: Int,
        scrollY: Int,
        backgroundColor: String,
        loadTimeoutSeconds: Int,
        reloadIntervalSeconds: Int?,
        lifecycle: String,
        warmSeconds: Int,
        onlineOnly: Boolean,
        failureBehavior: String,
        fallbackSrc: String?,
        playUntilEnd: Boolean,
    ): JsonObject = buildJsonObject {
        putJsonObject("content") {
            put("kind", "page")
            put("url", url.take(2048))
            putJsonArray("allowedHosts") { allowedHosts.take(25).forEach { add(it.take(253)) } }
            put("javascriptEnabled", javascriptEnabled)
            put("domStorageEnabled", domStorageEnabled)
            put("cookiePolicy", cookiePolicy.take(32))
            put("userAgent", userAgent.take(512))
            put("zoomPercent", zoomPercent.coerceIn(25, 400))
            put("scrollX", scrollX)
            put("scrollY", scrollY)
            put("backgroundColor", backgroundColor.take(32))
        }
        putJsonObject("presentation") {
            put("loadTimeoutSeconds", loadTimeoutSeconds.coerceIn(1, 120))
            reloadIntervalSeconds?.let { put("reloadIntervalSeconds", it.coerceAtLeast(30)) }
            put("lifecycle", lifecycle.take(32))
            put("warmSeconds", warmSeconds.coerceIn(0, 300))
            put("onlineOnly", onlineOnly)
            put("failureBehavior", failureBehavior.take(32))
            put("fallbackSrc", fallbackSrc)
            put("playUntilEnd", playUntilEnd)
        }
    }

    private fun widgetReference(resolved: ManifestItem, widget: ManifestWidget): JsonObject =
        buildJsonObject {
            baseItem(resolved, "widget", "").toMap().forEach { (k, v) -> put(k, v) }
            putJsonObject("widget") {
                put("widgetAssetId", widget.assetId.take(128))
            }
        }

    private fun layoutReference(resolved: ManifestItem, layoutId: String): JsonObject =
        buildJsonObject {
            baseItem(resolved, "layout", "").toMap().forEach { (k, v) -> put(k, v) }
            putJsonObject("layout") {
                put("layoutId", layoutId.take(128))
            }
        }

    private fun unresolvableItem(resolved: ManifestItem): JsonObject =
        buildJsonObject {
            baseItem(resolved, "image", "").toMap().forEach { (k, v) -> put(k, v) }
            put("durationMs", 1_000)
        }
}
