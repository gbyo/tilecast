package org.tilecast.player.content

import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import org.tilecast.player.activity.PlaybackActivityReporter
import org.tilecast.player.activity.PlayerActivityQueue
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestDataSource
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.DisplayWidgetConfig
import org.tilecast.player.network.TickerWidgetConfig
import org.tilecast.player.network.StructuredSourceConfig
import java.security.MessageDigest
import java.time.LocalDate

private val activityFlushScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

@Composable
internal fun rememberPlaybackActivityReporter(
    session: PlaybackSession,
    takeoverDecision: TakeoverDecision,
): PlaybackActivityReporter {
    val context = LocalContext.current
    val manifest = session.content.manifest
    val presentationType = if (manifest.layout != null) "layout" else "playlist"
    val presentationId = manifest.layout?.id ?: manifest.playlist?.id.orEmpty()
    val presentationRevision = manifest.layout?.revision?.toString() ?: manifest.playlist?.revision?.toString().orEmpty()
    val activeTakeover = manifest.effectiveTakeover.takeIf { takeoverDecision.active }
    val reporter = remember(manifest.manifestVersion, presentationId, presentationRevision, activeTakeover?.id) {
        PlaybackActivityReporter(
            queue = PlayerActivityQueue.get(context),
            manifestVersion = manifest.manifestVersion,
            presentationType = presentationType,
            presentationId = presentationId,
            presentationRevision = presentationRevision,
            trigger = when {
                activeTakeover != null -> "takeover"
                manifest.schedules.isNotEmpty() -> "schedule"
                else -> "direct_assignment"
            },
            scheduleId = manifest.schedules.firstOrNull()?.id.orEmpty(),
            takeoverId = activeTakeover?.id.orEmpty(),
        )
    }
    LaunchedEffect(reporter) {
        while (true) {
            PlayerActivityQueue.get(context).flushConfigured()
            delay(30_000)
        }
    }
    DisposableEffect(reporter) {
        reporter.presentationStarted()
        activityFlushScope.launch { PlayerActivityQueue.get(context).flushConfigured() }
        onDispose {
            reporter.presentationStopped("partial")
            activityFlushScope.launch { PlayerActivityQueue.get(context).flushConfigured() }
        }
    }
    return reporter
}

internal data class DateAwareAttribution(
    val sourceId: String = "",
    val selectedRecordId: String = "",
    val sourceCachedAt: String? = null,
    val sourceRevision: String = "",
    val snapshotHash: String = "",
)

@Composable
internal fun rememberActivityChild(
    reporter: PlaybackActivityReporter?,
    item: ManifestItem,
    widget: ManifestWidget?,
    layoutPlacementId: String,
    dataSources: List<ManifestDataSource>,
    boundDataSource: ManifestDataSource? = null,
): ActivityChildTracker? {
    if (reporter == null) return null
    val attribution = remember(widget?.assetId, widget?.configuration, boundDataSource?.id, dataSources) {
        boundDataSource?.let { dataSourceAttribution(it) } ?: widgetAttribution(widget, dataSources)
    }
    val contentType = when {
        widget != null || boundDataSource != null -> "widget"
        item.assetType == "widget" || item.assetType == "website" -> "widget"
        else -> "media"
    }
    val tracker = remember(item.id, item.assetId, layoutPlacementId, reporter) {
        val session = reporter.childStarted(
            contentType = contentType,
            contentId = item.assetId,
            playlistItemId = if (layoutPlacementId.isEmpty()) item.id else item.id.takeUnless { it.startsWith("layout-") }.orEmpty(),
            layoutPlacementId = layoutPlacementId,
            expectedDurationMs = item.durationMs?.takeUnless { it == Long.MAX_VALUE },
            sourceId = attribution.sourceId,
            selectedRecordId = attribution.selectedRecordId,
            sourceCachedAt = attribution.sourceCachedAt,
            sourceRevision = attribution.sourceRevision,
            snapshotHash = attribution.snapshotHash,
        )
        ActivityChildTracker(session)
    }
    DisposableEffect(tracker) {
        onDispose { tracker.finishIfNeeded("completed") }
    }
    return tracker
}

