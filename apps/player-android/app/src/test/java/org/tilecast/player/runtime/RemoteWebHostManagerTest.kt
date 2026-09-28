package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.runtime.RemoteWebHostManager.PageContent
import org.tilecast.player.runtime.RemoteWebHostManager.Surface
import org.tilecast.player.runtime.RemoteWebHostManager.Viewport
import org.tilecast.player.runtime.RemoteWebHostManager.ViewportPx
import org.tilecast.player.runtime.RemoteWebHostManager.YouTubeContent

class RemoteWebHostManagerTest {
    private fun page(url: String = "https://example.com/a") = PageContent(
        url = url, allowedHosts = listOf("example.com"), javascriptEnabled = true,
        domStorageEnabled = true, cookiePolicy = "first_party", userAgent = "",
        zoomPercent = 100, scrollX = 0, scrollY = 0, backgroundColor = "#000000",
    )

    private fun surface(id: String = "s1", gen: Long = 1) = Surface(
        surfaceId = id, page = page(), youTube = null,
        viewportPx = ViewportPx(0, 0, 100, 100), muted = false, visible = true,
        reloadCount = 0, generation = gen,
    )

    @Test fun mapsViewportsWithDensityAndClipsNothing() {
        assertEquals(
            ViewportPx(20, 40, 200, 100),
            RemoteWebHostManager.mapViewport(Viewport(10.0, 20.0, 100.0, 50.0, 2.0)),
        )
        // Negative origins stay negative: the runtime clips offscreen surfaces.
        assertEquals(
            ViewportPx(-20, -40, 200, 100),
            RemoteWebHostManager.mapViewport(Viewport(-10.0, -20.0, 100.0, 50.0, 2.0)),
        )
        assertNull(RemoteWebHostManager.mapViewport(Viewport(0.0, 0.0, 0.0, 50.0, 2.0)))
        assertNull(RemoteWebHostManager.mapViewport(Viewport(0.0, 0.0, 100.0, 50.0, 0.0)))
        assertNull(RemoteWebHostManager.mapViewport(Viewport(Double.NaN, 0.0, 100.0, 50.0, 2.0)))
    }

    @Test fun validatesSurfaceIds() {
        assertTrue(RemoteWebHostManager.validSurfaceId("abc-123"))
        assertFalse(RemoteWebHostManager.validSurfaceId("ABC"))
        assertFalse(RemoteWebHostManager.validSurfaceId("../evil"))
        assertFalse(RemoteWebHostManager.validSurfaceId(""))
    }

    @Test fun validatesPagePolicy() {
        assertTrue(RemoteWebHostManager.validPage(page()))
        assertFalse(RemoteWebHostManager.validPage(page("javascript:alert(1)")))
        assertFalse(RemoteWebHostManager.validPage(page("https://user:pass@example.com/")))
        assertFalse(RemoteWebHostManager.validPage(page("https://example.com:8443/")))
        assertFalse(
            RemoteWebHostManager.validPage(
                page("https://outside.example/").copy(allowedHosts = listOf("approved.example")),
            ),
        )
        assertFalse(RemoteWebHostManager.validPage(page().copy(allowedHosts = emptyList())))
        assertFalse(RemoteWebHostManager.validPage(page().copy(cookiePolicy = "none")))
        assertFalse(RemoteWebHostManager.validPage(page().copy(zoomPercent = 10)))
    }

    @Test fun youtubeNeedsExactlyOneId() {
        assertTrue(RemoteWebHostManager.validYouTube(YouTubeContent("v", null, 0, null, false, false, 100, false, "", false)))
        assertTrue(RemoteWebHostManager.validYouTube(YouTubeContent(null, "p", 0, null, false, false, 100, false, "", false)))
        assertFalse(RemoteWebHostManager.validYouTube(YouTubeContent("v", "p", 0, null, false, false, 100, false, "", false)))
        assertFalse(RemoteWebHostManager.validYouTube(YouTubeContent(null, null, 0, null, false, false, 100, false, "", false)))
        assertFalse(RemoteWebHostManager.validYouTube(YouTubeContent("v", null, -1, null, false, false, 100, false, "", false)))
        assertFalse(RemoteWebHostManager.validYouTube(YouTubeContent("v", null, 0, null, false, false, 101, false, "", false)))
    }

    @Test fun trackerEnforcesGenerationAndLifecycle() {
        val tracker = RemoteWebHostManager.Tracker(1)
        assertTrue(tracker.create(surface()))
        assertFalse(tracker.create(surface(gen = 2)))
        assertTrue(tracker.setVisible("s1", false, 1))
        assertFalse(tracker.setVisible("s1", true, 2))
        assertTrue(tracker.updateViewport("s1", ViewportPx(1, 1, 10, 10), 1))
        assertFalse(tracker.updateViewport("missing", ViewportPx(1, 1, 10, 10), 1))
        assertTrue(tracker.reload("s1", 1))
        assertEquals(1, tracker.snapshot().single().reloadCount)
        assertTrue(tracker.destroy("s1", 1))
        assertFalse(tracker.destroy("s1", 1))
        assertTrue(tracker.create(surface()))
        assertEquals(listOf("s1"), tracker.reset(2))
        assertTrue(tracker.snapshot().isEmpty())
        assertTrue(tracker.create(surface(gen = 2)))
    }
}
