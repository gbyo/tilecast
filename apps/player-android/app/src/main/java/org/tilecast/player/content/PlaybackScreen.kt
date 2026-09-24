package org.tilecast.player.content

import android.graphics.BitmapFactory
import android.net.Uri
import android.os.SystemClock
import android.view.TextureView
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.OkHttpClient
import okhttp3.Request
import org.tilecast.player.activity.PlaybackActivityReporter
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.ManifestWebsite
import org.tilecast.player.network.PlayerPlaybackDefaults
import org.tilecast.player.network.PlayerWebsitePolicy
import org.tilecast.player.network.WebsiteSourceConfig
import org.tilecast.player.network.YouTubeSourceConfig
import org.tilecast.player.ui.theme.SignalBackground
import org.tilecast.player.ui.theme.SignalText
import java.io.File
import java.time.Instant

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
    session.content.manifest.layout?.let { layout ->
        FullscreenLayoutPlayback(session, layout, onError, onWebsiteStatus, onWidgetStatus, onProgress, activityReporter)
        return
    }
    val playlist = session.content.manifest.playlist
    if (playlist == null || playlist.items.isEmpty()) {
        EmptyPlayback("No content assigned")
        return
    }

    val synchronizedTimeline = remember(
        session.content.manifest.manifestVersion,
        playlist.id,
        playlist.revision,
        session.startedAtElapsedRealtimeMs,
    ) {
        if (session.content.manifest.syncGroup == null) {
            null
        } else {
            SynchronizedPlaybackTimeline.fromInitialPosition(
                playlist = playlist,
                assets = session.content.manifest.assets,
                initialCursor = session.initialCursor,
                initialOffsetMs = session.initialOffsetMs,
                startedAtElapsedRealtimeMs = session.startedAtElapsedRealtimeMs,
            )
        }
    }

    var cursor by remember(session.content.manifest.manifestVersion) { mutableStateOf(session.initialCursor) }
    var synchronizedOffsetMs by remember(session.content.manifest.manifestVersion) { mutableStateOf(session.initialOffsetMs) }
    var consecutiveFailures by remember { mutableIntStateOf(0) }
    var consecutiveEmptySkips by remember { mutableIntStateOf(0) }

    LaunchedEffect(synchronizedTimeline) {
        val timeline = synchronizedTimeline ?: return@LaunchedEffect
        while (true) {
            val expected = timeline.positionAt(SystemClock.elapsedRealtime())
            if (cursor != expected.cursor) cursor = expected.cursor
            if (synchronizedOffsetMs != expected.offsetMs) synchronizedOffsetMs = expected.offsetMs
            delay(100)
        }
    }

    val item = playlist.items[cursor.index.coerceIn(0, playlist.items.lastIndex)]
        .withPlaybackDefaults(session.playbackDefaults)
    val website = session.content.manifest.websites.firstOrNull { it.assetId == item.assetId }?.withPolicy(session.websitePolicy)
    val widget = session.content.manifest.widgets.firstOrNull { it.assetId == item.assetId }
    val layout = item.layoutId?.let { id -> session.content.manifest.layouts.firstOrNull { it.id == id } }
    val asset = item.variantId?.let { variant -> session.content.manifest.assets.firstOrNull { it.variantId == variant } }

    // Keyed on the occurrence too: a single-item playlist still crosses real timeline
    // boundaries, which activates pending manifests and feeds the stall watchdog.
    LaunchedEffect(item.id, cursor.cycle) { onBoundary(item.id, item.assetId) }

    fun advance(failed: Boolean = false, empty: Boolean = false) {
        consecutiveFailures = if (failed) consecutiveFailures + 1 else 0
        consecutiveEmptySkips = if (empty) consecutiveEmptySkips + 1 else 0
        if (synchronizedTimeline == null) cursor = nextPlaybackCursor(cursor, playlist.items.size)
    }

    if (asset == null && website == null && widget == null && layout == null) {
        LaunchedEffect(item.id, cursor.cycle) {
            onError("Manifest item has no content")
            delay(1_000)
            advance(true)
        }
        return
    }
    if (synchronizedTimeline == null && consecutiveFailures >= playlist.items.size) {
        EmptyPlayback("No playable content")
        LaunchedEffect(consecutiveFailures) {
            delay(5_000)
            consecutiveFailures = 0
        }
        return
    }
    if (synchronizedTimeline == null && consecutiveEmptySkips >= playlist.items.size) {
        EmptyPlayback("No playlist items currently have content")
        LaunchedEffect(consecutiveEmptySkips) {
            delay(30_000)
            consecutiveEmptySkips = 0
        }
        return
    }

    key(session.content.manifest.manifestVersion, playlist.id, playlist.revision) {
        SeamlessItemSwap(
            cursor = cursor,
            animateFor = { shouldAnimateTransition(playlist.items[it.index.coerceIn(0, playlist.items.lastIndex)].transition) },
        ) { entryCursor, isActive, onFirstFrame ->
            val renderedItem = playlist.items[entryCursor.index.coerceIn(0, playlist.items.lastIndex)]
                .withPlaybackDefaults(session.playbackDefaults)
            val renderedAsset = renderedItem.variantId?.let { variant -> session.content.manifest.assets.firstOrNull { it.variantId == variant } }
            val renderedWebsite = session.content.manifest.websites.firstOrNull { it.assetId == renderedItem.assetId }?.withPolicy(session.websitePolicy)
            val renderedWidget = session.content.manifest.widgets.firstOrNull { it.assetId == renderedItem.assetId }
            // An entry always mounts as the current item, so its start offset is
            // whatever the timeline says at mount time.
            val startOffset = remember {
                when {
                    synchronizedTimeline != null -> synchronizedOffsetMs
                    entryCursor == session.initialCursor -> session.initialOffsetMs
                    else -> 0
                }
            }
            RenderedItem(
                renderedItem,
                renderedAsset,
                renderedWebsite,
                renderedWidget,
                session,
                startOffset,
                { if (isActive.value) advance() },
                { if (isActive.value) { onError(it); advance(true) } },
                onWebsiteStatus,
                onWidgetStatus,
                onProgress,
                activityReporter,
                synchronizedPositionMs = synchronizedOffsetMs.takeIf { synchronizedTimeline != null && isActive.value },
                isActive = isActive.value,
                onFirstFrame = onFirstFrame,
                useCompositableVideo = requiresCompositableVideo(playlist, entryCursor.index),
                onSkip = { if (isActive.value) advance(empty = true) },
            )
        }
    }
}

