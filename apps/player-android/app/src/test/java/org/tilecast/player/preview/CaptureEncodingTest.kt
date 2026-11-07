package org.tilecast.player.preview

import org.junit.Assert.assertEquals
import org.junit.Test

class CaptureEncodingTest {
    @Test
    fun portraitCaptureFitsWithoutCroppingOrDistortion() {
        assertEquals(PreviewDimensions(360, 640), scaledDimensions(1080, 1920, 640, 640))
        assertEquals(PreviewDimensions(540, 960), scaledDimensions(1080, 1920, 960, 960))
    }

    @Test
    fun landscapeAndSquareCaptureKeepTheirAspectRatio() {
        assertEquals(PreviewDimensions(640, 360), scaledDimensions(1920, 1080, 640, 640))
        assertEquals(PreviewDimensions(640, 640), scaledDimensions(1080, 1080, 640, 640))
    }
}
