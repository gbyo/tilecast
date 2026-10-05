package org.tilecast.player.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The accepted player configuration split by its behavioral owner, as
 * the native host's `effective_config` reports it. Lenient by design:
 * anything missing or unparseable falls back to the native defaults,
 * never an exception. A null [revision] means nothing was accepted yet.
 */
data class CorePlayerConfig(
    val revision: Long?,
    val runtime: CoreRuntimeConfig = CoreRuntimeConfig(),
    val platform: CorePlatformConfig = CorePlatformConfig(),
) {
    companion object {
        fun parse(payload: String?): CorePlayerConfig {
            if (payload == null) return CorePlayerConfig(null)
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                if (root["ok"]?.jsonPrimitive?.booleanOrNull != true) return CorePlayerConfig(null)
                CorePlayerConfig(
                    revision = root["revision"]?.jsonPrimitive?.longOrNull,
                    runtime = CoreRuntimeConfig.parse(root.objOrNull("runtime")),
                    platform = CorePlatformConfig.parse(root.objOrNull("platform")),
                )
            } catch (_: Exception) {
                CorePlayerConfig(null)
            }
        }
    }
}

data class CoreRuntimeConfig(
    val branding: CoreBranding = CoreBranding(),
    val playback: CorePlaybackUi = CorePlaybackUi(),
    val power: CorePowerDisplay = CorePowerDisplay(),
    val website: CoreWebsiteUi = CoreWebsiteUi(),
) {
    companion object {
        fun parse(root: JsonObject?): CoreRuntimeConfig {
            root ?: return CoreRuntimeConfig()
            return try {
                CoreRuntimeConfig(
                    branding = CoreBranding.parse(root.objOrNull("branding")),
                    playback = CorePlaybackUi.parse(root.objOrNull("playback")),
                    power = CorePowerDisplay.parse(root.objOrNull("power")),
                    website = CoreWebsiteUi.parse(root.objOrNull("website")),
                )
            } catch (_: Exception) {
                CoreRuntimeConfig()
            }
        }
    }
}

data class CoreBranding(
    val organizationName: String = "Tilecast",
    val logoAssetId: String? = null,
    val backgroundColor: String? = null,
    val textColor: String? = null,
    val noContentTitle: String? = null,
    val noContentMessage: String? = null,
    val disabledTitle: String? = null,
    val disabledMessage: String? = null,
    val footerText: String? = null,
) {
    companion object {
        fun parse(root: JsonObject?): CoreBranding {
            root ?: return CoreBranding()
            return try {
                CoreBranding(
                    organizationName = root.strOrNull("organizationName") ?: "Tilecast",
                    logoAssetId = root.strOrNull("logoAssetId"),
                    backgroundColor = root.strOrNull("backgroundColor"),
                    textColor = root.strOrNull("textColor"),
                    noContentTitle = root.strOrNull("noContentTitle"),
                    noContentMessage = root.strOrNull("noContentMessage"),
                    disabledTitle = root.strOrNull("disabledTitle"),
                    disabledMessage = root.strOrNull("disabledMessage"),
                    footerText = root.strOrNull("footerText"),
                )
            } catch (_: Exception) {
                CoreBranding()
            }
        }
    }
}

/** The playback values the native UI reads; item defaults stay native. */
data class CorePlaybackUi(
    val identifyShowsLocation: Boolean = true,
    val screenLocation: String = "",
    val resumeAfterRestart: Boolean = true,
) {
    companion object {
        fun parse(root: JsonObject?): CorePlaybackUi {
            root ?: return CorePlaybackUi()
            return try {
                CorePlaybackUi(
                    identifyShowsLocation = root["identifyShowsLocation"]?.jsonPrimitive?.booleanOrNull ?: true,
                    screenLocation = root.strOrNull("screenLocation") ?: "",
                    resumeAfterRestart = root["resumeAfterRestart"]?.jsonPrimitive?.booleanOrNull ?: true,
                )
            } catch (_: Exception) {
                CorePlaybackUi()
            }
        }
    }
}