/**
 * Resolve the server-authoritative website policy at the last point before a
 * WebView is created. The organization defaults are used while authoring a
 * site, but the player policy is an operational guardrail and therefore wins
 * over a stale manifest for timeout and cookie handling.
 */
internal fun resolveWebsitePolicy(site: ManifestWebsite, policy: PlayerWebsitePolicy?): ManifestWebsite {
    if (policy == null) return site
    val cookiePolicy = policy.cookiePolicy
        .takeIf { it in setOf("disabled", "first_party", "first_and_third_party") }
        ?: site.cookiePolicy.ifBlank { policy.defaultCookiePolicy }
    val timeoutSeconds = policy.timeoutSeconds.takeIf { it in 1..120 }
        ?: site.loadTimeoutSeconds.takeIf { it in 1..120 }
        ?: policy.defaultTimeoutSeconds
    return site.copy(
        javascriptEnabled = site.javascriptEnabled,
        domStorageEnabled = site.domStorageEnabled,
        cookiePolicy = cookiePolicy,
        reloadPolicy = site.reloadPolicy.ifBlank { policy.defaultReloadPolicy },
        refreshIntervalSeconds = site.refreshIntervalSeconds?.takeIf { it >= policy.minimumRefreshSeconds },
        loadTimeoutSeconds = timeoutSeconds,
        zoomPercent = site.zoomPercent.takeIf { it in 50..200 } ?: policy.defaultZoomPercent,
        failureBehavior = site.failureBehavior.ifBlank { policy.defaultFailureBehavior },
    )
}

private fun ManifestWebsite.withPolicy(policy: PlayerWebsitePolicy?): ManifestWebsite =
    resolveWebsitePolicy(this, policy)

