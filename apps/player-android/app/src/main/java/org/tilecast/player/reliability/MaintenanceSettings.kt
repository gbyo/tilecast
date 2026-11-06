package org.tilecast.player.reliability

import android.provider.Settings

/** Android Settings screens the maintenance menu can open. */
val maintenanceSettingsActions = listOf(
    Settings.ACTION_ACCESSIBILITY_SETTINGS,
    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
    Settings.ACTION_SETTINGS,
)

/** Applies the managed kiosk "allow Settings during maintenance" policy. */
fun permittedMaintenanceSettings(allowSettingsDuringAdmin: Boolean): List<String> =
    if (allowSettingsDuringAdmin) maintenanceSettingsActions else emptyList()

fun isMaintenanceSettingsLaunchAllowed(action: String, allowSettingsDuringAdmin: Boolean): Boolean =
    action in permittedMaintenanceSettings(allowSettingsDuringAdmin)