data class CorePowerDisplay(
    val outsideDisplay: String = "black",
    val outsideText: String = "Powered by Tilecast",
) {
    companion object {
        fun parse(root: JsonObject?): CorePowerDisplay {
            root ?: return CorePowerDisplay()
            return try {
                CorePowerDisplay(
                    outsideDisplay = root.strOrNull("outsideDisplay") ?: "black",
                    outsideText = root.strOrNull("outsideText") ?: "Powered by Tilecast",
                )
            } catch (_: Exception) {
                CorePowerDisplay()
            }
        }
    }
}

/** The website values the native UI reads; page policy stays native. */
data class CoreWebsiteUi(
    val clearOnRestart: Boolean = false,
) {
    companion object {
        fun parse(root: JsonObject?): CoreWebsiteUi {
            root ?: return CoreWebsiteUi()
            return try {
                CoreWebsiteUi(
                    clearOnRestart = root["clearOnRestart"]?.jsonPrimitive?.booleanOrNull == true,
                )
            } catch (_: Exception) {
                CoreWebsiteUi()
            }
        }
    }
}

data class CorePlatformConfig(
    val reliability: CoreReliabilityAndroid = CoreReliabilityAndroid(),
    val power: CorePowerAndroid = CorePowerAndroid(),
    val managedKiosk: CoreManagedKiosk = CoreManagedKiosk(),
    val accessibility: CoreAccessibility = CoreAccessibility(),
    val updates: CoreUpdates = CoreUpdates(),
    val downloads: CoreDownloads = CoreDownloads(),
) {
    companion object {
        fun parse(root: JsonObject?): CorePlatformConfig {
            root ?: return CorePlatformConfig()
            return try {
                CorePlatformConfig(
                    reliability = CoreReliabilityAndroid.parse(root.objOrNull("reliability")),
                    power = CorePowerAndroid.parse(root.objOrNull("power")),
                    managedKiosk = CoreManagedKiosk.parse(root.objOrNull("managedKiosk")),
                    accessibility = CoreAccessibility.parse(root.objOrNull("accessibility")),
                    updates = CoreUpdates.parse(root.objOrNull("updates")),
                    downloads = CoreDownloads.parse(root.objOrNull("downloads")),
                )
            } catch (_: Exception) {
                CorePlatformConfig()
            }
        }
    }
}

data class CoreReliabilityAndroid(
    val mode: String = "standard",
    val launchAfterBoot: Boolean = true,
    val immersiveMode: Boolean = true,
    val foregroundWatchdogEnabled: Boolean = true,
    val webviewStallSeconds: Long = 45,
) {
    companion object {
        fun parse(root: JsonObject?): CoreReliabilityAndroid {
            root ?: return CoreReliabilityAndroid()
            return try {
                CoreReliabilityAndroid(
                    mode = root.strOrNull("mode") ?: "standard",
                    launchAfterBoot = root["launchAfterBoot"]?.jsonPrimitive?.booleanOrNull ?: true,
                    immersiveMode = root["immersiveMode"]?.jsonPrimitive?.booleanOrNull ?: true,
                    foregroundWatchdogEnabled = root["foregroundWatchdogEnabled"]?.jsonPrimitive?.booleanOrNull ?: true,
                    webviewStallSeconds = root["webviewStallSeconds"]?.jsonPrimitive?.longOrNull ?: 45,
                )
            } catch (_: Exception) {
                CoreReliabilityAndroid()
            }
        }
    }
}

data class CorePowerAndroid(
    val keepScreenOn: Boolean = true,
    val sleepOutsideActiveHours: Boolean = false,
    val startupGraceSeconds: Long = 30,
    val shutdownPrepareSeconds: Long = 60,
) {
    companion object {
        fun parse(root: JsonObject?): CorePowerAndroid {
            root ?: return CorePowerAndroid()
            return try {
                CorePowerAndroid(
                    keepScreenOn = root["keepScreenOn"]?.jsonPrimitive?.booleanOrNull ?: true,
                    sleepOutsideActiveHours = root["sleepOutsideActiveHours"]?.jsonPrimitive?.booleanOrNull == true,
                    startupGraceSeconds = root["startupGraceSeconds"]?.jsonPrimitive?.longOrNull ?: 30,
                    shutdownPrepareSeconds = root["shutdownPrepareSeconds"]?.jsonPrimitive?.longOrNull ?: 60,
                )
            } catch (_: Exception) {
                CorePowerAndroid()
            }
        }
    }
}