@Composable
internal fun RenderedItem(
    item: ManifestItem,
    asset: ManifestAsset?,
    website: ManifestWebsite?,
    widget: ManifestWidget?,
    session: PlaybackSession,
    startOffsetMs: Long,
    onDone: () -> Unit,
    onFailure: (String) -> Unit,
    onWebsiteStatus: (WebsitePlaybackStatus) -> Unit,
    onWidgetStatus: (WidgetPlaybackStatus) -> Unit,
    onProgress: () -> Unit,
    activityReporter: PlaybackActivityReporter? = null,
    layoutPlacementId: String = "",
    synchronizedPositionMs: Long? = null,
    isActive: Boolean = true,
    onFirstFrame: () -> Unit = {},
    useCompositableVideo: Boolean = false,
    onSkip: () -> Unit = onDone,
) {
    val tracker = rememberActivityChild(activityReporter, item, widget, layoutPlacementId, session.content.manifest.dataSources)
    val done = { tracker?.complete(); onDone() }
    val skipped = { tracker?.skip(); onSkip() }
    val failed: (String) -> Unit = { message -> tracker?.fail(message); onFailure(message) }
    val layout = item.layoutId?.let { id -> session.content.manifest.layouts.firstOrNull { it.id == id } }
    // Images, videos, and WebView-backed items report their first visible frame
    // themselves. Native widgets draw immediately; Layouts aggregate their
    // visible child readiness before reporting a frame.
    val reportsOwnFirstFrame =
        (widget == null && website == null && asset != null && !(item.assetType == "layout" && layout != null)) ||
            website != null ||
            (session.content.manifest.schemaVersion >= 13 && widget?.presentation?.kind == "web") ||
            widget?.provider == "website" ||
            (item.assetType == "layout" && layout != null)
    if (!reportsOwnFirstFrame) LaunchedEffect(item.id) { onFirstFrame() }
    if (item.assetType == "layout" && layout != null) {
        FullscreenLayoutPlayback(session, layout, failed, onWebsiteStatus, onWidgetStatus, onProgress, activityReporter, onFirstFrame, useCompositableVideo)
        LaunchedEffect(item.id) { delay(((item.durationMs ?: 30_000) - startOffsetMs).coerceAtLeast(1)); done() }
    } else if (session.content.manifest.schemaVersion >= 13 && widget?.presentation?.kind == "native") {
        DeclarativeWidgetItem(
            item,
            widget,
            session,
            done,
            skipped,
            failed,
            onWidgetStatus,
            startOffsetMs,
            allowAutoSkip = layoutPlacementId.isEmpty() && synchronizedPositionMs == null,
        )
    } else if (session.content.manifest.schemaVersion >= 13 && widget?.presentation?.kind == "web") {
        val descriptor = widget.presentation.web
        if (descriptor == null || descriptor.mode != "remote") {
            failed("Web presentation is unavailable")
            return
        }
        val reloadInterval = descriptor.reload?.takeIf { it.mode == "periodic" }?.intervalSeconds
        WebsiteItem(item, ManifestWebsite(widget.assetId, widget.name, descriptor.url, descriptor.allowedHosts, true, false, "none", if (reloadInterval != null) "interval" else "on_each_activation", reloadInterval, descriptor.loadTimeoutSeconds, 100, 0, 0, "", "#0E141B", descriptor.fallbackBehavior, null, null), session, done, startOffsetMs, onFirstFrame) { status ->
            onWebsiteStatus(status)
            onWidgetStatus(WidgetPlaybackStatus(widget.assetId, "web", status.state, status.failureCategory))
        }
    } else if (widget?.provider == "website") {
        val config = runCatching { Json.decodeFromJsonElement<WebsiteSourceConfig>(widget.configuration) }.getOrElse {
            failed("Website widget configuration is invalid")
            return
        }
        WebsiteItem(item, ManifestWebsite(widget.assetId, widget.name, config.url, config.allowedHosts, config.javascriptEnabled, config.domStorageEnabled, config.cookiePolicy, config.reloadPolicy, config.refreshIntervalSeconds, config.loadTimeoutSeconds, config.zoomPercent, config.scrollX, config.scrollY, config.customUserAgent, config.backgroundColor, config.failureBehavior, config.fallbackImageAssetId, config.fallbackVariantId), session, done, startOffsetMs, onFirstFrame) { status ->
            onWebsiteStatus(status)
            onWidgetStatus(WidgetPlaybackStatus(widget.assetId, "website", status.state, status.failureCategory))
        }
    } else if (widget?.provider == "youtube") {
        val config = runCatching { Json.decodeFromJsonElement<YouTubeSourceConfig>(widget.configuration) }.getOrElse {
            failed("YouTube widget configuration is invalid")
            return
        }
        YouTubeWidgetItem(item, widget, config, session, done, failed, onWidgetStatus, startOffsetMs)
    } else if (widget?.provider in setOf("clock", "date", "qrcode", "countdown", "ticker", "menu", "list", "table", "agenda", "metric", "cards", "weather")) {
        WidgetItem(item, widget ?: return, session, done, failed, onWidgetStatus, startOffsetMs)
    } else if (website != null) {
        WebsiteItem(item, website, session, done, startOffsetMs, onFirstFrame, onWebsiteStatus)
    } else if (asset?.mimeType?.startsWith("image/") == true) {
        ImageItem(item, asset, session, startOffsetMs, done, failed, onProgress, onFirstFrame)
    } else if (asset != null) {
        VideoItem(item, asset, session, startOffsetMs, done, failed, onProgress, synchronizedPositionMs, isActive, onFirstFrame, useCompositableVideo)
    }
}

