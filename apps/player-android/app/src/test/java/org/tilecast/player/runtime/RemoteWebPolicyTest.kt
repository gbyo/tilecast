package org.tilecast.player.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.runtime.RemoteWebHostManager.PageContent

class RemoteWebPolicyTest {
    private fun page(
        url: String = "https://example.com/a",
        hosts: List<String> = listOf("example.com", "cdn.example.com"),
    ) = PageContent(
        url = url, allowedHosts = hosts, javascriptEnabled = true, domStorageEnabled = true,
        cookiePolicy = "first_party", userAgent = "", zoomPercent = 100, scrollX = 0, scrollY = 0,
        backgroundColor = "#000000",
    )

    @Test fun allowsOnlyListedHostsOnDefaultPorts() {
        val p = page()
        assertTrue(RemoteWebNavigationPolicy.allows("https://example.com/other?x=1", p))
        assertTrue(RemoteWebNavigationPolicy.allows("https://CDN.Example.com./a", p))
        assertTrue(RemoteWebNavigationPolicy.allows("https://example.com:443/a", p))
        assertFalse(RemoteWebNavigationPolicy.allows("https://example.com:8443/a", p))
        assertFalse(RemoteWebNavigationPolicy.allows("https://evil.example.org/a", p))
        assertFalse(RemoteWebNavigationPolicy.allows("https://sub.example.com/a", p))
        assertFalse(RemoteWebNavigationPolicy.allows("https://example.com.evil.test/a", p))
    }

    @Test fun refusesCredentialsOpaqueAndNonWebTargets() {
        val p = page()
        assertFalse(RemoteWebNavigationPolicy.allows("https://user:pw@example.com/", p))
        assertFalse(RemoteWebNavigationPolicy.allows("javascript:alert(1)", p))
        assertFalse(RemoteWebNavigationPolicy.allows("mailto:a@example.com", p))
        assertFalse(RemoteWebNavigationPolicy.allows("intent://example.com/#Intent;end", p))
        assertFalse(RemoteWebNavigationPolicy.allows("file:///sdcard/x.html", p))
        assertFalse(RemoteWebNavigationPolicy.allows("about:blank", p))
        assertFalse(RemoteWebNavigationPolicy.allows("not a url", p))
        assertFalse(RemoteWebNavigationPolicy.allows(null, p))
    }

    @Test fun httpIsAllowedOnlyForAnHttpPage() {
        assertFalse(RemoteWebNavigationPolicy.allows("http://example.com/a", page()))
        val http = page(url = "http://example.com/a")
        assertTrue(RemoteWebNavigationPolicy.allows("http://example.com/b", http))
        assertTrue(RemoteWebNavigationPolicy.allows("https://example.com/b", http))
        assertFalse(RemoteWebNavigationPolicy.allows("http://example.com:8080/b", http))
    }

    @Test fun namesTheBlockedHostWithoutTheRestOfTheUrl() {
        assertEquals("evil.example.org", RemoteWebNavigationPolicy.blockedHost("https://evil.example.org/path?token=1"))
        assertNull(RemoteWebNavigationPolicy.blockedHost("javascript:alert(1)"))
        assertNull(RemoteWebNavigationPolicy.blockedHost(null))
    }

    @Test fun mapsLoadErrorsToStableTokens() {
        assertEquals("dns_failure", RemoteWebFailure.forLoadError(-2))
        assertEquals("connection_failure", RemoteWebFailure.forLoadError(-6))
        assertEquals("load_timeout", RemoteWebFailure.forLoadError(-8))
        assertEquals("tls_failure", RemoteWebFailure.forLoadError(-11))
        assertEquals("unsupported_scheme", RemoteWebFailure.forLoadError(-10))
        assertEquals("unknown_webview_error", RemoteWebFailure.forLoadError(-1))
        assertFalse(RemoteWebFailure.isMainFrameHttpFailure(304))
        assertTrue(RemoteWebFailure.isMainFrameHttpFailure(404))
    }

    @Test fun parsesBackgroundColors() {
        assertEquals(0xFF112233.toInt(), RemoteWebColor.parse("#112233"))
        // The runtime sends alpha last (#RRGGBBAA); Android wants it first.
        assertEquals(0x80112233.toInt(), RemoteWebColor.parse("#11223380"))
        assertNull(RemoteWebColor.parse("112233"))
        assertNull(RemoteWebColor.parse("#123"))
        assertNull(RemoteWebColor.parse("red"))
        assertNull(RemoteWebColor.parse(""))
    }

    @Test fun oneHundredPercentUsesExplicitCanvasPixelsInsteadOfAutomaticDensityScaling() {
        // The DEXP regression was 100% -> 0 (automatic 2x on a 320-dpi TV).
        assertEquals(100, RemoteWebZoom.initialScale(100))
    }

    @Test fun configuredWebsiteZoomMatchesTheLegacyPlayer() {
        // 150% must stay 150%, rather than becoming 300% on the same TV.
        for (percent in listOf(25, 50, 150, 200, 400)) {
            assertEquals(percent, RemoteWebZoom.initialScale(percent))
        }
    }
}
