package org.tilecast.player.reliability

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayBlockingPolicyTest {
    @Test
    fun managedKioskWithBlockingEnabledHidesOverlays() {
        assertTrue(shouldHideOverlayWindows("managed_kiosk", true))
    }

    @Test
    fun disabledPolicyOrStandardModeLeavesOverlaysAlone() {
        assertFalse(shouldHideOverlayWindows("managed_kiosk", false))
        assertFalse(shouldHideOverlayWindows("standard", true))
    }
}
