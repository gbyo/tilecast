package org.tilecast.player.reliability

import android.provider.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MaintenanceSettingsTest {
    @Test
    fun allowedPolicyOffersEveryMaintenanceSettingsScreen() {
        assertEquals(maintenanceSettingsActions, permittedMaintenanceSettings(true))
        assertTrue(isMaintenanceSettingsLaunchAllowed(Settings.ACTION_SETTINGS, true))
    }

    @Test
    fun disabledPolicyOffersNoSettingsAndRefusesLaunch() {
        assertTrue(permittedMaintenanceSettings(false).isEmpty())
        maintenanceSettingsActions.forEach { assertFalse(isMaintenanceSettingsLaunchAllowed(it, false)) }
    }
}
