package org.tilecast.player.content

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestLayout
import org.tilecast.player.network.PlayerPlaybackDefaults
import org.tilecast.player.network.PlayerWebsitePolicy
import org.tilecast.player.ui.theme.SignalBackground
import org.tilecast.player.ui.theme.SignalText
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

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

@Composable
fun FullscreenPlayback(
    session: PlaybackSession,
    onBoundary: (String, String) -> Unit,
    onError: (String) -> Unit,
    onWebsiteStatus: (WebsitePlaybackStatus) -> Unit = {},
    onWidgetStatus: (WidgetPlaybackStatus) -> Unit = {},
    onProgress: () -> Unit = {},
) {
    CompositionLocalProvider(
        LocalTilecastRegionalFormatting provides session.playbackDefaults?.regionalFormat,
    ) {
        FullscreenPlaybackBody(session, onBoundary, onError, onWebsiteStatus, onWidgetStatus, onProgress)
    }
}

@Composable
private fun FullscreenPlaybackBody(
    session: PlaybackSession,
    onBoundary: (String, String) -> Unit,
    onError: (String) -> Unit,
    onWebsiteStatus: (WebsitePlaybackStatus) -> Unit,
    onWidgetStatus: (WidgetPlaybackStatus) -> Unit,
    onProgress: () -> Unit,
) {
    val takeoverDecision = TakeoverController.evaluate(
        session.content.serverNow(),
        session.content.manifest.effectiveTakeover,
        true,
    )
    val activityReporter = rememberPlaybackActivityReporter(session, takeoverDecision)
    // Authoritative shared runtime: every presentation plays in the trusted
    // Player Runtime WebView. A selected root Layout plays as one layout
    // reference through the same path. Anything the runtime cannot render
    // fails closed with an explicit error; there is no second presentation
    // implementation to fall back to. Media availability stays per-item in
    // the projector, matching the reference hosts.
    val sharedRuntimeItems = runtimePlaylistItems(session)
    val rootLayout = session.content.manifest.layout
    val runtimeItems = if (rootLayout != null) listOf(rootLayoutItem(rootLayout)) else sharedRuntimeItems
    val renderable = runtimeItems.isNotEmpty() && runtimeItems.all { item ->
        org.tilecast.player.runtime.RuntimePresentationBuilder.isRuntimeRenderable(
            session.content.manifest, item, rootLayout,
        )
    }
    if (!renderable && runtimeItems.isNotEmpty()) {
        androidx.compose.runtime.LaunchedEffect(runtimeItems) { onError("unsupported_content") }
        EmptyPlayback("Content not supported by this player")
        return
    }
    if (renderable) {
        val runtimeManifest = session.content.manifest
        val runtimeActivity = rememberRuntimeActivityTracker(activityReporter, session)
        val runtimeActivationId = session.runtimeActivation.id
        val runtimeMessage = org.tilecast.player.runtime.RuntimePresentationBuilder.hostMessage(
            org.tilecast.player.runtime.RuntimeScreenState.Playing(
                content = session.content,
                items = runtimeItems,
                fullscreenLayout = rootLayout,
                playbackDefaults = session.playbackDefaults,
                websitePolicy = session.websitePolicy,
                activationId = runtimeActivationId,
                generation = session.runtimeActivation.generation,
                takeover = runtimeManifest.effectiveTakeover != null,
                nowMillis = session.content.serverNow().toEpochMilli(),
                clockOffsetMillis = session.content.serverClockOffsetMillis ?: 0L,
                playbackAnchorMillis = session.playbackAnchor?.toEpochMilli(),
            ),
        )
        val runtimeContext = androidx.compose.ui.platform.LocalContext.current
        org.tilecast.player.runtime.SharedRuntimePlayback(
            session = session,
            items = runtimeItems,
            message = runtimeMessage,
            activationId = runtimeActivationId,
            hostVersion = org.tilecast.player.BuildConfig.VERSION_NAME,
            engineVersion = androidx.webkit.WebViewCompat.getCurrentWebViewPackage(runtimeContext)?.versionName ?: "unknown",
            onBoundary = { itemId, assetId ->
                runtimeActivity?.boundary(itemId)
                onBoundary(itemId, assetId)
            },
            onError = onError,
            onProgress = onProgress,
            onFirstFrame = { onProgress() },
            onItemTransition = { runtimeActivity?.transition(it) },
            onPlaybackError = { itemId, message -> runtimeActivity?.fail(itemId, message) },
            onWidgetStatus = onWidgetStatus,
            onWebsiteStatus = onWebsiteStatus,
        )
        return
    }
    // Unreachable in practice: an empty selection means no layout and no
    // playlist items, so this is the idle state, not an error.
    EmptyPlayback("No content assigned")
}

@Composable
private fun EmptyPlayback(message: String) {
    Box(Modifier.fillMaxSize().background(SignalBackground), contentAlignment = Alignment.Center) {
        androidx.compose.material3.Text(message, color = SignalText)
    }
}


