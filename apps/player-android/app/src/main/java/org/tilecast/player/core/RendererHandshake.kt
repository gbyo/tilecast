package org.tilecast.player.core

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Process-wide renderer connection identities.
 *
 * Core keys the live renderer link by generation, so a generation must never
 * be reused inside one process: a late `disconnected` from an old renderer
 * would otherwise tear down a newer renderer that numbered itself the same.
 * Identity lives here, not in the Activity, so Activity recreation cannot
 * restart the sequence.
 */
object RendererGenerations {
    private val last = AtomicLong(0L)

    fun allocate(): Long = last.incrementAndGet()
}

/** Where the trusted runtime stands on its way to owning the screen. */
enum class RendererPhase {
    /** No WebView exists. */
    STOPPED,

    /** A WebView exists but Core has not accepted its connection yet. */
    CONNECTING,

    /** Core accepted the connection; the runtime page has not reported ready. */
    LOADING,

    /** The runtime reported ready and Core accepted it: Core drives the screen. */
    READY,

    /** Registration cannot complete without intervention. [RendererLifecycle.reason] says why. */
    FAILED,

    /** The installed WebView cannot host the secure runtime bridge. */
    UNSUPPORTED,
}

/**
 * Host-side renderer state, derived from the handshake and never from pixels.
 * The UI keeps an explicit status surface over the WebView until [READY], and
 * shows recovery when the renderer cannot get there.
 */
data class RendererLifecycle(
    val phase: RendererPhase,
    val generation: Long = 0L,
    /** A stable machine code, never prose and never page data. */
    val reason: String? = null,
) {
    val runtimeOwnsScreen: Boolean get() = phase == RendererPhase.READY
}

/**
 * Structured renderer lifecycle events. Fields are limited to generations,
 * attempt counts, and stable reason codes: credentials, URLs, headers, and
 * page data never enter an event.
 */
fun interface RendererLog {
    fun event(name: String, fields: Map<String, Any?>)

    companion object {
        val None = RendererLog { _, _ -> }

        fun render(name: String, fields: Map<String, Any?>): String =
            buildString {
                append("event=").append(name)
                for ((key, value) in fields) {
                    if (value != null) append(' ').append(key).append('=').append(value)
                }
            }
    }
}

/**
 * The renderer-to-Core registration handshake.
 *
 * A renderer is not connected because it called `rendererReport`: Core
 * answers every report, and a `connected` that Core answered with
 * [CoreReportCode.BAD_HANDLE] (the host was not open yet) was dropped. This
 * class keeps each generation's `connected` pending until Core applies it:
 *
 * 1. wait for Core readiness (event driven, not a delay);
 * 2. send `connected(N)`;
 * 3. [CoreReportCode.APPLIED] registers the generation;
 *    [CoreReportCode.BAD_HANDLE] retries a bounded number of times;
 *    any other answer is a permanent protocol error and stops the loop.
 *
 * A runtime `ready` that arrives before registration is retained and sent
 * once the generation registers, and a `ready` Core ignores (no live link
 * for that generation) re-registers once before failing. Every wait stops
 * when the generation is no longer current.
 */
