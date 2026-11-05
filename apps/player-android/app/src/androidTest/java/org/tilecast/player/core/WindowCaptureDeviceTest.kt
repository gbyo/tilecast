package org.tilecast.player.core

import android.graphics.Color
import android.view.View
import androidx.test.core.app.ActivityScenario
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.preview.PlayerWindowCapture
import org.tilecast.player.preview.WindowCapture

class WindowCaptureDeviceTest {
    @Test
    fun eligibleWindowProducesPixelsAndProtectedWindowDoesNot() = runBlocking {
        ActivityScenario.launch(RendererHarnessActivity::class.java).use { scenario ->
            lateinit var source: PlayerWindowCapture
            scenario.onActivity { activity ->
                val content = View(activity)
                content.setBackgroundColor(Color.RED)
                activity.setContentView(content)
                source = PlayerWindowCapture(activity)
            }
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
    }
}
