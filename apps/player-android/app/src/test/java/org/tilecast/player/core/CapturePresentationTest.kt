package org.tilecast.player.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class CapturePresentationTest {
    private val image = WebViewCoreRenderer.CapturedImage(byteArrayOf(1), 1, 1)

    private class Presentation(
        private val frame: suspend () -> WebViewCoreRenderer.CapturedImage?,
    ) : RendererPresentation {
        var blockReason: String? = null
        override fun captureBlockReason(): String? = blockReason
        override suspend fun capture(maxWidth: Int, maxHeight: Int, maxBytes: Int) = frame()
    }

    @Test
    fun attachedCapturePolicyDistinguishesAllowedProtectedAndDetached() {
        val presentation = Presentation { image }
        assertNull(presentationCaptureBlockReason(presentation))
        presentation.blockReason = "sensitive_admin"
        assertEquals("sensitive_admin", presentationCaptureBlockReason(presentation))
        assertEquals("display_host_detached", presentationCaptureBlockReason(null))
    }

    @Test
    fun attachedUnprotectedPresentationReturnsImage() = runBlocking {
        val presentation = Presentation { image }
        assertSame(image, captureFromCurrentPresentation({ presentation }, 10, 10, 10))
    }

    @Test
    fun protectedPresentationDoesNotStartCapture() = runBlocking {
        val presentation = Presentation { error("Protected window must not be captured") }
        presentation.blockReason = "sensitive_admin"
        assertNull(captureFromCurrentPresentation({ presentation }, 10, 10, 10))
    }

    @Test
    fun windowProtectedDuringCaptureDiscardsImage() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val presentation = Presentation {
            started.complete(Unit)
            release.await()
            image
        }
        val captured = async { captureFromCurrentPresentation({ presentation }, 10, 10, 10) }
        started.await()
        presentation.blockReason = "sensitive_admin"
        release.complete(Unit)
        assertNull(captured.await())
    }

    @Test
    fun replacementWindowInvalidatesInFlightCapture() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var presentation = Presentation {
            started.complete(Unit)
            release.await()
            image
        }
        val captured = async { captureFromCurrentPresentation({ presentation }, 10, 10, 10) }
        started.await()
        presentation = Presentation { image }
        release.complete(Unit)
        assertNull(captured.await())
    }
}