@Composable
private fun EmptyPlayback(message: String) {
    Box(Modifier.fillMaxSize().background(SignalBackground), contentAlignment = Alignment.Center) {
        androidx.compose.material3.Text(message, color = SignalText)
    }
}

@Composable
private fun ImageItem(
    item: ManifestItem,
    asset: ManifestAsset,
    session: PlaybackSession,
    startOffsetMs: Long,
    onDone: () -> Unit,
    onFailure: (String) -> Unit,
    onProgress: () -> Unit,
    onFirstFrame: () -> Unit,
) {
    val variantId = item.variantId ?: return
    var bitmap by remember(item.id) { mutableStateOf(session.content.localFiles[variantId]?.let { BitmapFactory.decodeFile(it) }) }
    val hasBitmap = bitmap != null
    LaunchedEffect(hasBitmap) { if (hasBitmap) onFirstFrame() }
    LaunchedEffect(item.id) {
        if (bitmap == null) bitmap = runCatching {
            withContext(Dispatchers.IO) {
                session.content.localFiles[variantId]?.let { BitmapFactory.decodeFile(it) }
                    ?: OkHttpClient().newCall(
                        Request.Builder().url(session.serverUrl + asset.downloadPath).header("Authorization", "Bearer ${session.credential}").build(),
                    ).execute().use { response ->
                        if (!response.isSuccessful) error("Image stream unavailable")
                        BitmapFactory.decodeStream(response.body?.byteStream())
                    }
            }
        }.getOrElse {
            onFailure("Image could not be displayed")
            return@LaunchedEffect
        }
        // Report progress periodically for the whole dwell, not just once at load: the stall
        // watchdog defaults to 30s and a still image legitimately displays much longer than
        // that (Layout placements dwell indefinitely).
        onProgress()
        val total = ((item.durationMs ?: 10_000) - startOffsetMs).coerceAtLeast(1)
        var elapsed = 0L
        while (elapsed < total) {
            val step = minOf(15_000L, total - elapsed)
            delay(step)
            elapsed += step
            onProgress()
        }
        onDone()
    }
	bitmap?.let {
		val canvas = session.content.manifest.canvas
		val viewport = session.content.manifest.viewport
		val imageModifier = if (canvas != null && viewport != null) {
			Modifier.fillMaxSize().background(Color.Black).graphicsLayer {
				transformOrigin = TransformOrigin(0f, 0f)
				val sx = canvas.width.toFloat() / viewport.width.toFloat()
				val sy = canvas.height.toFloat() / viewport.height.toFloat()
				scaleX = sx
				scaleY = sy
				translationX = -viewport.x * sx
				translationY = -viewport.y * sy
				rotationZ = viewport.rotation.toFloat()
			}
		} else {
			Modifier.fillMaxSize().background(Color.Black)
		}
		Image(it.asImageBitmap(), null, imageModifier, contentScale = scale(item.fitMode))
	}
}