class RendererHandshake(
    private val scope: CoroutineScope,
    private val report: suspend (String) -> Int,
    /** Suspends until Core can answer renderer reports. */
    private val awaitCoreReady: suspend () -> Unit,
    /** Builds the `ready` report for a generation from the live support. */
    private val readyReport: (generation: Long) -> String,
    private val log: RendererLog = RendererLog.None,
    private val retryDelaysMs: List<Long> = DEFAULT_RETRY_DELAYS_MS,
) {
    private val lock = Any()
    private val readyLane = Mutex()
    private val mutableLifecycle = MutableStateFlow(RendererLifecycle(RendererPhase.STOPPED))
    val lifecycle: StateFlow<RendererLifecycle> = mutableLifecycle.asStateFlow()

    private var current = 0L
    private var registered = false
    private var readyPending = false
    private var readyAccepted = false
    private var reRegistrations = 0
    private var registration: Job? = null

    /** The generation currently owning the handshake, or 0. */
    fun currentGeneration(): Long = synchronized(lock) { current }

    fun isCurrent(generation: Long): Boolean = synchronized(lock) { generation != 0L && generation == current }

    /** A WebView for [generation] exists: make its `connected` durable. */
    fun begin(generation: Long) {
        require(generation > 0L) { "renderer generation must be positive" }
        val previous = synchronized(lock) {
            val old = registration
            current = generation
            registered = false
            readyPending = false
            readyAccepted = false
            reRegistrations = 0
            mutableLifecycle.value = RendererLifecycle(RendererPhase.CONNECTING, generation)
            old
        }
        previous?.cancel()
        log.event("renderer_generation_allocated", mapOf("generation" to generation))
        val job = scope.launch { register(generation) }
        synchronized(lock) { if (current == generation) registration = job else job.cancel() }
    }

    /** The runtime page of [generation] reported ready (again). */
    fun runtimeReady(generation: Long) {
        val send = synchronized(lock) {
            if (generation != current) {
                log.event("ready_stale_ignored", mapOf("generation" to generation, "current" to current))
                return
            }
            readyPending = true
            registered
        }
        log.event("runtime_ready_received", mapOf("generation" to generation, "registered" to send))
        if (send) scope.launch { sendReady(generation) }
    }

    /**
     * The runtime's support changed after `ready` (the component probe
     * passed). Resend only when the page already reported ready; otherwise
     * the pending `ready` is built from the new support when it is sent.
     */
    fun supportChanged(generation: Long) {
        val resend = synchronized(lock) { generation == current && (readyPending || readyAccepted) }
        if (resend) runtimeReady(generation)
    }

    /**
     * The renderer of [generation] is gone. Sends `disconnected` when Core
     * knew the generation. A generation that is no longer current is stale:
     * Core ignores its disconnect by key, and this class never lets it
     * disturb the newer generation's state.
     */
    suspend fun end(generation: Long) {
        val wasRegistered = synchronized(lock) {
            if (generation != current) {
                log.event("disconnect_stale_ignored", mapOf("generation" to generation, "current" to current))
                return
            }
            val known = registered
            current = 0L
            registered = false
            readyPending = false
            readyAccepted = false
            registration?.cancel()
            registration = null
            mutableLifecycle.value = RendererLifecycle(RendererPhase.STOPPED, 0L)
            known
        }
        if (!wasRegistered) return
        log.event("disconnected_sent", mapOf("generation" to generation))
        val code = call(disconnectedReport(generation))
        log.event("disconnected_result", mapOf("generation" to generation, "code" to code))
    }

    /** The installed WebView cannot host the secure bridge. */
    fun unsupported() {
        synchronized(lock) {
            registration?.cancel()
            registration = null
            current = 0L
            registered = false
            mutableLifecycle.value = RendererLifecycle(RendererPhase.UNSUPPORTED, 0L, "bridge_unavailable")
        }
        log.event("runtime_unsupported", emptyMap())
        scope.launch { deliver("""{"type":"unsupported"}""") }
    }

    /**
     * The runtime of [generation] cannot load or cannot run. Surfaces the
     * failure locally and tells Core so player health can name it.
     */
    fun fail(generation: Long, reason: String) {
        val own = synchronized(lock) {
            if (generation != current) return
            mutableLifecycle.value = RendererLifecycle(RendererPhase.FAILED, generation, reason)
            true
        }
        if (!own) return
        log.event("renderer_failed", mapOf("generation" to generation, "reason" to reason))
        scope.launch {
            deliver(
                buildJsonObject {
                    put("type", "fault")
                    put("generation", generation)
                    put("code", reason)
                }.toString(),
            )
        }
    }

    private suspend fun register(generation: Long) {
        var attempt = 0
        while (true) {
            if (!isCurrent(generation)) {
                log.event("connect_abandoned", mapOf("generation" to generation))
                return
            }
            setReason(generation, "awaiting_core")
            awaitCoreReady()
            if (!isCurrent(generation)) {
                log.event("connect_abandoned", mapOf("generation" to generation))
                return
            }
            attempt++
            log.event("connected_sent", mapOf("generation" to generation, "attempt" to attempt))
            val code = call(connectedReport(generation))
            log.event("connected_result", mapOf("generation" to generation, "attempt" to attempt, "code" to code))
            when (code) {
                CoreReportCode.APPLIED -> {
                    onRegistered(generation)
                    return
                }
                CoreReportCode.BAD_HANDLE -> {
                    val wait = retryDelaysMs.getOrNull(attempt - 1)
                    if (wait == null) {
                        fail(generation, "registration_core_unavailable")
                        return
                    }
                    log.event(
                        "connected_retry_scheduled",
                        mapOf("generation" to generation, "attempt" to attempt, "delayMs" to wait),
                    )
                    delay(wait)
                }
                else -> {
                    fail(generation, "registration_rejected_$code")
                    return
                }
            }
        }
    }

    private suspend fun onRegistered(generation: Long) {
        val sendReadyNow = synchronized(lock) {
            if (generation != current) return
            registered = true
            mutableLifecycle.value = RendererLifecycle(RendererPhase.LOADING, generation)
            readyPending
        }
        log.event("connected_accepted", mapOf("generation" to generation))
        if (sendReadyNow) sendReady(generation)
    }

    private suspend fun sendReady(generation: Long) {
        readyLane.withLock {
            val proceed = synchronized(lock) {
                if (generation != current || !registered || !readyPending) {
                    false
                } else {
                    readyPending = false
                    true
                }
            }
            if (!proceed) return
            log.event("ready_sent", mapOf("generation" to generation))
            val code = call(readyReport(generation))
            log.event("ready_result", mapOf("generation" to generation, "code" to code))
            when (code) {
                CoreReportCode.APPLIED -> {
                    synchronized(lock) {
                        if (generation == current) {
                            readyAccepted = true
                            reRegistrations = 0
                            mutableLifecycle.value = RendererLifecycle(RendererPhase.READY, generation)
                        }
                    }
                }
                CoreReportCode.IGNORED, CoreReportCode.BAD_HANDLE -> reRegister(generation, "ready_$code")
                else -> fail(generation, "ready_rejected_$code")
            }
        }
    }

    /**
     * Core did not recognize the generation when `ready` arrived: its link was
     * lost or never applied. Register again and keep the `ready`; bounded so a
     * Core that keeps refusing becomes a visible failure, not a loop.
     */
    private fun reRegister(generation: Long, why: String) {
        val again = synchronized(lock) {
            if (generation != current) return
            if (reRegistrations >= MAX_RE_REGISTRATIONS) {
                false
            } else {
                reRegistrations++
                registered = false
                readyPending = true
                readyAccepted = false
                mutableLifecycle.value = RendererLifecycle(RendererPhase.CONNECTING, generation, why)
                true
            }
        }
        if (!again) {
            fail(generation, "ready_not_applied")
            return
        }
        log.event("reregister_scheduled", mapOf("generation" to generation, "reason" to why))
        val job = scope.launch { register(generation) }
        synchronized(lock) { if (current == generation) registration = job else job.cancel() }
    }

    private fun setReason(generation: Long, reason: String) {
        synchronized(lock) {
            val state = mutableLifecycle.value
            if (generation == current && state.phase == RendererPhase.CONNECTING && state.reason != reason) {
                mutableLifecycle.value = state.copy(reason = reason)
            }
        }
    }

    /**
     * Sends a report that is not tied to a live link (the unsupported verdict,
     * a fault) once Core can answer, retrying a refusal within the same bounds
     * as registration. Core ignores nothing here: the report is the only way
     * the server learns why this renderer cannot run.
     */
    private suspend fun deliver(json: String) {
        for (wait in listOf(0L) + retryDelaysMs) {
            if (wait > 0L) delay(wait)
            awaitCoreReady()
            if (call(json) != CoreReportCode.BAD_HANDLE) return
        }
    }

    private suspend fun call(json: String): Int =
        try {
            report(json)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            CoreReportCode.MALFORMED
        }

    companion object {
        /** Retries after a `BAD_HANDLE` answered while Core claimed to be ready: ~9 s in total. */
        val DEFAULT_RETRY_DELAYS_MS: List<Long> = listOf(50L, 100L, 250L, 500L, 1_000L, 2_000L, 5_000L)
        const val MAX_RE_REGISTRATIONS = 3

        fun connectedReport(generation: Long): String =
            buildJsonObject {
                put("type", "connected")
                put("generation", generation)
            }.toString()

        fun disconnectedReport(generation: Long): String =
            buildJsonObject {
                put("type", "disconnected")
                put("generation", generation)
            }.toString()
    }
}
