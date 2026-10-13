package org.tilecast.player.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The renderer-to-Core registration handshake, against a scripted Core.
 *
 * [FakeCore] answers like the native host: reports before it is ready get
 * BAD_HANDLE, `connected` registers a generation, `disconnected` removes a
 * generation only when it is the live one, and `ready` applies only for a
 * registered live generation (otherwise IGNORED), exactly as Rust does.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RendererHandshakeTest {
    private class FakeCore(var ready: Boolean = false) {
        val coreOpened = CompletableDeferred<Unit>().also { if (ready) it.complete(Unit) }
        val reports = mutableListOf<String>()
        var live: Long = 0L
        var readyApplied: Long = 0L
        var connectedAnswers = ArrayDeque<Int>()

        fun open() {
            ready = true
            coreOpened.complete(Unit)
        }

        fun type(json: String) = Json.parseToJsonElement(json).jsonObject["type"]!!.jsonPrimitive.content
        fun generation(json: String) = Json.parseToJsonElement(json).jsonObject["generation"]?.jsonPrimitive?.content?.toLong() ?: 0L

        fun report(json: String): Int {
            reports += json
            if (!ready) return CoreReportCode.BAD_HANDLE
            return when (type(json)) {
                "connected" -> {
                    connectedAnswers.removeFirstOrNull()?.let { return it }
                    live = generation(json)
                    CoreReportCode.APPLIED
                }
                "disconnected" -> {
                    if (generation(json) == live) live = 0L
                    CoreReportCode.APPLIED
                }
                "ready" -> if (generation(json) == live && live != 0L) {
                    readyApplied = live
                    CoreReportCode.APPLIED
                } else {
                    CoreReportCode.IGNORED
                }
                "fault", "unsupported" -> CoreReportCode.APPLIED
                else -> CoreReportCode.MALFORMED
            }
        }

        fun count(type: String) = reports.count { type(it) == type }
    }

    private class RecordingLog : RendererLog {
        val events = mutableListOf<String>()
        override fun event(name: String, fields: Map<String, Any?>) {
            events += name
        }
    }

    private fun TestScope.handshake(core: FakeCore, log: RendererLog = RendererLog.None) =
        RendererHandshake(
            scope = this,
            report = { core.report(it) },
            awaitCoreReady = { core.coreOpened.await() },
            readyReport = { generation -> """{"type":"ready","generation":$generation,"report":{}}""" },
            log = log,
        )

    @Test fun coldStartRaceRegistersAfterCoreOpensAndNeverStaysDisconnected() = runTest {
        // Core is not ready when the renderer exists: the old code sent
        // connected once, took BAD_HANDLE, and stayed disconnected forever.
        val core = FakeCore(ready = false)
        val handshake = handshake(core)
        handshake.begin(1)
        // The runtime loads and reports ready before Core is even open.
        handshake.runtimeReady(1)
        runCurrent()
        assertEquals(0, core.reports.size)
        assertEquals(RendererPhase.CONNECTING, handshake.lifecycle.value.phase)
        assertEquals("awaiting_core", handshake.lifecycle.value.reason)

        core.open()
        advanceUntilIdle()

        assertEquals(1L, core.live)
        assertEquals(1L, core.readyApplied)
        assertEquals(RendererPhase.READY, handshake.lifecycle.value.phase)
        assertTrue(handshake.lifecycle.value.runtimeOwnsScreen)
        // connected precedes the retained ready.
        assertEquals(listOf("connected", "ready"), core.reports.map(core::type))
    }

    @Test fun badHandleAfterReadinessRetriesThenRegisters() = runTest {
        val core = FakeCore(ready = true)
        core.connectedAnswers.addAll(listOf(CoreReportCode.BAD_HANDLE, CoreReportCode.BAD_HANDLE))
        val log = RecordingLog()
        val handshake = handshake(core, log)
        handshake.begin(4)
        advanceUntilIdle()

        assertEquals(3, core.count("connected"))
        assertEquals(4L, core.live)
        assertEquals(RendererPhase.LOADING, handshake.lifecycle.value.phase)
        assertEquals(2, log.events.count { it == "connected_retry_scheduled" })
        assertTrue("connected_accepted" in log.events)
    }

    @Test fun retriesAreBoundedAndPermanentErrorsDoNotRetry() = runTest {
        val busy = FakeCore(ready = true)
        repeat(20) { busy.connectedAnswers.add(CoreReportCode.BAD_HANDLE) }
        val first = handshake(busy)
        first.begin(1)
        advanceUntilIdle()
        assertEquals(RendererHandshake.DEFAULT_RETRY_DELAYS_MS.size + 1, busy.count("connected"))
        assertEquals(RendererPhase.FAILED, first.lifecycle.value.phase)
        assertEquals("registration_core_unavailable", first.lifecycle.value.reason)
        // The failure reaches Core so player health can name it.
        assertEquals(1, busy.count("fault"))

        val malformed = FakeCore(ready = true)
        malformed.connectedAnswers.add(CoreReportCode.MALFORMED)
        val second = handshake(malformed)
        second.begin(1)
        advanceUntilIdle()
        assertEquals(1, malformed.count("connected"))
        assertEquals("registration_rejected_${CoreReportCode.MALFORMED}", second.lifecycle.value.reason)
    }

    @Test fun retryStopsWhenTheGenerationIsReplaced() = runTest {
        val core = FakeCore(ready = true)
        repeat(3) { core.connectedAnswers.add(CoreReportCode.BAD_HANDLE) }
        val handshake = handshake(core)
        handshake.begin(1)
        runCurrent()
        assertEquals(1, core.count("connected"))
        // A newer renderer supersedes generation 1 while its retry waits.
        handshake.begin(2)
        advanceUntilIdle()
        assertEquals(2L, core.live)
        assertFalse(core.reports.filter { core.type(it) == "connected" }.drop(1).any { core.generation(it) == 1L })
    }

    @Test fun lateDisconnectFromTheOldRendererCannotDisconnectTheNewOne() = runTest {
        val core = FakeCore(ready = true)
        val log = RecordingLog()
        val handshake = handshake(core, log)
        handshake.begin(1)
        handshake.runtimeReady(1)
        advanceUntilIdle()
        assertEquals(1L, core.live)

        // The replacement connects and is ready; the old renderer closes late.
        handshake.begin(2)
        handshake.runtimeReady(2)
        advanceUntilIdle()
        assertEquals(RendererPhase.READY, handshake.lifecycle.value.phase)
        handshake.end(1)
        advanceUntilIdle()

        assertEquals(2L, core.live)
        assertEquals(2L, core.readyApplied)
        assertEquals(RendererPhase.READY, handshake.lifecycle.value.phase)
        assertEquals(2L, handshake.lifecycle.value.generation)
        assertEquals(0, core.count("disconnected"))
        assertTrue("disconnect_stale_ignored" in log.events)
    }

    @Test fun endingTheCurrentRendererDisconnectsItOnce() = runTest {
        val core = FakeCore(ready = true)
        val handshake = handshake(core)
        handshake.begin(7)
        handshake.runtimeReady(7)
        advanceUntilIdle()
        handshake.end(7)
        assertEquals(0L, core.live)
        assertEquals(1, core.count("disconnected"))
        assertEquals(RendererPhase.STOPPED, handshake.lifecycle.value.phase)
    }

    @Test fun readyIgnoredByCoreReRegistersOnceThenSucceeds() = runTest {
        val core = FakeCore(ready = true)
        val handshake = handshake(core)
        handshake.begin(3)
        advanceUntilIdle()
        // Core lost the link (for example a host restart) before ready arrived.
        core.live = 0L
        handshake.runtimeReady(3)
        advanceUntilIdle()

        assertEquals(2, core.count("connected"))
        assertEquals(3L, core.readyApplied)
        assertEquals(RendererPhase.READY, handshake.lifecycle.value.phase)
    }

    @Test fun readyIgnoredForeverBecomesAVisibleFailureNotALoop() = runTest {
        val core = FakeCore(ready = true)
        val handshake = handshake(core)
        handshake.begin(3)
        advanceUntilIdle()
        // Core applies connected but never accepts ready for this generation.
        core.connectedAnswers.addAll(List(10) { CoreReportCode.APPLIED })
        core.live = 99L
        handshake.runtimeReady(3)
        advanceUntilIdle()

        assertEquals(RendererPhase.FAILED, handshake.lifecycle.value.phase)
        assertEquals("ready_not_applied", handshake.lifecycle.value.reason)
        assertTrue(core.count("connected") <= 1 + RendererHandshake.MAX_RE_REGISTRATIONS)
    }

    @Test fun staleReadyIsDropped() = runTest {
        val core = FakeCore(ready = true)
        val handshake = handshake(core)
        handshake.begin(5)
        advanceUntilIdle()
        handshake.runtimeReady(4)
        advanceUntilIdle()
        assertEquals(0, core.count("ready"))
        assertEquals(RendererPhase.LOADING, handshake.lifecycle.value.phase)
    }

    @Test fun supportChangeResendsReadyOnlyAfterThePageReportedReady() = runTest {
        val core = FakeCore(ready = true)
        val handshake = handshake(core)
        handshake.begin(2)
        advanceUntilIdle()
        handshake.supportChanged(2)
        advanceUntilIdle()
        assertEquals(0, core.count("ready"))

        handshake.runtimeReady(2)
        advanceUntilIdle()
        handshake.supportChanged(2)
        advanceUntilIdle()
        assertEquals(2, core.count("ready"))
        assertEquals(RendererPhase.READY, handshake.lifecycle.value.phase)
    }

    @Test fun failureTellsCoreAndShowsLocally() = runTest {
        val core = FakeCore(ready = true)
        val handshake = handshake(core)
        handshake.begin(2)
        advanceUntilIdle()
        handshake.fail(2, "runtime_load_failed:net_-2")
        advanceUntilIdle()
        assertEquals(RendererPhase.FAILED, handshake.lifecycle.value.phase)
        val fault = core.reports.single { core.type(it) == "fault" }
        assertEquals("runtime_load_failed:net_-2", Json.parseToJsonElement(fault).jsonObject["code"]!!.jsonPrimitive.content)
        // A failure for a generation that is not current changes nothing.
        handshake.fail(1, "runtime_load_failed:stale")
        advanceUntilIdle()
        assertEquals(1, core.count("fault"))
    }

    @Test fun theUnsupportedVerdictWaitsForCoreInsteadOfBeingDropped() = runTest {
        // The verdict used to be sent once; BAD_HANDLE before Core opened lost it
        // and capability advertisement stayed on the fresh-process fallback.
        val core = FakeCore(ready = false)
        val handshake = handshake(core)
        handshake.unsupported()
        runCurrent()
        assertEquals(0, core.reports.size)
        assertEquals(RendererPhase.UNSUPPORTED, handshake.lifecycle.value.phase)
        core.open()
        advanceUntilIdle()
        assertEquals(listOf("unsupported"), core.reports.map(core::type))
    }

    @Test fun generationsAreNeverReusedAcrossRendererOwners() {
        val seen = mutableSetOf<Long>()
        repeat(50) { seen += RendererGenerations.allocate() }
        assertEquals(50, seen.size)
        assertEquals(seen.sorted(), seen.toList())
    }

    @Test fun twoCrashPoliciesInOneProcessNeverShareAGeneration() {
        val first = org.tilecast.player.runtime.RuntimeCrashPolicy(RendererGenerations::allocate)
        val second = org.tilecast.player.runtime.RuntimeCrashPolicy(RendererGenerations::allocate)
        assertTrue(first.currentGeneration() != second.currentGeneration())
        val replaced = first.onRecreated()
        assertTrue(replaced > second.currentGeneration())
        // A renderer-process death still gets a fresh generation.
        first.onRendererGone()
        assertTrue(first.onRecreated() > replaced)
    }
}