@OptIn(UnstableApi::class)
@Composable
private fun VideoItem(
    item: ManifestItem,
    asset: ManifestAsset,
    session: PlaybackSession,
    startOffsetMs: Long,
    onDone: () -> Unit,
    onFailure: (String) -> Unit,
    onProgress: () -> Unit,
    synchronizedPositionMs: Long?,
    isActive: Boolean,
    onFirstFrame: () -> Unit,
    useCompositableVideo: Boolean,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val latestSynchronizedPosition = rememberUpdatedState(synchronizedPositionMs)
    var videoAspectRatio by remember(item.id) { mutableFloatStateOf(0f) }
    val player = remember(item.id) {
        val http = OkHttpDataSource.Factory(OkHttpClient()).setDefaultRequestProperties(mapOf("Authorization" to "Bearer ${session.credential}"))
        val source = DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http))
        ExoPlayer.Builder(context).setMediaSourceFactory(source).build().apply {
            volume = if (item.audioEnabled) item.volume else 0f
            setMediaItem(MediaItem.fromUri(item.variantId?.let { session.content.localFiles[it] }?.let { Uri.fromFile(File(it)) } ?: Uri.parse(session.serverUrl + asset.downloadPath)))
            prepare()
            seekTo((item.videoStartOffsetMs ?: 0) + startOffsetMs)
            playWhenReady = true
        }
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED && latestSynchronizedPosition.value == null) onDone()
            }

            override fun onPlayerError(error: PlaybackException) { onFailure("Video playback failed") }

            override fun onRenderedFirstFrame() { onFirstFrame() }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                videoAspectRatio = if (videoSize.height == 0) 0f else videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }
    // A demoted item only stays mounted to hold its last frame while the next
    // item gets ready — it must not keep playing audibly underneath.
    LaunchedEffect(isActive) {
        if (!isActive) {
            player.volume = 0f
            player.pause()
        }
    }
    LaunchedEffect(player) {
        var previousPosition = -1L
        while (true) {
            delay(5_000)
            val position = player.currentPosition
            if (player.isPlaying && position > previousPosition) onProgress()
            previousPosition = position
        }
    }
    LaunchedEffect(player, item.id) {
        while (true) {
            delay(500)
            val synchronizedPosition = latestSynchronizedPosition.value ?: continue
            val expectedPosition = (item.videoStartOffsetMs ?: 0) + synchronizedPosition
            val correction = videoDriftCorrection(expectedPosition, player.currentPosition)
            when (correction.action) {
                VideoCorrectionAction.NONE -> {
                    if (player.playbackParameters.speed != 1f) player.setPlaybackSpeed(1f)
                }
                VideoCorrectionAction.SPEED -> {
                    if (player.playbackParameters.speed != correction.playbackSpeed) player.setPlaybackSpeed(correction.playbackSpeed)
                }
                VideoCorrectionAction.SEEK -> {
                    player.setPlaybackSpeed(1f)
                    player.seekTo(correction.seekPositionMs ?: expectedPosition)
                    player.playWhenReady = true
                }
            }
        }
    }
    item.videoEndOffsetMs?.let { end ->
        LaunchedEffect(player, end) {
            while (true) {
                delay(250)
                if (player.currentPosition >= end) {
                    player.pause()
                    if (latestSynchronizedPosition.value == null) onDone()
                    break
                }
            }
        }
    }
    if (useCompositableVideo) {
        AndroidView(
            factory = { context ->
                AspectRatioFrameLayout(context).apply {
                    resizeMode = resize(item.fitMode)
                    val texture = TextureView(context)
                    addView(texture, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    player.setVideoTextureView(texture)
                }
            },
            modifier = Modifier.fillMaxSize(),
            update = {
                it.resizeMode = resize(item.fitMode)
                it.setAspectRatio(videoAspectRatio)
            },
            onRelease = { player.clearVideoTextureView(it.getChildAt(0) as TextureView) },
        )
    } else {
        AndroidView(
            factory = { PlayerView(it).apply { useController = false; this.player = player; resizeMode = resize(item.fitMode) } },
            modifier = Modifier.fillMaxSize(),
            update = { it.resizeMode = resize(item.fitMode) },
        )
    }
}

private fun scale(mode: String) = when (mode) {
    "cover" -> ContentScale.Crop
    "stretch" -> ContentScale.FillBounds
    else -> ContentScale.Fit
}

@UnstableApi
private fun resize(mode: String) = when (mode) {
    "cover" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
    "stretch" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
    else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
}