internal class RuntimeActivityTracker(
    private val reporter: PlaybackActivityReporter,
    private val session: PlaybackSession,
) {
    private var currentItemId: String? = null
    private var current: ActivityChildTracker? = null

    fun boundary(itemId: String) {
        current?.complete()
        current = null
        currentItemId = null
        val manifest = session.content.manifest
        val item = manifest.playlist?.items?.firstOrNull { it.id == itemId }
            ?.withPlaybackDefaults(session.playbackDefaults) ?: return
        val widget = manifest.widgets.firstOrNull { it.assetId == item.assetId }
        val attribution = widgetAttribution(widget, manifest.dataSources)
        val contentType = if (
            widget != null || item.assetType == "widget" || item.assetType == "website"
        ) "widget" else "media"
        current = ActivityChildTracker(
            reporter.childStarted(
                contentType = contentType,
                contentId = item.assetId,
                playlistItemId = item.id,
                layoutPlacementId = "",
                expectedDurationMs = item.durationMs?.takeUnless { it == Long.MAX_VALUE },
                sourceId = attribution.sourceId,
                selectedRecordId = attribution.selectedRecordId,
                sourceCachedAt = attribution.sourceCachedAt,
                sourceRevision = attribution.sourceRevision,
                snapshotHash = attribution.snapshotHash,
            ),
        )
        currentItemId = item.id
    }

    fun transition(itemId: String) {
        if (currentItemId != itemId) return
        current?.complete()
        current = null
        currentItemId = null
    }

    fun stop() {
        current?.finishIfNeeded("partial")
        current = null
        currentItemId = null
    }
}

@Composable
internal fun rememberRuntimeActivityTracker(
    reporter: PlaybackActivityReporter?,
    session: PlaybackSession,
): RuntimeActivityTracker? {
    if (reporter == null) return null
    val manifest = session.content.manifest
    val tracker = remember(reporter, manifest.manifestVersion, manifest.playlist?.id) {
        RuntimeActivityTracker(reporter, session)
    }
    DisposableEffect(tracker) {
        onDispose { tracker.stop() }
    }
    return tracker
}

internal class ActivityChildTracker(
    private val session: PlaybackActivityReporter.ChildSession,
) {
    private var finished = false
    private val startedElapsed = SystemClock.elapsedRealtime()

    fun complete() = finishIfNeeded("completed")
    fun skip() = finishIfNeeded("skipped", terminalReason = "empty_content")
    fun fail(message: String) = finishIfNeeded("failed", "renderer_failure", message)

    fun finishIfNeeded(result: String, code: String = "", message: String = "", terminalReason: String = "") {
        if (finished) return
        finished = true
        if (terminalReason.isEmpty()) session.finish(result, code, message)
        else session.finish(result, code, message, terminalReason)
    }

    fun elapsedMs(): Long = SystemClock.elapsedRealtime() - startedElapsed
}

private fun widgetAttribution(widget: ManifestWidget?, dataSources: List<ManifestDataSource>): DateAwareAttribution {
    if (widget == null) return DateAwareAttribution()
    val boundDataSourceId = when (widget.provider) {
        "menu", "list", "table", "agenda" -> runCatching {
            Json.decodeFromJsonElement<DisplayWidgetConfig>(widget.configuration).dataSourceId
        }.getOrNull()
        "ticker" -> runCatching {
            Json.decodeFromJsonElement<TickerWidgetConfig>(widget.configuration).dataSourceId
        }.getOrNull()
        else -> null
    }
    val dataSource = boundDataSourceId?.let { id -> dataSources.firstOrNull { it.id == id } }
        ?: return DateAwareAttribution(sourceId = widget.assetId)
    return dataSourceAttribution(dataSource)
}

private fun dataSourceAttribution(dataSource: ManifestDataSource): DateAwareAttribution {
    if (dataSource.provider !in setOf("rss", "atom", "json", "csv")) {
        return DateAwareAttribution(sourceId = dataSource.id)
    }
    val configuration = runCatching {
        Json.decodeFromJsonElement<StructuredSourceConfig>(dataSource.configuration)
    }.getOrNull() ?: return DateAwareAttribution(sourceId = dataSource.id)
    val today = LocalDate.now().toString()
    val selected = if (configuration.dateSelection.enabled) {
        configuration.data.records.firstOrNull { it.date.startsWith(today) }
            ?: configuration.data.records.firstOrNull()
    } else {
        configuration.data.records.firstOrNull()
    }
    val seed = listOf(
        dataSource.id,
        selected?.id.orEmpty(),
        today,
        configuration.data.cachedAt.orEmpty(),
    ).joinToString("|")
    val hash = MessageDigest.getInstance("SHA-256")
        .digest(seed.toByteArray())
        .joinToString("") { "%02x".format(it) }
    return DateAwareAttribution(
        sourceId = dataSource.id,
        selectedRecordId = selected?.id.orEmpty(),
        sourceCachedAt = configuration.data.cachedAt,
        sourceRevision = configuration.data.cachedAt.orEmpty(),
        snapshotHash = hash,
    )
}
