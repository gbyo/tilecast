package org.tilecast.player.activity

import android.content.Context
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.tilecast.player.data.ConfigurationRepository
import org.tilecast.player.data.PlayerDatabase
import org.tilecast.player.network.PlayerActivityBatch
import org.tilecast.player.network.PlayerActivityEvent
import org.tilecast.player.network.TilecastApi
import org.tilecast.player.network.activityEvents
import org.tilecast.player.security.KeystoreCredentialStore
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.Executors

@Serializable
internal data class PersistedActivityQueue(
    val nextSequence: Long = 1,
    val events: List<PlayerActivityEvent> = emptyList(),
)

internal class ActivityQueueStore(
    private val file: File,
    private val maximumEvents: Int = 5_000,
    private val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true },
) {
    private val lock = Any()

    fun append(event: PlayerActivityEvent): PlayerActivityEvent = synchronized(lock) {
        val current = read()
        val sequenced = event.copy(sequence = current.nextSequence)
        val kept = trim(current.events + sequenced)
        write(PersistedActivityQueue(current.nextSequence + 1, kept))
        sequenced
    }

    fun peek(limit: Int): List<PlayerActivityEvent> = synchronized(lock) {
        read().events.sortedBy { it.sequence }.take(limit.coerceIn(1, 200))
    }

    fun acknowledge(ids: Set<String>, highestSequence: Long = 0) = synchronized(lock) {
        if (ids.isEmpty() && highestSequence <= 0) return@synchronized
        val current = read()
        val next = maxOf(current.nextSequence, highestSequence + 1)
        write(
            current.copy(
                nextSequence = next,
                events = current.events.filterNot { it.id in ids },
            ),
        )
    }

    fun size(): Int = synchronized(lock) { read().events.size }

    private fun trim(events: List<PlayerActivityEvent>): List<PlayerActivityEvent> {
        if (events.size <= maximumEvents) return events
        val overflow = events.size - maximumEvents
        val lowPriority = events.withIndex().filter { it.value.priority <= 4 }.take(overflow).map { it.index }.toSet()
        val remainingOverflow = overflow - lowPriority.size
        val oldestRemaining = events.indices.filterNot { it in lowPriority }.take(remainingOverflow).toSet()
        val dropped = lowPriority + oldestRemaining
        return events.filterIndexed { index, _ -> index !in dropped }
    }

    private fun read(): PersistedActivityQueue {
        if (!file.exists()) return PersistedActivityQueue()
        return runCatching { json.decodeFromString<PersistedActivityQueue>(file.readText()) }.getOrElse { PersistedActivityQueue() }
    }

    private fun write(value: PersistedActivityQueue) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.tmp")
        FileOutputStream(temporary).use { output ->
            output.write(json.encodeToString(PersistedActivityQueue.serializer(), value).toByteArray())
            output.fd.sync()
        }
        if (!temporary.renameTo(file)) {
            file.delete()
            check(temporary.renameTo(file)) { "Could not persist Player activity queue" }
        }
    }
}

internal class ActivityRetryBackoff(
    private val minimumDelayMs: Long = 5_000,
    private val maximumDelayMs: Long = 300_000,
) {
    private var delayMs = minimumDelayMs
    private var nextAttemptAt = 0L

    fun canAttempt(nowElapsedMs: Long): Boolean = nowElapsedMs >= nextAttemptAt

    fun failed(nowElapsedMs: Long) {
        nextAttemptAt = nowElapsedMs + delayMs
        delayMs = (delayMs * 2).coerceAtMost(maximumDelayMs)
    }

    fun succeeded() {
        delayMs = minimumDelayMs
        nextAttemptAt = 0L
    }

    fun nextAttemptAtElapsedMs(): Long = nextAttemptAt
}

