package org.tilecast.player.runtime

import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.PlayerManifest
import org.tilecast.player.runtime.RuntimeBridgeProtocol.RuntimeReport

/** Feature gate for the shared-runtime presentation cutover.
 *
 * PR2 routes a playlist to the runtime only when every item is renderable
 * there; widget/Layout-majority playlists stay on the legacy Compose stack
 * until the PR3 deletion gate passes. Emulator/hardware validation flips
 * [enabled] once the runtime proves itself on device.
 */
object RuntimeCutover {
    @Volatile
    var enabled: Boolean = false

    fun useSharedRuntime(manifest: PlayerManifest, items: List<ManifestItem>): Boolean {
        if (!enabled) return false
        if (manifest.layout != null) return false
        if (items.isEmpty()) return false
        return items.all { RuntimePresentationBuilder.isRuntimeRenderable(manifest, it) }
    }
}

/** Translates shared-runtime reports into the existing native reporting pipeline.
 *
 * The host keeps networking, evidence, and status reporting; the runtime only
 * describes what it presented. Reports from a replaced activation are dropped.
 */
class RuntimeEvidenceRouter(
    items: List<ManifestItem>,
    private val activationId: String,
    private val onBoundary: (itemId: String, assetId: String) -> Unit,
    private val onError: (String) -> Unit,
    private val onProgress: () -> Unit,
    private val onFirstFrame: (itemId: String) -> Unit = {},
) {
    private val assetByItem: Map<String, String> = items.associate { it.id to it.assetId }
    private val framed = HashSet<String>()

    fun handle(report: RuntimeReport, reportActivationId: String?): Boolean {
        if (reportActivationId != null && reportActivationId != activationId) return false
        when (report) {
            is RuntimeReport.Ready -> Unit
            is RuntimeReport.PresentationResult -> {
                if (report.outcome == "rejected") onError("shared presentation rejected")
            }
            is RuntimeReport.Evidence -> handleEvidence(report)
            is RuntimeReport.PlaybackError -> onError(report.message)
        }
        return true
    }

    private fun handleEvidence(report: RuntimeReport.Evidence) {
        val itemId = report.itemId
        when (report.kind) {
            "item-started" -> {
                if (itemId != null) onBoundary(itemId, assetByItem[itemId] ?: "")
            }
            "image-shown", "video-progress", "widget-shown", "layout-shown",
            "website-loaded", "surface-shown" -> {
                onProgress()
                if (itemId != null && framed.add(itemId)) onFirstFrame(itemId)
            }
            "widget-alive", "layout-alive", "website-alive", "widget-empty", "item-transition" -> onProgress()
        }
    }
}
