package org.tilecast.player.runtime

import org.tilecast.player.content.WebsitePlaybackStatus
import org.tilecast.player.content.WidgetPlaybackStatus
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.runtime.RuntimeBridgeProtocol.RuntimeReport

/** Translates shared-runtime reports into the existing native reporting pipeline.
 *
 * The host keeps networking, evidence, and status reporting; the runtime only
 * describes what it presented. Reports from a replaced activation are dropped.
 */
class RuntimeEvidenceRouter(
    items: List<ManifestItem>,
    activationId: String,
    private val onBoundary: (itemId: String, assetId: String) -> Unit,
    private val onError: (String) -> Unit,
    private val onProgress: () -> Unit,
    private val onFirstFrame: (itemId: String) -> Unit = {},
    private val onItemTransition: (itemId: String) -> Unit = {},
    private val onPlaybackError: (itemId: String?, message: String) -> Unit = { _, _ -> },
    private val onWidgetStatus: (WidgetPlaybackStatus) -> Unit = {},
    private val onWebsiteStatus: (WebsitePlaybackStatus) -> Unit = {},
    widgetProviders: Map<String, String> = emptyMap(),
    websiteAssets: Set<String> = emptySet(),
) {
    private var activationId: String = activationId
    private var assetByItem: Map<String, String> = items.associate { it.id to it.assetId }
    private var widgetProviders: Map<String, String> = widgetProviders
    private var websiteAssets: Set<String> = websiteAssets
    private val framed = HashSet<String>()

    fun replace(
        items: List<ManifestItem>,
        activationId: String,
        widgetProviders: Map<String, String> = this.widgetProviders,
        websiteAssets: Set<String> = this.websiteAssets,
    ) {
        // A replaced activation disposes the previous presentation: drop
        // its Widget/Website status like the native renderers did on
        // dispose, so a later item cannot inherit a stale widgetId (which
        // would also keep the foreground watchdog disabled).
        val activationChanged = activationId != this.activationId
        this.activationId = activationId
        assetByItem = items.associate { it.id to it.assetId }
        this.widgetProviders = widgetProviders
        this.websiteAssets = websiteAssets
        framed.clear()
        if (activationChanged) {
            onWidgetStatus(WidgetPlaybackStatus())
            onWebsiteStatus(WebsitePlaybackStatus())
        }
    }

    fun handle(report: RuntimeReport, reportActivationId: String?): Boolean {
        if (report !is RuntimeReport.Ready && reportActivationId != activationId) return false
        when (report) {
            is RuntimeReport.Ready -> Unit
            is RuntimeReport.PresentationResult -> {
                if (report.outcome == "rejected") onError("shared presentation rejected")
            }
            is RuntimeReport.Evidence -> handleEvidence(report)
            is RuntimeReport.PlaybackError -> {
                onPlaybackError(report.itemId, report.message)
                publishItemError(report.itemId, report.message)
                onError(report.message)
            }
        }
        return true
    }

    private fun handleEvidence(report: RuntimeReport.Evidence) {
        val itemId = report.itemId
        when (report.kind) {
            "item-started" -> {
                // A new item displaces the previous one: clear statuses the
                // starting item cannot own, so a Widget played earlier does
                // not linger (and suppress the watchdog) through later
                // image/video/layout items.
                val asset = itemId?.let(assetByItem::get)
                if (asset == null || asset !in widgetProviders) onWidgetStatus(WidgetPlaybackStatus())
                if (asset == null || asset !in websiteAssets) onWebsiteStatus(WebsitePlaybackStatus())
                if (itemId != null) onBoundary(itemId, asset ?: "")
            }
            "image-shown", "video-progress", "widget-shown", "layout-shown",
            "website-loaded", "surface-shown" -> {
                onProgress()
                if (itemId != null) {
                    publishItemShown(report.kind, itemId)
                    if (framed.add(itemId)) onFirstFrame(itemId)
                }
            }
            "item-transition" -> {
                onProgress()
                if (itemId != null) onItemTransition(itemId)
            }
            "widget-alive", "layout-alive", "website-alive", "widget-empty" -> onProgress()
        }
    }

    private fun assetOf(itemId: String): String? = assetByItem[itemId]?.takeIf { it.isNotBlank() }

    private fun publishItemShown(kind: String, itemId: String) {
        val asset = assetOf(itemId) ?: return
        when (kind) {
            "widget-shown" -> onWidgetStatus(
                WidgetPlaybackStatus(asset, widgetProviders[asset] ?: "runtime", "shown"),
            )
            "website-loaded" -> onWebsiteStatus(WebsitePlaybackStatus(asset, "loaded"))
        }
    }

    private fun publishItemError(itemId: String?, message: String) {
        val asset = itemId?.let(::assetOf) ?: return
        if (asset in widgetProviders) {
            onWidgetStatus(WidgetPlaybackStatus(asset, widgetProviders[asset], "error", message))
        } else if (asset in websiteAssets) {
            onWebsiteStatus(WebsitePlaybackStatus(asset, "failed", failureCategory = message))
        }
    }
}