class PlayerActivityQueue private constructor(
    context: Context,
    private val api: TilecastApi = TilecastApi(),
) {
    private val app = context.applicationContext
    private val store = ActivityQueueStore(File(app.filesDir, "activity/player-activity.json"))
    private val flushMutex = Mutex()
    private val retryBackoff = ActivityRetryBackoff()
    private val persistenceDispatcher = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tilecast-activity-queue").apply { isDaemon = true }
    }.asCoroutineDispatcher()
    private val persistenceScope = CoroutineScope(SupervisorJob() + persistenceDispatcher)

    init {
        persistenceScope.launch {
            while (true) {
                delay(5_000)
                runCatching { flushConfigured() }
            }
        }
    }

    fun record(
        eventType: String,
        category: String = "",
        severity: String = "info",
        manifestVersion: Long? = null,
        presentationType: String = "",
        presentationId: String = "",
        presentationRevision: String = "",
        contentType: String = "",
        contentId: String = "",
        playlistItemId: String = "",
        layoutPlacementId: String = "",
        activitySessionId: String = "",
        parentActivitySessionId: String = "",
        sessionType: String = "",
        terminalReason: String = "",
        result: String = "unknown",
        durationMs: Long? = null,
        expectedDurationMs: Long? = null,
        failureCode: String = "",
        failureMessage: String = "",
        trigger: String = "",
        scheduleId: String = "",
        takeoverId: String = "",
        sourceId: String = "",
        selectedRecordId: String = "",
        selectionDate: String = "",
        sourceCachedAt: String? = null,
        sourceRevision: String = "",
        snapshotHash: String = "",
        metadata: JsonObject = buildJsonObject {},
        priority: Int = 5,
    ) {
        val event = PlayerActivityEvent(
            id = UUID.randomUUID().toString(),
            sequence = 0,
            eventType = eventType,
            category = category,
            severity = severity,
            occurredAt = Instant.now().toString(),
            elapsedRealtimeMs = SystemClock.elapsedRealtime(),
            playerTimezone = ZoneId.systemDefault().id,
            manifestVersion = manifestVersion,
            presentationType = presentationType,
            presentationId = presentationId,
            presentationRevision = presentationRevision,
            contentType = contentType,
            contentId = contentId,
            playlistItemId = playlistItemId,
            layoutPlacementId = layoutPlacementId,
            activitySessionId = activitySessionId,
            parentActivitySessionId = parentActivitySessionId,
            sessionType = sessionType,
            terminalReason = terminalReason,
            result = result,
            durationMs = durationMs?.coerceAtLeast(0),
            expectedDurationMs = expectedDurationMs?.coerceAtLeast(0),
            failureCode = failureCode.take(96),
            failureMessage = failureMessage.take(240),
            trigger = trigger.take(96),
            scheduleId = scheduleId,
            takeoverId = takeoverId,
            sourceId = sourceId,
            selectedRecordId = selectedRecordId,
            selectionDate = selectionDate,
            sourceCachedAt = sourceCachedAt,
            sourceRevision = sourceRevision,
            snapshotHash = snapshotHash,
            metadata = metadata,
            priority = priority.coerceIn(0, 9),
        )
        persistenceScope.launch { runCatching { store.append(event) } }
    }

    suspend fun flushConfigured() = withContext(Dispatchers.IO) {
        flushMutex.withLock {
            val now = SystemClock.elapsedRealtime()
            if (!retryBackoff.canAttempt(now)) return@withLock
            val configuration = ConfigurationRepository(PlayerDatabase.get(app).configuration()).getOrCreate()
            val serverUrl = configuration.serverUrl ?: return@withLock
            val credential = KeystoreCredentialStore(app).read() ?: return@withLock
            while (true) {
                val batch = store.peek(100)
                if (batch.isEmpty()) {
                    retryBackoff.succeeded()
                    return@withLock
                }
                val response = runCatching {
                    api.activityEvents(serverUrl, credential, PlayerActivityBatch(batch))
                }.getOrElse {
                    retryBackoff.failed(SystemClock.elapsedRealtime())
                    return@withLock
                }
                val acknowledged = response.acknowledgedEventIds.toSet()
                if (acknowledged.isEmpty()) {
                    retryBackoff.failed(SystemClock.elapsedRealtime())
                    return@withLock
                }
                store.acknowledge(acknowledged, response.highestSequence)
                retryBackoff.succeeded()
                if (batch.size < 100) return@withLock
            }
        }
    }

    fun pendingCount(): Int = store.size()

    companion object {
        @Volatile private var instance: PlayerActivityQueue? = null
        fun get(context: Context): PlayerActivityQueue = instance ?: synchronized(this) {
            instance ?: PlayerActivityQueue(context).also { instance = it }
        }
    }
}

