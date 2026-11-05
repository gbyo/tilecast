package org.tilecast.player.core

import android.graphics.Color
import android.view.View
import androidx.test.core.app.ActivityScenario
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.preview.PlayerWindowCapture
import org.tilecast.player.preview.WindowCapture

class WindowCaptureDeviceTest {
    @Test
    fun eligibleWindowProducesPixelsAndProtectedWindowDoesNot() {
        ActivityScenario.launch(RendererHarnessActivity::class.java).use { scenario ->
            lateinit var source: PlayerWindowCapture
            scenario.onActivity { activity ->
                val content = View(activity)
                content.setBackgroundColor(Color.RED)
                activity.setContentView(content)
                source = PlayerWindowCapture(activity)
            }
            val check: suspend () -> Unit = {
                val frame = source.capture(160, 90) { true }
                assertTrue("capture result: $frame", frame is WindowCapture.Success)
                val bitmap = (frame as WindowCapture.Success).bitmap
                try {
                    assertEquals(Color.RED, bitmap.getPixel(bitmap.width / 2, bitmap.height / 2))
                } finally {
                    bitmap.recycle()
                }

                var firstCheck = true
                val blocked = source.capture(160, 90) {
                    firstCheck.also { firstCheck = false }
                }
                assertTrue("capture result: $blocked", blocked is WindowCapture.Failure)
            }
            val completed = ArrayBlockingQueue<Result<Unit>>(1)
            check.startCoroutine(object : Continuation<Unit> {
                override val context = EmptyCoroutineContext
                override fun resumeWith(result: Result<Unit>) {
                    completed.add(result)
                }
            })
            checkNotNull(completed.poll(10, TimeUnit.SECONDS)) { "Window capture timed out" }.getOrThrow()
        }
    }
}
