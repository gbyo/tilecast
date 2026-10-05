package org.tilecast.player.content

import android.os.SystemClock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestLayout
import org.tilecast.player.network.PlayerManifest
import org.tilecast.player.network.PlayerPlaybackDefaults
import org.tilecast.player.network.PlayerWebsitePolicy
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/**
 * The shared presentation model: prepared manifest content plus the pure
 * playlist, duration, and identity helpers the runtime presentation
 * builder (and its tests) project onto the Player Runtime. Core owns
 * selection and scheduling; these shape what the renderer is given.
 */
data class PreparedContent(val manifest: PlayerManifest, val localFiles: Map<String, String>,val serverClockOffsetSeconds:Long?=null, val serverClockOffsetMillis:Long?=null,val projectionManifest: JsonObject = buildJsonObject{})

/**
 * Lossless projection manifest: the exact verified `data` object from the
 * manifest envelope. Never reconstruct from Kotlin models: `Json` uses
 * `ignoreUnknownKeys`, so re-encoding a [PlayerManifest] would silently drop
 * fields the runtime still needs.
 */
internal fun projectionManifestFromEnvelope(envelope: String): JsonObject {
    val root = Json.parseToJsonElement(envelope).jsonObject
    return root["data"]?.jsonObject ?: error("Manifest envelope is missing data")
}

data class PlaybackCursor(val index: Int, val cycle: Int)

internal fun effectiveDurationMs(item: ManifestItem, assets: List<ManifestAsset>): Long {
    // Zero is how stored data spells "no duration", not a one-millisecond slot.
    // Linux and Edge already read it as unset; reading it literally here put a
    // screen in a synchronized group on a cycle that rolled over every
    // millisecond.
    item.durationMs?.takeIf { it > 0 }?.let { return it }
    if (item.assetType == "website" || item.assetType == "widget") return 30_000
    val asset = item.variantId?.let { variant -> assets.firstOrNull { it.variantId == variant } }
    if (asset?.mimeType?.startsWith("video/") == true) {
        val start = item.videoStartOffsetMs ?: 0
        val end = item.videoEndOffsetMs ?: asset.durationSeconds?.times(1000)?.toLong()
        if (end != null) return (end - start).coerceAtLeast(1)
    }
    return 10_000
}

data class RuntimeActivationIdentity(val id: String, val generation: Long)

private val runtimeActivationSequence = AtomicLong(0)

internal fun nextRuntimeActivationIdentity(): RuntimeActivationIdentity =
    RuntimeActivationIdentity(UUID.randomUUID().toString(), runtimeActivationSequence.incrementAndGet())

data class PlaybackSession(
    val content: PreparedContent,
    val serverUrl: String,
    val credential: String,
    val initialCursor: PlaybackCursor = PlaybackCursor(0, 0),
    val initialOffsetMs: Long = 0,
    val startedAtElapsedRealtimeMs: Long = SystemClock.elapsedRealtime(),
    val startedAtWallClock: Instant = Instant.now(),
    val playbackDefaults: PlayerPlaybackDefaults? = null,
    val websitePolicy: PlayerWebsitePolicy? = null,
    val playbackAnchor: Instant? = null,
    val runtimeActivation: RuntimeActivationIdentity = nextRuntimeActivationIdentity(),
)

internal fun runtimePlaylistItems(session: PlaybackSession): List<ManifestItem> {
    val items = session.content.manifest.playlist?.items ?: return emptyList()
    if (session.content.manifest.syncGroup != null) return items
    val start = session.initialCursor.index
    if (start !in items.indices || start == 0) return items
    return items.drop(start) + items.take(start)
}

/**
 * The selected root Layout as one shared-runtime playlist item, mirroring
 * the Edge reference host: a single layout reference with no finite
 * duration, so it persists until schedule/manifest/presentation replacement.
 */
internal fun rootLayoutItem(layout: ManifestLayout): ManifestItem = ManifestItem(
    id = "layout-${layout.id}",
    assetId = layout.id,
    assetType = "layout",
    layoutId = layout.id,
    durationMs = null,
    fitMode = "contain",
    transition = "none",
    audioEnabled = false,
    volume = 0f,
    deliveryPolicy = "stream",
)

/**
 * Apply the player defaults only where a manifest item does not carry a
 * usable value. Author-provided item values remain authoritative. The
 * server's current manifest normally contains all fields; these guards keep
 * older or hand-authored manifests deterministic while a player configuration
 * is being rolled out.
 */
internal fun ManifestItem.withPlaybackDefaults(defaults: PlayerPlaybackDefaults?): ManifestItem {
    if (defaults == null) return this
    val fit = if (usePlayerDefaults) {
        defaults.defaultFitMode
    } else {
        fitMode.takeIf { it in setOf("contain", "cover", "stretch") }
            ?: defaults.defaultFitMode
    }
    val transitionValue = if (usePlayerDefaults) {
        defaults.defaultTransition
    } else {
        transition.takeIf { it in setOf("none", "fade", "crossfade") }
            ?: defaults.defaultTransition
    }
    val duration = if (usePlayerDefaults && assetType == "image") {
        defaults.defaultImageDurationSeconds.coerceAtLeast(1).toLong() * 1_000L
    } else durationMs ?: if (assetType == "image") {
        defaults.defaultImageDurationSeconds.coerceAtLeast(1).toLong() * 1_000L
    } else null
    val volumeValue = if (usePlayerDefaults) {
        defaults.defaultVolume.toFloat().coerceIn(0f, 1f)
    } else {
        volume.takeIf { it.isFinite() && it in 0f..1f }
            ?: defaults.defaultVolume.toFloat().coerceIn(0f, 1f)
    }
    return copy(
        durationMs = duration,
        fitMode = fit,
        transition = transitionValue,
        audioEnabled = if (usePlayerDefaults) defaults.defaultAudioEnabled else audioEnabled,
        volume = volumeValue,
    )
}
