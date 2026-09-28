package org.tilecast.player.runtime

import org.tilecast.player.content.PreparedContent
import org.tilecast.player.network.ManifestItem
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

    fun useSharedRuntime(content: PreparedContent, items: List<ManifestItem>): Boolean {
        if (!enabled) return false
        val manifest = content.manifest
        if (manifest.layout != null) return false
        if (items.isEmpty()) return false
        return items.all { item ->
            if (!RuntimePresentationBuilder.isRuntimeRenderable(manifest, item)) return@all false
            val variantId = item.variantId ?: return@all true
            val isMedia = manifest.assets.any { it.variantId == variantId }
            // tcmedia: has deliberately no authenticated network fallback.
            // A stream-policy or uncached automatic asset stays on legacy
            // playback, which can fetch it from the server.
            !isMedia || content.localFiles.containsKey(variantId)
        }
    }
}

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
) {
    private var activationId: String = activationId
    private var assetByItem: Map<String, String> = items.associate { it.id to it.assetId }
    private val framed = HashSet<String>()

    fun replace(items: List<ManifestItem>, activationId: String) {
        this.activationId = activationId
        assetByItem = items.associate { it.id to it.assetId }
        framed.clear()
    }

    fun handle(report: RuntimeReport, reportActivationId: String?): Boolean {
        if (report !is RuntimeReport.Ready && reportActivationId != activationId) return false
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
            "item-transition" -> {
                onProgress()
                if (itemId != null) onItemTransition(itemId)
            }
            "widget-alive", "layout-alive", "website-alive", "widget-empty" -> onProgress()
        }
    }
}
