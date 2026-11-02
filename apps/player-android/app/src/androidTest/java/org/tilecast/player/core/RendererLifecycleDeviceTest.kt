package org.tilecast.player.core

import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The renderer-to-Core registration on a real WebView and the real native
 * host: the cold-start race that left a live WebView permanently
 * "Renderer disconnected", and renderer replacement inside one process.
 */
class RendererLifecycleDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private suspend fun await(timeoutMs: Long = 60_000, what: String, check: suspend () -> Boolean) {
        try {
            withTimeout(timeoutMs) { while (!check()) delay(200) }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for $what")
        }
    }

    private fun rendererOf(host: PlayerCoreHost): CoreRendererStatus? =
        (host.state.value as? CoreHostState.Ready)?.status?.renderer

    @Test fun aRendererThatStartsBeforeCoreIsOpenRegistersWhenCoreIsReady() = runBlocking {
        CoreTestFixtures.resetCoreFiles(context)
        val host = PlayerCoreHost.get(context)
        host.stop()
        val log = CopyOnWriteArrayList<JSONObject>()
        val renderer = WebViewCoreRenderer(
            context,
            "test-host",
            "test-engine",
            report = { json ->
                log += JSONObject(json)
                host.rendererReport(json)
            },
            awaitCoreReady = { host.awaitReady() },
        )
        val scenario = ActivityScenario.launch(RendererHarnessActivity::class.java)
        try {
            host.attachRendererAdapter(renderer)
            // The WebView exists while the native host is not open at all:
            // the first connected report would have been answered BAD_HANDLE.
            assertTrue("renderer did not start", renderer.start())
            scenario.onActivity { activity ->
                renderer.view?.let { activity.findViewById<ViewGroup>(android.R.id.content).addView(it) }
            }
            delay(1_000)
            assertEquals(RendererPhase.CONNECTING, renderer.lifecycle.value.phase)
            assertEquals("awaiting_core", renderer.lifecycle.value.reason)
            assertTrue("no report is sent into a closed host", log.none { it.optString("type") == "connected" })

            host.startDrivers()
            await(what = "renderer ready") { renderer.lifecycle.value.phase == RendererPhase.READY }
            await(what = "Core to see a connected, ready renderer") {
                host.refreshStatus()
                rendererOf(host)?.let { it.connected && it.ready } == true
            }
            val generation = renderer.lifecycle.value.generation
            assertTrue(log.any { it.optString("type") == "connected" && it.optLong("generation") == generation })
        } finally {
            scenario.close()
            renderer.close()
            host.stop()
        }
    }

    @Test fun aSecondRendererGetsANewGenerationAndTheFirstOnesLateCloseIsHarmless() = runBlocking {
        CoreTestFixtures.resetCoreFiles(context)
        val host = PlayerCoreHost.get(context)
        host.stop()
        host.startDrivers()
        val scenario = ActivityScenario.launch(RendererHarnessActivity::class.java)
        fun newRenderer() = WebViewCoreRenderer(
            context,
            "test-host",
            "test-engine",
            report = { json -> host.rendererReport(json) },
            awaitCoreReady = { host.awaitReady() },
        )
        val first = newRenderer()
        val second = newRenderer()
        try {
            assertTrue(first.start())
            await(what = "first renderer ready") { first.lifecycle.value.phase == RendererPhase.READY }
            assertTrue(second.start())
            await(what = "second renderer ready") { second.lifecycle.value.phase == RendererPhase.READY }
            val firstGeneration = first.lifecycle.value.generation
            val secondGeneration = second.lifecycle.value.generation
            assertNotEquals("a generation is never reused in one process", firstGeneration, secondGeneration)
            assertTrue(secondGeneration > firstGeneration)

            // The old Activity's renderer closes late; its disconnect must not touch the new one.
            first.close()
            delay(1_000)
            host.refreshStatus()
            val status = rendererOf(host)
            assertTrue("the live renderer stays connected and ready: $status", status?.connected == true && status.ready)
        } finally {
            scenario.close()
            second.close()
            host.stop()
        }
    }
}