class PlaybackActivityReporter(
    private val queue: PlayerActivityQueue,
    private val manifestVersion: Long,
    private val presentationType: String,
    private val presentationId: String,
    private val presentationRevision: String,
    private val trigger: String,
    private val scheduleId: String,
    private val takeoverId: String,
) {
    private val rootSession = UUID.randomUUID().toString()
    private val rootStartedElapsed = SystemClock.elapsedRealtime()

    fun presentationStarted() {
        queue.record(
            eventType = "presentation.started",
            category = "manifest",
            manifestVersion = manifestVersion,
            presentationType = presentationType,
            presentationId = presentationId,
            presentationRevision = presentationRevision,
            activitySessionId = rootSession,
            sessionType = "presentation",
            result = "playing",
            trigger = trigger,
            scheduleId = scheduleId,
            takeoverId = takeoverId,
            metadata = buildJsonObject { put("presentationName", JsonPrimitive(presentationId)) },
            priority = 8,
        )
    }

    /**
     * Ends the root session. The reason defaults to `unknown` because the
     * teardown itself is not evidence of why playback stopped; callers that
     * know — a schedule change, a takeover — pass the real reason.
     */
    fun presentationStopped(
        result: String = "partial",
        terminalReason: String = "unknown",
    ) {
        queue.record(
            eventType = "presentation.stopped",
            category = "manifest",
            manifestVersion = manifestVersion,
            presentationType = presentationType,
            presentationId = presentationId,
            presentationRevision = presentationRevision,
            activitySessionId = rootSession,
            sessionType = "presentation",
            terminalReason = terminalReason,
            result = result,
            durationMs = SystemClock.elapsedRealtime() - rootStartedElapsed,
            trigger = trigger,
            scheduleId = scheduleId,
            takeoverId = takeoverId,
            priority = 8,
        )
    }

    fun childStarted(
        contentType: String,
        contentId: String,
        playlistItemId: String = "",
        layoutPlacementId: String = "",
        expectedDurationMs: Long? = null,
        sourceId: String = "",
        selectedRecordId: String = "",
        sourceCachedAt: String? = null,
        sourceRevision: String = "",
        snapshotHash: String = "",
    ): ChildSession {
        val id = UUID.randomUUID().toString()
        val started = SystemClock.elapsedRealtime()
        queue.record(
            eventType = "content.started",
            category = "playback",
            manifestVersion = manifestVersion,
            presentationType = presentationType,
            presentationId = presentationId,
            presentationRevision = presentationRevision,
            contentType = contentType,
            contentId = contentId,
            playlistItemId = playlistItemId,
            layoutPlacementId = layoutPlacementId,
            activitySessionId = id,
            parentActivitySessionId = rootSession,
            sessionType = childSessionType(playlistItemId, layoutPlacementId),
            result = "playing",
            expectedDurationMs = expectedDurationMs,
            trigger = trigger,
            scheduleId = scheduleId,
            takeoverId = takeoverId,
            sourceId = sourceId,
            selectedRecordId = selectedRecordId,
            selectionDate = if (selectedRecordId.isNotEmpty()) LocalDate.now().toString() else "",
            sourceCachedAt = sourceCachedAt,
            sourceRevision = sourceRevision,
            snapshotHash = snapshotHash,
            priority = 6,
        )
        return ChildSession(id, started, contentType, contentId, playlistItemId, layoutPlacementId)
    }

    inner class ChildSession(
        private val id: String,
        private val startedElapsed: Long,
        private val contentType: String,
        private val contentId: String,
        private val playlistItemId: String,
        private val layoutPlacementId: String,
    ) {
        fun finish(
            result: String = "completed",
            failureCode: String = "",
            failureMessage: String = "",
            terminalReason: String = defaultTerminalReason(result),
        ) {
            queue.record(
                eventType = when (result) {
                    "failed" -> "content.failed"
                    "skipped" -> "content.skipped"
                    else -> "content.completed"
                },
                category = "playback",
                severity = if (result == "failed") "error" else "info",
                manifestVersion = manifestVersion,
                presentationType = presentationType,
                presentationId = presentationId,
                presentationRevision = presentationRevision,
                contentType = contentType,
                contentId = contentId,
                playlistItemId = playlistItemId,
                layoutPlacementId = layoutPlacementId,
                activitySessionId = id,
                sessionType = childSessionType(playlistItemId, layoutPlacementId),
                terminalReason = terminalReason,
                result = result,
                durationMs = SystemClock.elapsedRealtime() - startedElapsed,
                failureCode = failureCode,
                failureMessage = failureMessage,
                trigger = trigger,
                scheduleId = scheduleId,
                takeoverId = takeoverId,
                priority = if (result == "failed") 9 else 6,
            )
        }
    }
}

// Activity Event Contract v2 helpers. See docs/activity-event-contract.md.

/**
 * A child session's type comes from the identifiers it carries: a layout zone
 * and a playlist position are measured differently, and only root presentation
 * intervals count toward a screen's wall-clock playback time.
 */
internal fun childSessionType(playlistItemId: String, layoutPlacementId: String): String = when {
    layoutPlacementId.isNotEmpty() -> "layout_placement"
    playlistItemId.isNotEmpty() -> "playlist_item"
    else -> "content"
}

/**
 * The terminal reason implied by an outcome when the caller does not name one.
 * A completion reached its own end, and a failure on this player is reported by
 * the renderer. Anything else stays `unknown`: a guessed reason would move the
 * session in or out of the interruption count on no evidence at all.
 */
internal fun defaultTerminalReason(result: String): String = when (result) {
    "completed" -> "completed_duration"
    "failed" -> "renderer_failure"
    else -> "unknown"
}