data class CoreManagedKiosk(
    val lockTaskEnabled: Boolean = false,
    val blockOverlays: Boolean = true,
    val allowSettingsDuringAdmin: Boolean = true,
    val adminSessionMinutes: Long = 15,
) {
    companion object {
        fun parse(root: JsonObject?): CoreManagedKiosk {
            root ?: return CoreManagedKiosk()
            return try {
                CoreManagedKiosk(
                    lockTaskEnabled = root["lockTaskEnabled"]?.jsonPrimitive?.booleanOrNull == true,
                    blockOverlays = root["blockOverlays"]?.jsonPrimitive?.booleanOrNull ?: true,
                    allowSettingsDuringAdmin = root["allowSettingsDuringAdmin"]?.jsonPrimitive?.booleanOrNull ?: true,
                    adminSessionMinutes = root["adminSessionMinutes"]?.jsonPrimitive?.longOrNull ?: 15,
                )
            } catch (_: Exception) {
                CoreManagedKiosk()
            }
        }
    }
}

data class CoreAccessibility(
    val controlAssistEnabled: Boolean = true,
    val returnDelaySeconds: Long = 10,
    val allowedPackages: List<String> = emptyList(),
    val pauseDuringUpdates: Boolean = true,
    val pauseDuringAdminSession: Boolean = true,
    val reportForegroundPackage: Boolean = false,
    val maximumReturns: Long = 3,
    val returnWindowMinutes: Long = 10,
) {
    companion object {
        fun parse(root: JsonObject?): CoreAccessibility {
            root ?: return CoreAccessibility()
            return try {
                CoreAccessibility(
                    controlAssistEnabled = root["controlAssistEnabled"]?.jsonPrimitive?.booleanOrNull ?: true,
                    returnDelaySeconds = root["returnDelaySeconds"]?.jsonPrimitive?.longOrNull ?: 10,
                    allowedPackages = runCatching {
                        (root["allowedPackages"] as? kotlinx.serialization.json.JsonArray)
                            ?.mapNotNull { entry -> entry.jsonPrimitive.contentOrNull }
                            ?: emptyList()
                    }.getOrDefault(emptyList()),
                    pauseDuringUpdates = root["pauseDuringUpdates"]?.jsonPrimitive?.booleanOrNull ?: true,
                    pauseDuringAdminSession = root["pauseDuringAdminSession"]?.jsonPrimitive?.booleanOrNull ?: true,
                    reportForegroundPackage = root["reportForegroundPackage"]?.jsonPrimitive?.booleanOrNull == true,
                    maximumReturns = root["maximumReturns"]?.jsonPrimitive?.longOrNull ?: 3,
                    returnWindowMinutes = root["returnWindowMinutes"]?.jsonPrimitive?.longOrNull ?: 10,
                )
            } catch (_: Exception) {
                CoreAccessibility()
            }
        }
    }
}

data class CoreUpdates(
    val channel: String = "stable",
) {
    companion object {
        fun parse(root: JsonObject?): CoreUpdates {
            root ?: return CoreUpdates()
            return try {
                CoreUpdates(channel = root.strOrNull("channel") ?: "stable")
            } catch (_: Exception) {
                CoreUpdates()
            }
        }
    }
}

data class CoreDownloads(
    val concurrentDownloads: Long = 2,
    val automaticThresholdBytes: Long = 256 * 1024 * 1024,
) {
    companion object {
        fun parse(root: JsonObject?): CoreDownloads {
            root ?: return CoreDownloads()
            return try {
                CoreDownloads(
                    concurrentDownloads = root["concurrentDownloads"]?.jsonPrimitive?.longOrNull ?: 2,
                    automaticThresholdBytes = root["automaticThresholdBytes"]?.jsonPrimitive?.longOrNull
                        ?: (256 * 1024 * 1024),
                )
            } catch (_: Exception) {
                CoreDownloads()
            }
        }
    }
}

private fun JsonObject.strOrNull(key: String): String? {
    return try {
        this[key]?.jsonPrimitive?.contentOrNull
    } catch (_: Exception) {
        null
    }
}

private fun JsonObject.objOrNull(key: String): JsonObject? {
    return try {
        this[key]?.jsonObject
    } catch (_: Exception) {
        null
    }
}
