package org.tilecast.player.content

import org.junit.Assert.assertEquals
import org.junit.Test
import org.tilecast.player.network.ManifestWebsite
import org.tilecast.player.network.PlayerWebsitePolicy
import org.tilecast.player.runtime.resolveWebsitePolicy

class WebsitePolicyTest {
    private val site = ManifestWebsite(
        assetId = "website",
        name = "Status",
        url = "https://example.com",
        allowedHosts = listOf("example.com"),
        javascriptEnabled = true,
        domStorageEnabled = true,
        cookiePolicy = "first_and_third_party",
        reloadPolicy = "interval",
        refreshIntervalSeconds = 120,
        loadTimeoutSeconds = 60,
        zoomPercent = 125,
        scrollX = 0,
        scrollY = 0,
        failureBehavior = "fallback_image",
    )

    @Test
    fun operationalTimeoutAndCookiePolicyOverrideManifest() {
        val resolved = resolveWebsitePolicy(
            site,
            PlayerWebsitePolicy(
                timeoutSeconds = 12,
                cookiePolicy = "disabled",
                minimumRefreshSeconds = 30,
            ),
        )

        assertEquals(12, resolved.loadTimeoutSeconds)
        assertEquals("disabled", resolved.cookiePolicy)
        assertEquals("interval", resolved.reloadPolicy)
        assertEquals(120, resolved.refreshIntervalSeconds)
    }

    @Test
    fun organizationDefaultsFillLegacyMissingWebsiteFields() {
        val resolved = resolveWebsitePolicy(
            site.copy(
                cookiePolicy = "",
                reloadPolicy = "",
                loadTimeoutSeconds = 0,
                zoomPercent = 0,
                failureBehavior = "",
            ),
            PlayerWebsitePolicy(
                timeoutSeconds = 20,
                cookiePolicy = "first_party",
                defaultReloadPolicy = "on_each_activation",
                defaultFailureBehavior = "placeholder",
                defaultZoomPercent = 100,
            ),
        )

        assertEquals(20, resolved.loadTimeoutSeconds)
        assertEquals("first_party", resolved.cookiePolicy)
        assertEquals("on_each_activation", resolved.reloadPolicy)
        assertEquals("placeholder", resolved.failureBehavior)
        assertEquals(100, resolved.zoomPercent)
    }
}
