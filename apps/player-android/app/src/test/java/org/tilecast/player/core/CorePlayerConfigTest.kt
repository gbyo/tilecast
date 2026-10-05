package org.tilecast.player.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CorePlayerConfigTest {
    @Test fun parseIsLenient() {
        assertEquals(CorePlayerConfig(null), CorePlayerConfig.parse(null))
        assertEquals(CorePlayerConfig(null), CorePlayerConfig.parse("nope"))
        assertEquals(CorePlayerConfig(null), CorePlayerConfig.parse("""{"ok":false}"""))
        val empty = CorePlayerConfig.parse("""{"ok":true,"revision":null}""")
        assertEquals(null, empty.revision)
        assertEquals("Tilecast", empty.runtime.branding.organizationName)
        assertEquals("stable", empty.platform.updates.channel)
    }

    @Test fun parseReadsRuntimeAndPlatform() {
        val config = CorePlayerConfig.parse(
            """{"ok":true,"revision":9,"runtime":{"branding":{"organizationName":"Acme","backgroundColor":"#112233","footerText":"Hi"},"playback":{"identifyShowsLocation":false,"screenLocation":"Lobby"},"power":{"outsideDisplay":"custom_text","outsideText":"Closed"},"website":{"clearOnRestart":true}},"platform":{"reliability":{"mode":"managed_kiosk","launchAfterBoot":false},"power":{"keepScreenOn":false,"sleepOutsideActiveHours":true,"startupGraceSeconds":45},"managedKiosk":{"lockTaskEnabled":true},"accessibility":{"controlAssistEnabled":false,"allowedPackages":["com.example"],"maximumReturns":5},"updates":{"channel":"beta"},"downloads":{"concurrentDownloads":4}}}""",
        )
        assertEquals(9L, config.revision)
        assertEquals("Acme", config.runtime.branding.organizationName)
        assertEquals("#112233", config.runtime.branding.backgroundColor)
        assertEquals("Hi", config.runtime.branding.footerText)
        assertFalse(config.runtime.playback.identifyShowsLocation)
        assertEquals("Lobby", config.runtime.playback.screenLocation)
        assertEquals("custom_text", config.runtime.power.outsideDisplay)
        assertEquals("Closed", config.runtime.power.outsideText)
        assertTrue(config.runtime.website.clearOnRestart)
        assertEquals("managed_kiosk", config.platform.reliability.mode)
        assertFalse(config.platform.reliability.launchAfterBoot)
        assertFalse(config.platform.power.keepScreenOn)
        assertTrue(config.platform.power.sleepOutsideActiveHours)
        assertEquals(45L, config.platform.power.startupGraceSeconds)
        assertTrue(config.platform.managedKiosk.lockTaskEnabled)
        assertFalse(config.platform.accessibility.controlAssistEnabled)
        assertEquals(listOf("com.example"), config.platform.accessibility.allowedPackages)
        assertEquals(5L, config.platform.accessibility.maximumReturns)
        assertEquals("beta", config.platform.updates.channel)
        assertEquals(4L, config.platform.downloads.concurrentDownloads)
    }

    @Test fun parseFallsBackPerSection() {
        val config = CorePlayerConfig.parse(
            """{"ok":true,"revision":3,"runtime":{"branding":42},"platform":{"power":{"keepScreenOn":"maybe"}}}""",
        )
        assertEquals(3L, config.revision)
        assertEquals("Tilecast", config.runtime.branding.organizationName)
        assertEquals(true, config.platform.power.keepScreenOn)
    }
}
